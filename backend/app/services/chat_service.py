"""
Chat service for data-driven questions about uploaded well data.

Tries: Groq (free, fast) -> Gemini -> fallback message.
Now includes current selection context (which curves & depth range the user is viewing).
"""

import os
from typing import Optional, List

from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models.schema import LasFile, Curve, CurveSample


SYSTEM_PROMPT = (
    "You are a helpful well-log data analyst assistant. "
    "Answer questions about the uploaded well log based on the context provided. "
    "Be concise and reference specific curve values and depth ranges from the data. "
    "If the user has selected specific curves and a depth range, focus your answers on that selection. "
    "If the question cannot be answered from the data, say so and suggest what the user could do."
)


def get_well_context(
    db: Session,
    file_id: Optional[int],
    selected_curve_names: Optional[List[str]] = None,
    depth_start: Optional[float] = None,
    depth_end: Optional[float] = None,
) -> str:
    """Build context with actual curve statistics for the LLM."""
    if not file_id:
        return "No specific well file is selected."

    las = db.query(LasFile).filter(LasFile.id == file_id).first()
    if not las:
        return f"No file found with id {file_id}."

    curves = db.query(Curve).filter(Curve.las_file_id == file_id).all()
    if not curves:
        return f"Well file '{las.filename}' has no curves loaded."

    lines = [
        f"Well: {las.filename} (file_id={file_id}).",
        f"All curves: {', '.join(c.name + (f' ({c.unit})' if c.unit else '') for c in curves)}",
    ]

    # If user has an active selection, highlight it
    if selected_curve_names:
        lines.append(f"\nUSER'S CURRENT SELECTION:")
        lines.append(f"  Selected curves: {', '.join(selected_curve_names)}")
        if depth_start is not None and depth_end is not None:
            lines.append(f"  Viewing depth range: {depth_start} to {depth_end}")
        lines.append("  (Focus your answers on these selected curves and depth range)\n")

    # Provide stats for selected curves first (detailed), then others (brief)
    selected_set = set(selected_curve_names or [])
    detailed_curves = [c for c in curves if c.name in selected_set] if selected_set else curves
    brief_curves = [c for c in curves if c.name not in selected_set] if selected_set else []

    for c in detailed_curves:
        filters = [CurveSample.curve_id == c.id, CurveSample.value.isnot(None)]
        if depth_start is not None and depth_end is not None and c.name in selected_set:
            filters.extend([CurveSample.depth >= depth_start, CurveSample.depth <= depth_end])

        row = (
            db.query(
                func.min(CurveSample.depth).label("min_d"),
                func.max(CurveSample.depth).label("max_d"),
                func.min(CurveSample.value).label("min_v"),
                func.max(CurveSample.value).label("max_v"),
                func.avg(CurveSample.value).label("mean_v"),
                func.count(CurveSample.id).label("n"),
            )
            .filter(*filters)
            .first()
        )
        if row and row.n:
            prefix = "  [SELECTED] " if c.name in selected_set else "  "
            lines.append(
                f"{prefix}{c.name}: depth {row.min_d:.1f}–{row.max_d:.1f}, "
                f"values min={row.min_v:.4f} max={row.max_v:.4f} mean={row.mean_v:.4f}, "
                f"{row.n} samples."
            )

    if brief_curves:
        lines.append(f"\n  (Other {len(brief_curves)} curves available but not currently selected)")

    return "\n".join(lines)


def chat(
    db: Session,
    message: str,
    file_id: Optional[int] = None,
    selected_curve_names: Optional[List[str]] = None,
    depth_start: Optional[float] = None,
    depth_end: Optional[float] = None,
) -> str:
    """Answer a user question. Tries Groq -> Gemini -> fallback."""
    context = get_well_context(db, file_id, selected_curve_names, depth_start, depth_end)
    user_content = f"Context:\n{context}\n\nUser question: {message}"

    # ── 1. Try Groq ──
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        try:
            from openai import OpenAI

            client = OpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1")
            response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.3,
                max_tokens=512,
            )
            text = response.choices[0].message.content
            if text:
                return text.strip()
        except Exception as e:
            print(f"Groq chat error: {e}")

    # ── 2. Try Gemini ──
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        try:
            import google.generativeai as genai

            genai.configure(api_key=gemini_key)
            model = genai.GenerativeModel(os.getenv("GEMINI_MODEL", "gemini-2.0-flash"))
            full_prompt = f"System instruction: {SYSTEM_PROMPT}\n\n{user_content}"
            response = model.generate_content(full_prompt)
            return (response.text or "").strip()
        except Exception as e:
            print(f"Gemini chat error: {e}")

    # ── 3. Fallback ──
    return (
        "AI chat is unavailable (no API keys configured or quota exceeded). "
        "Set GROQ_API_KEY (free at console.groq.com) in the backend .env file, "
        "then restart the server."
    )
