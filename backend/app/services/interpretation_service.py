"""
AI-assisted interpretation of well-log curves over a depth range.

Sends ACTUAL curve data (sampled) to the AI so interpretation is data-driven.
Uses Google Gemini when GEMINI_API_KEY is set (tries multiple models);
falls back to a comprehensive rule-based analysis engine.
"""

import math
import os
import statistics
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models.schema import Curve, CurveSample

# ── Well-log curve classification ────────────────────────────────────
# Maps common mnemonics / substrings to human-readable types.
CURVE_TYPE_MAP = {
    "GR": "Gamma Ray",
    "GAMMA": "Gamma Ray",
    "SGR": "Spectral Gamma Ray",
    "SP": "Spontaneous Potential",
    "CALI": "Caliper",
    "CAL": "Caliper",
    "BS": "Bit Size",
    "RHOB": "Bulk Density",
    "RHOZ": "Bulk Density",
    "DPHI": "Density Porosity",
    "NPHI": "Neutron Porosity",
    "TNPH": "Neutron Porosity",
    "NPOR": "Neutron Porosity",
    "DT": "Sonic (Compressional)",
    "DTC": "Sonic (Compressional)",
    "DTS": "Sonic (Shear)",
    "DTCO": "Sonic (Compressional)",
    "ILD": "Deep Resistivity",
    "ILM": "Medium Resistivity",
    "MSFL": "Shallow Resistivity",
    "LLD": "Deep Resistivity",
    "LLS": "Shallow Resistivity",
    "RT": "True Resistivity",
    "RXO": "Flushed Zone Resistivity",
    "RESD": "Deep Resistivity",
    "RESM": "Medium Resistivity",
    "RESS": "Shallow Resistivity",
    "AT10": "Resistivity (10 in)",
    "AT20": "Resistivity (20 in)",
    "AT30": "Resistivity (30 in)",
    "AT60": "Resistivity (60 in)",
    "AT90": "Resistivity (90 in)",
    "PEF": "Photoelectric Factor",
    "PE": "Photoelectric Factor",
    "DRHO": "Density Correction",
}


def _classify_curve(name: str) -> str:
    """Return a human-readable curve type based on mnemonic."""
    upper = name.upper().strip()
    for key, label in CURVE_TYPE_MAP.items():
        if key == upper or upper.startswith(key):
            return label
    return name


# ── Database helpers ─────────────────────────────────────────────────

def _compute_curve_stats(
    db: Session, curve_id: int, depth_start: float, depth_end: float
) -> Optional[dict]:
    row = (
        db.query(
            func.min(CurveSample.value).label("min_v"),
            func.max(CurveSample.value).label("max_v"),
            func.avg(CurveSample.value).label("mean_v"),
            func.count(CurveSample.id).label("count"),
        )
        .filter(
            CurveSample.curve_id == curve_id,
            CurveSample.depth >= depth_start,
            CurveSample.depth <= depth_end,
            CurveSample.value.isnot(None),
        )
        .first()
    )
    if not row or row.count == 0:
        return None
    return {
        "min": round(float(row.min_v), 4),
        "max": round(float(row.max_v), 4),
        "mean": round(float(row.mean_v), 4),
        "count": row.count,
    }


def _get_curve_samples(
    db: Session,
    curve_id: int,
    depth_start: float,
    depth_end: float,
    max_points: int = 100,
) -> list[dict]:
    all_samples = (
        db.query(CurveSample.depth, CurveSample.value)
        .filter(
            CurveSample.curve_id == curve_id,
            CurveSample.depth >= depth_start,
            CurveSample.depth <= depth_end,
            CurveSample.value.isnot(None),
        )
        .order_by(CurveSample.depth)
        .all()
    )
    if not all_samples:
        return []

    total = len(all_samples)
    step = max(total / max_points, 1)
    result = []
    for i in range(min(max_points, total)):
        idx = min(int(i * step), total - 1)
        s = all_samples[idx]
        val = float(s.value) if s.value is not None else None
        if val is not None and (math.isnan(val) or math.isinf(val)):
            val = None
        result.append({
            "depth": round(float(s.depth), 2),
            "value": round(val, 4) if val is not None else None,
        })
    return result


# ── Data analysis helpers ────────────────────────────────────────────

def _values(samples: list[dict]) -> list[float]:
    """Extract non-None values from samples."""
    return [s["value"] for s in samples if s["value"] is not None]


def _segment_avg(vals: list[float], start_frac: float, end_frac: float) -> Optional[float]:
    n = len(vals)
    if n == 0:
        return None
    i = int(n * start_frac)
    j = max(int(n * end_frac), i + 1)
    seg = vals[i:j]
    return sum(seg) / len(seg) if seg else None


def _detect_trend(samples: list[dict]) -> dict:
    """Detect overall trend, segmented trends (quarters)."""
    vals = _values(samples)
    if len(vals) < 4:
        return {"direction": "insufficient data", "segments": []}

    q_size = len(vals) // 4
    quarters = []
    for qi in range(4):
        seg = vals[qi * q_size : (qi + 1) * q_size] if qi < 3 else vals[qi * q_size:]
        if seg:
            quarters.append(round(sum(seg) / len(seg), 4))
        else:
            quarters.append(None)

    first = quarters[0]
    last = quarters[-1]
    if first is None or last is None or first == 0:
        direction = "stable"
    elif last > first * 1.15:
        direction = "increasing"
    elif last < first * 0.85:
        direction = "decreasing"
    else:
        direction = "stable"

    return {"direction": direction, "quarter_avgs": quarters}


def _detect_anomalies(samples: list[dict], name: str) -> list[dict]:
    """Find sharp spikes or drops (>2 std dev from local window)."""
    vals = _values(samples)
    if len(vals) < 10:
        return []

    mean_v = statistics.mean(vals)
    std_v = statistics.stdev(vals) if len(vals) > 1 else 0
    if std_v == 0:
        return []

    anomalies = []
    threshold = 2.0  # standard deviations
    for s in samples:
        if s["value"] is None:
            continue
        z = abs(s["value"] - mean_v) / std_v
        if z >= threshold:
            anomalies.append({
                "depth": s["depth"],
                "value": s["value"],
                "z_score": round(z, 2),
                "type": "spike" if s["value"] > mean_v else "drop",
            })
    return anomalies[:10]  # cap at 10


def _detect_zones(samples: list[dict], n_zones: int = 3) -> list[dict]:
    """Split depth range into n_zones and compute stats for each."""
    vals_with_depth = [(s["depth"], s["value"]) for s in samples if s["value"] is not None]
    if len(vals_with_depth) < n_zones:
        return []

    zone_size = len(vals_with_depth) // n_zones
    zones = []
    for zi in range(n_zones):
        start_idx = zi * zone_size
        end_idx = (zi + 1) * zone_size if zi < n_zones - 1 else len(vals_with_depth)
        seg = vals_with_depth[start_idx:end_idx]
        if not seg:
            continue
        seg_vals = [v for _, v in seg]
        zones.append({
            "zone": zi + 1,
            "depth_from": seg[0][0],
            "depth_to": seg[-1][0],
            "avg": round(statistics.mean(seg_vals), 4),
            "min": round(min(seg_vals), 4),
            "max": round(max(seg_vals), 4),
            "std": round(statistics.stdev(seg_vals), 4) if len(seg_vals) > 1 else 0,
        })
    return zones


def _detect_crossovers(curve_contexts: list[dict]) -> list[str]:
    """Detect interesting relationships between curve pairs."""
    findings = []
    names = {c["name"].upper(): c for c in curve_contexts}

    # Neutron-Density crossover (hydrocarbon indicator)
    nphi_key = next((k for k in names if k in ("NPHI", "TNPH", "NPOR")), None)
    dphi_key = next((k for k in names if k in ("DPHI", "RHOB", "RHOZ")), None)
    if nphi_key and dphi_key:
        nphi_vals = _values(names[nphi_key]["data_samples"])
        dphi_vals = _values(names[dphi_key]["data_samples"])
        if nphi_vals and dphi_vals:
            nphi_mean = statistics.mean(nphi_vals)
            dphi_mean = statistics.mean(dphi_vals)
            findings.append(
                f"Neutron ({nphi_key}) average: {nphi_mean:.4f}, "
                f"Density ({dphi_key}) average: {dphi_mean:.4f}. "
                f"{'Neutron > Density suggests gas effect or light hydrocarbons in this interval.' if nphi_mean > dphi_mean else 'Density >= Neutron is typical of water-bearing or shale zones.'}"
            )

    # Caliper vs Bit Size (washout detection)
    cal_key = next((k for k in names if k in ("CALI", "CAL")), None)
    bs_key = next((k for k in names if k in ("BS",)), None)
    if cal_key:
        cal_vals = _values(names[cal_key]["data_samples"])
        if cal_vals:
            cal_mean = statistics.mean(cal_vals)
            cal_max = max(cal_vals)
            cal_std = statistics.stdev(cal_vals) if len(cal_vals) > 1 else 0
            if bs_key:
                bs_vals = _values(names[bs_key]["data_samples"])
                if bs_vals:
                    bs_mean = statistics.mean(bs_vals)
                    if cal_mean > bs_mean * 1.1:
                        findings.append(
                            f"Caliper average ({cal_mean:.2f}) exceeds bit size ({bs_mean:.2f}), "
                            f"indicating borehole washout in this interval."
                        )
            elif cal_std / cal_mean > 0.1 if cal_mean > 0 else False:
                findings.append(
                    f"Caliper shows high variability (std={cal_std:.2f}, mean={cal_mean:.2f}), "
                    f"possible borehole instability."
                )

    # Resistivity separation (invasion profile)
    deep_key = next((k for k in names if k in ("ILD", "LLD", "RESD", "AT90", "AT60")), None)
    shallow_key = next((k for k in names if k in ("MSFL", "LLS", "RESS", "RXO", "AT10", "AT20")), None)
    if deep_key and shallow_key:
        deep_vals = _values(names[deep_key]["data_samples"])
        shallow_vals = _values(names[shallow_key]["data_samples"])
        if deep_vals and shallow_vals:
            deep_mean = statistics.mean(deep_vals)
            shallow_mean = statistics.mean(shallow_vals)
            if deep_mean > shallow_mean * 1.5:
                findings.append(
                    f"Deep resistivity ({deep_key}: {deep_mean:.2f}) > Shallow ({shallow_key}: {shallow_mean:.2f}) "
                    f"— positive separation may indicate hydrocarbon-bearing zone with water-based mud invasion."
                )
            elif shallow_mean > deep_mean * 1.5:
                findings.append(
                    f"Shallow resistivity ({shallow_key}: {shallow_mean:.2f}) > Deep ({deep_key}: {deep_mean:.2f}) "
                    f"— negative separation, typical of water-bearing zone."
                )

    # Gamma Ray lithology
    gr_key = next((k for k in names if k in ("GR", "SGR")), None)
    if gr_key:
        gr_vals = _values(names[gr_key]["data_samples"])
        if gr_vals:
            gr_mean = statistics.mean(gr_vals)
            gr_max_val = max(gr_vals)
            gr_min_val = min(gr_vals)
            if gr_mean > 100:
                findings.append(
                    f"Gamma Ray average ({gr_mean:.1f} {names[gr_key].get('unit', 'API')}) is high, "
                    f"indicating predominantly shale-rich lithology in this interval."
                )
            elif gr_mean < 45:
                findings.append(
                    f"Gamma Ray average ({gr_mean:.1f} {names[gr_key].get('unit', 'API')}) is low, "
                    f"suggesting clean sand/carbonate lithology — potentially reservoir quality."
                )
            else:
                findings.append(
                    f"Gamma Ray average ({gr_mean:.1f} {names[gr_key].get('unit', 'API')}) is moderate, "
                    f"suggesting mixed lithology (silty sand or shaly sand)."
                )
            if gr_max_val - gr_min_val > 60:
                findings.append(
                    f"Gamma Ray range is wide ({gr_min_val:.1f}–{gr_max_val:.1f}), "
                    f"indicating interbedded lithologies with distinct layers."
                )

    return findings


# ── Main entry point ─────────────────────────────────────────────────

def get_interpretation(
    db: Session,
    file_id: int,
    depth_start: float,
    depth_end: float,
    curve_ids: list[int],
) -> dict:
    curves = (
        db.query(Curve)
        .filter(Curve.las_file_id == file_id, Curve.id.in_(curve_ids))
        .all()
    )

    curve_context = []
    for c in curves:
        stats = _compute_curve_stats(db, c.id, depth_start, depth_end)
        samples = _get_curve_samples(db, c.id, depth_start, depth_end, max_points=100)
        if stats:
            curve_context.append({
                "name": c.name,
                "unit": c.unit or "",
                "description": (c.description or "")[:80],
                "stats": stats,
                "data_samples": samples,
            })

    if not curve_context:
        return {
            "interpretation": "No valid curve data in the selected depth range.",
            "source": "none",
            "curves_analyzed": [],
        }

    curves_analyzed = [
        {"name": c["name"], "unit": c["unit"], **c["stats"]}
        for c in curve_context
    ]

    prompt = _build_interpretation_prompt(curve_context, depth_start, depth_end)

    # ── 1. Try Groq (OpenAI-compatible, free tier) ──
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        groq_models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
        for model_name in groq_models:
            try:
                from openai import OpenAI

                client = OpenAI(
                    api_key=groq_key,
                    base_url="https://api.groq.com/openai/v1",
                )
                response = client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are a petrophysicist and well-log analyst. "
                                "Analyze the provided well-log data and give a specific, "
                                "data-driven interpretation. Reference actual depth values "
                                "and curve readings. Do NOT use markdown formatting."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.3,
                    max_tokens=1024,
                )
                text = response.choices[0].message.content
                if text:
                    return {
                        "interpretation": text.strip(),
                        "source": f"groq ({model_name})",
                        "curves_analyzed": curves_analyzed,
                        "depth_start": depth_start,
                        "depth_end": depth_end,
                    }
            except Exception as e:
                print(f"Groq ({model_name}) error: {e}")
                continue

    # ── 2. Try Gemini ──
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        gemini_models = [
            os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
            "gemini-1.5-flash",
        ]
        seen = set()
        for model_name in gemini_models:
            if model_name in seen:
                continue
            seen.add(model_name)
            try:
                import google.generativeai as genai

                genai.configure(api_key=gemini_key)
                model = genai.GenerativeModel(model_name)
                response = model.generate_content(prompt)
                text = response.text
                if text:
                    return {
                        "interpretation": text.strip(),
                        "source": f"gemini ({model_name})",
                        "curves_analyzed": curves_analyzed,
                        "depth_start": depth_start,
                        "depth_end": depth_end,
                    }
            except Exception as e:
                print(f"Gemini ({model_name}) error: {e}")
                continue

    # ── 3. Fallback: comprehensive rule-based analysis ──
    return {
        "interpretation": _rule_based_interpretation(curve_context, depth_start, depth_end),
        "source": "analytical (rule-based)",
        "curves_analyzed": curves_analyzed,
        "depth_start": depth_start,
        "depth_end": depth_end,
    }


# ── Gemini prompt builder ────────────────────────────────────────────

def _build_interpretation_prompt(
    curve_context: list[dict], depth_start: float, depth_end: float
) -> str:
    lines = [
        "You are a petrophysicist / well-log analyst. You are given ACTUAL curve data from a well log "
        f"over depth range {depth_start} to {depth_end} (units from the file).\n\n"
        "Analyze the data below and provide:\n"
        "1. A summary of what the curves show in this interval (trends, anomalies, zones of interest)\n"
        "2. Geological interpretation (lithology, fluid indicators, formation quality)\n"
        "3. Any notable features (e.g., sudden changes, washout zones, hydrocarbon indicators)\n\n"
        "Be specific — reference actual depth values and curve values from the data. "
        "Keep the response to 4-8 sentences. Do NOT use markdown formatting.\n\n"
        "=== CURVE DATA ===\n",
    ]

    for c in curve_context:
        lines.append(f"\nCurve: {c['name']} (unit: {c['unit']})")
        lines.append(f"  Description: {c['description']}")
        lines.append(
            f"  Statistics: min={c['stats']['min']}, max={c['stats']['max']}, "
            f"mean={c['stats']['mean']:.2f}, samples={c['stats']['count']}"
        )
        lines.append("  Data points (depth → value):")
        for pt in c["data_samples"][:60]:
            if pt["value"] is not None:
                lines.append(f"    {pt['depth']} → {pt['value']}")

    return "\n".join(lines)


# ── Rule-based analysis engine ───────────────────────────────────────

def _rule_based_interpretation(
    curve_context: list[dict], depth_start: float, depth_end: float
) -> str:
    """
    Comprehensive rule-based analysis using actual curve data.
    Performs: per-curve statistics, trend analysis, anomaly detection,
    zone segmentation, and multi-curve crossover analysis.
    """
    parts: list[str] = []
    depth_span = depth_end - depth_start

    parts.append(f"WELL LOG ANALYSIS — Depth interval: {depth_start} to {depth_end} ({depth_span:.1f} units)\n")
    parts.append(f"Curves analyzed: {', '.join(c['name'] for c in curve_context)}\n")
    parts.append("=" * 60 + "\n")

    # ── Per-curve analysis ──
    for c in curve_context:
        name = c["name"]
        unit = c.get("unit") or ""
        ctype = _classify_curve(name)
        stats = c["stats"]
        samples = c["data_samples"]
        vals = _values(samples)

        parts.append(f"\n▸ {name} — {ctype}" + (f" [{unit}]" if unit else ""))
        parts.append(f"  Statistics: min={stats['min']}, max={stats['max']}, mean={stats['mean']:.4f}, samples={stats['count']}")

        if len(vals) > 1:
            std = statistics.stdev(vals)
            parts.append(f"  Std deviation: {std:.4f}, Coefficient of variation: {std / abs(stats['mean']) * 100:.1f}%" if stats['mean'] != 0 else f"  Std deviation: {std:.4f}")

        # Trend
        trend = _detect_trend(samples)
        if trend["direction"] != "insufficient data":
            q = trend.get("quarter_avgs", [])
            q_str = " → ".join(f"{v:.2f}" if v else "N/A" for v in q)
            parts.append(f"  Trend: {trend['direction'].upper()} (quarter averages: {q_str})")

        # Anomalies
        anomalies = _detect_anomalies(samples, name)
        if anomalies:
            parts.append(f"  Anomalies detected ({len(anomalies)}):")
            for a in anomalies[:5]:
                parts.append(f"    - {a['type'].capitalize()} at depth {a['depth']}: value={a['value']} (z-score={a['z_score']})")

        # Zone segmentation
        zones = _detect_zones(samples, n_zones=3)
        if zones:
            parts.append(f"  Zone breakdown:")
            for z in zones:
                parts.append(
                    f"    Zone {z['zone']} ({z['depth_from']}–{z['depth_to']}): "
                    f"avg={z['avg']}, range=[{z['min']}, {z['max']}], std={z['std']}"
                )

        parts.append("")

    # ── Cross-curve analysis ──
    if len(curve_context) >= 2:
        crossovers = _detect_crossovers(curve_context)
        if crossovers:
            parts.append("=" * 60)
            parts.append("\nCROSS-CURVE ANALYSIS:\n")
            for finding in crossovers:
                parts.append(f"  • {finding}")
            parts.append("")

    # ── Summary interpretation ──
    parts.append("=" * 60)
    parts.append("\nINTERPRETATION SUMMARY:\n")
    summary_points = _build_summary(curve_context, depth_start, depth_end)
    for pt in summary_points:
        parts.append(f"  • {pt}")

    return "\n".join(parts)


def _build_summary(curve_context: list[dict], depth_start: float, depth_end: float) -> list[str]:
    """Generate interpretive summary bullets based on all curve data."""
    points = []
    names_upper = {c["name"].upper(): c for c in curve_context}

    # Gamma ray lithology summary
    gr_c = next((names_upper[k] for k in ("GR", "SGR", "GAMMA") if k in names_upper), None)
    if gr_c:
        gr_mean = gr_c["stats"]["mean"]
        if gr_mean > 100:
            points.append(
                f"Gamma Ray indicates predominantly argillaceous (shale-rich) lithology "
                f"through the interval (avg {gr_mean:.1f})."
            )
        elif gr_mean < 45:
            points.append(
                f"Low Gamma Ray (avg {gr_mean:.1f}) suggests clean reservoir rock "
                f"(sandstone or carbonate) — good reservoir potential."
            )
        else:
            points.append(
                f"Moderate Gamma Ray (avg {gr_mean:.1f}) indicates heterogeneous lithology "
                f"— possibly interbedded sands and shales."
            )

    # Porosity summary
    nphi_c = next((names_upper[k] for k in ("NPHI", "TNPH", "NPOR") if k in names_upper), None)
    dphi_c = next((names_upper[k] for k in ("DPHI",) if k in names_upper), None)
    rhob_c = next((names_upper[k] for k in ("RHOB", "RHOZ") if k in names_upper), None)

    if nphi_c:
        nphi_mean = nphi_c["stats"]["mean"]
        # Porosity values may be in fractional (0-1) or percentage (0-100)
        display = nphi_mean * 100 if nphi_mean < 1 else nphi_mean
        if display > 20:
            points.append(f"Neutron porosity is high (avg {display:.1f}%), indicating good porosity or possible shale/gas effect.")
        elif display > 8:
            points.append(f"Neutron porosity is moderate (avg {display:.1f}%), consistent with porous reservoir rock.")
        else:
            points.append(f"Neutron porosity is low (avg {display:.1f}%), suggesting tight/low-porosity formation.")

    if rhob_c:
        rhob_mean = rhob_c["stats"]["mean"]
        if rhob_mean < 2.35:
            points.append(f"Low bulk density (avg {rhob_mean:.3f} g/cc) may indicate gas-bearing or highly porous zone.")
        elif rhob_mean > 2.65:
            points.append(f"High bulk density (avg {rhob_mean:.3f} g/cc) suggests dense/tight formation (possibly anhydrite or dolomite).")
        else:
            points.append(f"Bulk density (avg {rhob_mean:.3f} g/cc) is in a normal range for sedimentary rocks.")

    # Resistivity summary
    res_keys = [k for k in ("ILD", "LLD", "RESD", "RT", "AT90", "AT60") if k in names_upper]
    if res_keys:
        res_c = names_upper[res_keys[0]]
        res_mean = res_c["stats"]["mean"]
        res_max = res_c["stats"]["max"]
        if res_mean > 20:
            points.append(
                f"Deep resistivity is elevated (avg {res_mean:.2f} ohm·m, max {res_max:.2f}), "
                f"which may indicate hydrocarbon saturation or very tight rock."
            )
        elif res_mean < 2:
            points.append(
                f"Low deep resistivity (avg {res_mean:.2f} ohm·m) suggests water-saturated formation."
            )
        else:
            points.append(f"Resistivity (avg {res_mean:.2f} ohm·m) is moderate — requires further analysis with porosity logs.")

    # Sonic summary
    dt_c = next((names_upper[k] for k in ("DT", "DTC", "DTCO") if k in names_upper), None)
    if dt_c:
        dt_mean = dt_c["stats"]["mean"]
        if dt_mean > 100:
            points.append(f"High sonic transit time (avg {dt_mean:.1f} µs/ft) indicates slow, porous or shale-rich formation.")
        elif dt_mean < 60:
            points.append(f"Low sonic transit time (avg {dt_mean:.1f} µs/ft) indicates fast, dense/tight rock.")
        else:
            points.append(f"Sonic transit time (avg {dt_mean:.1f} µs/ft) is within normal range for typical sedimentary rock.")

    # Caliper summary
    cal_c = next((names_upper[k] for k in ("CALI", "CAL") if k in names_upper), None)
    if cal_c:
        cal_vals = _values(cal_c["data_samples"])
        if cal_vals:
            cal_std = statistics.stdev(cal_vals) if len(cal_vals) > 1 else 0
            cal_mean = cal_c["stats"]["mean"]
            if cal_std / cal_mean > 0.05 if cal_mean > 0 else False:
                points.append(
                    f"Caliper variability (std {cal_std:.2f}) around mean {cal_mean:.2f} "
                    f"indicates borehole irregularities — log quality may be affected in washout zones."
                )
            else:
                points.append(f"Caliper is relatively uniform (mean {cal_mean:.2f}), indicating stable borehole conditions.")

    # SP summary
    sp_c = next((names_upper[k] for k in ("SP",) if k in names_upper), None)
    if sp_c:
        sp_vals = _values(sp_c["data_samples"])
        if sp_vals:
            sp_range = max(sp_vals) - min(sp_vals)
            if sp_range > 40:
                points.append(
                    f"SP log shows significant deflection (range {sp_range:.1f} mV), "
                    f"indicating permeable zones with formation water different from drilling mud."
                )

    # If we identified nothing specific, add a generic note
    if not points:
        curve_names = ", ".join(c["name"] for c in curve_context)
        points.append(
            f"Analysis of {curve_names} across {depth_start}–{depth_end}: "
            f"Data has been processed and statistics computed for each curve. "
            f"Select additional log types (GR, resistivity, porosity) for more detailed lithology and fluid interpretation."
        )

    return points
