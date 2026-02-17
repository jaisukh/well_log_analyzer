"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  uploadLAS,
  getWellMetadata,
  getSamples,
  interpret,
  chat,
  listFiles,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

const Plot = dynamic(() => import("@/components/PlotlyChart"), { ssr: false });
const PipelineAnim = dynamic(() => import("@/components/PipelineAnimation"), { ssr: false });

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
type CurveItem = {
  id: number;
  name: string;
  unit: string;
  description: string;
};

type WellMeta = {
  file_id: number;
  filename: string;
  total_curves: number;
  min_depth: number;
  max_depth: number;
  depth_unit: string;
  categories: Record<string, CurveItem[]>;
};

type CurveAnalyzed = {
  name: string;
  unit: string;
  min: number;
  max: number;
  mean: number;
  count: number;
};

/* ------------------------------------------------------------------ */
/*  Colors per track                                                   */
/* ------------------------------------------------------------------ */
const TRACK_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a78bfa",
  "#fbbf24",
  "#34d399",
  "#fb923c",
  "#60a5fa",
  "#e879f9",
];

/** GitHub repo URL — update to your repo (landing page nav icon) */
const GITHUB_REPO_URL = "https://github.com/jaisukh/well_log_analyzer";

/** Max curves selectable at once — keeps plot and AI analysis performant */
const MAX_SELECTABLE_CURVES = 5;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function WellLogDashboard() {
  /* ---------- state: upload ---------- */
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState<number | null>(null);
  const [wellMeta, setWellMeta] = useState<WellMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");
  const [curveLimitMsg, setCurveLimitMsg] = useState<string>("");
  const curveLimitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentScrollRef = useRef<HTMLDivElement>(null);
  const [previousFiles, setPreviousFiles] = useState<
    { file_id: number; filename: string; uploaded_at: string | null; curve_count: number }[]
  >([]);

  /* ---------- state: curves ---------- */
  const [selectedIds, _setSelectedIds] = useState<number[]>([]);
  const setSelectedIds = useCallback((v: number[] | ((prev: number[]) => number[])) => {
    _setSelectedIds((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try { sessionStorage.setItem("well_selectedIds", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const [expandedCats, setExpandedCats] = useState<string[]>([]);

  /* ---------- state: depth ---------- */
  const [depthRange, setDepthRange] = useState<[number, number]>([0, 5000]);
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");

  /* ---------- state: plot ---------- */
  const [plotTraces, setPlotTraces] = useState<any[]>([]);
  const [plotNames, setPlotNames] = useState<string[]>([]);

  /* ---------- state: interpretation ---------- */
  const [interpretation, setInterpretation] = useState<{
    text: string;
    source: string;
    curves_analyzed: CurveAnalyzed[];
    depth_start: number;
    depth_end: number;
  } | null>(null);
  const [interpretLoading, setInterpretLoading] = useState(false);
  const [interpretTime, setInterpretTime] = useState("");

  /* ---------- state: chatbot ---------- */
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsg, setChatMsg] = useState("");
  const [chatHistory, setChatHistory] = useState<
    { role: "user" | "assistant"; content: string; time?: string }[]
  >([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */
  const allCurves = wellMeta
    ? Object.values(wellMeta.categories).flat()
    : [];

  const depthSpan =
    wellMeta != null
      ? wellMeta.max_depth - wellMeta.min_depth
      : depthRange[1] - depthRange[0];

  function now() {
    return new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  /** Push file_id into the URL bar (without full navigation) */
  function syncUrlFileId(fid: number | null) {
    const url = new URL(window.location.href);
    if (fid) {
      url.searchParams.set("file_id", String(fid));
    } else {
      url.searchParams.delete("file_id");
      try { sessionStorage.removeItem("well_selectedIds"); } catch {}
    }
    window.history.replaceState({}, "", url.toString());
  }

  /* ---- Client mount gate (prevents SSR flash) ---- */
  const [mounted, setMounted] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    // 1. Fetch previous files list
    listFiles().then((f) => setPreviousFiles(f)).catch(() => {});

    // 2. Check URL for file_id to restore session
    const params = new URLSearchParams(window.location.search);
    const urlFileId = params.get("file_id");
    if (urlFileId) {
      const fid = Number(urlFileId);
      if (!isNaN(fid) && fid > 0) {
        setRestoring(true);
        (async () => {
          try {
            setFileId(fid);
            const meta: WellMeta = await getWellMetadata(fid);
            setWellMeta(meta);
            setDepthRange([meta.min_depth, meta.max_depth]);
            setExpandedCats(Object.keys(meta.categories));
            // Restore selected curves from sessionStorage
            try {
              const saved = sessionStorage.getItem("well_selectedIds");
              if (saved) {
                const ids: number[] = JSON.parse(saved);
                const validIds = Object.values(meta.categories).flat().map((c) => c.id);
                const restored = ids.filter((id) => validIds.includes(id)).slice(0, MAX_SELECTABLE_CURVES);
                if (restored.length > 0) _setSelectedIds(restored);
              }
            } catch {}
          } catch {
            // restore failed — just show landing page
          }
          setRestoring(false);
          setMounted(true);
        })();
        return; // don't setMounted until async completes
      }
    }
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* scroll chat */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  /* sync depth inputs */
  useEffect(() => {
    setMinInput(depthRange[0].toString());
    setMaxInput(depthRange[1].toString());
  }, [depthRange]);

  /* ---------------------------------------------------------------- */
  /*  Upload                                                           */
  /* ---------------------------------------------------------------- */
  async function handleUpload(f: File) {
    setLoading(true);
    setUploadError("");
    setUploadStatus("Uploading & parsing LAS file...");
    try {
      const result = await uploadLAS(f);
      if (result.duplicate) {
        setUploadStatus("File already uploaded — loading existing data...");
      } else {
        setUploadStatus("Stored in S3 & database. Loading metadata...");
      }
      setFileId(result.file_id);
      syncUrlFileId(result.file_id);
      const meta: WellMeta = await getWellMetadata(result.file_id);
      setWellMeta(meta);
      setDepthRange([meta.min_depth, meta.max_depth]);
      setSelectedIds([]);
      setPlotTraces([]);
      setInterpretation(null);
      setChatHistory([]);
      setExpandedCats(Object.keys(meta.categories));
      setUploadStatus("");
    } catch (err: any) {
      console.error("Upload failed:", err);
      setUploadError(err?.message || "Upload failed. Check that the backend is running.");
      setUploadStatus("");
    }
    setLoading(false);
  }

  function onFilePicked(f: File | undefined) {
    if (!f) return;
    setFile(f);
    handleUpload(f);
  }

  async function loadExistingFile(fid: number) {
    setLoading(true);
    setUploadError("");
    setUploadStatus("Loading well data...");
    try {
      setFileId(fid);
      syncUrlFileId(fid);
      const meta: WellMeta = await getWellMetadata(fid);
      setWellMeta(meta);
      setDepthRange([meta.min_depth, meta.max_depth]);
      setSelectedIds([]);
      setPlotTraces([]);
      setInterpretation(null);
      setChatHistory([]);
      setExpandedCats(Object.keys(meta.categories));
      setUploadStatus("");
    } catch (err: any) {
      setUploadError(err?.message || "Failed to load well data.");
      setUploadStatus("");
    }
    setLoading(false);
  }

  /* ---------------------------------------------------------------- */
  /*  Curve toggle                                                     */
  /* ---------------------------------------------------------------- */
  function toggleCurve(id: number) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SELECTABLE_CURVES) {
        setCurveLimitMsg(`Select at max ${MAX_SELECTABLE_CURVES} curves.`);
        if (curveLimitTimerRef.current) clearTimeout(curveLimitTimerRef.current);
        curveLimitTimerRef.current = setTimeout(() => {
          setCurveLimitMsg("");
        }, 2200);
        return prev;
      }
      return [...prev, id];
    });
  }

  function clearAll() {
    setSelectedIds([]);
    setPlotTraces([]);
  }

  /* ---------------------------------------------------------------- */
  /*  Load plot data (parallel fetch, debounced)                       */
  /* ---------------------------------------------------------------- */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadPlot = useCallback(async (ids: number[], range: [number, number]) => {
    if (!ids.length || !wellMeta) return;

    // Cancel any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      // Fetch ALL curves in parallel instead of one-by-one
      const results = await Promise.all(
        ids.map((cid) => getSamples(cid, range[0], range[1]))
      );

      // If this request was superseded, discard
      if (controller.signal.aborted) return;

      const traces: any[] = [];
      const names: string[] = [];
      const n = ids.length;
      ids.forEach((cid, i) => {
        const meta = allCurves.find((c) => c.id === cid);
        const res = results[i];
        // Each curve gets its own xaxis for independent scaling
        const xAxisKey = i === 0 ? "x" : `x${i + 1}`;
        traces.push({
          x: res.data.map((d: any) => d.value),
          y: res.data.map((d: any) => d.depth),
          type: "scatter",
          mode: "lines",
          name: meta?.name ?? `#${cid}`,
          xaxis: xAxisKey,
          line: { color: TRACK_COLORS[i % TRACK_COLORS.length], width: 1.5 },
        });
        const unit = (meta?.unit || res?.unit || "").trim();
        const label = meta?.name ?? `#${cid}`;
        names.push(unit ? `${label} (${unit})` : label);
      });
      setPlotTraces(traces);
      setPlotNames(names);
    } catch (err: any) {
      if (err?.name !== "AbortError") console.error(err);
    }
    setLoading(false);
  }, [wellMeta, allCurves]);

  /* Auto-load on curve selection change (immediate) */
  useEffect(() => {
    if (selectedIds.length > 0) loadPlot(selectedIds, depthRange);
    else { setPlotTraces([]); setPlotNames([]); setInterpretation(null); }
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, [selectedIds]);

  /* Auto-load on depth change (debounced — waits 400ms after last change) */
  useEffect(() => {
    if (!selectedIds.length) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadPlot(selectedIds, depthRange);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depthRange]);

  /* ---------------------------------------------------------------- */
  /*  Interpretation                                                   */
  /* ---------------------------------------------------------------- */
  async function handleRunAnalysis() {
    if (!fileId || !selectedIds.length) return;
    setInterpretLoading(true);
    setInterpretation(null);
    try {
      const result = await interpret({
        file_id: fileId,
        depth_start: depthRange[0],
        depth_end: depthRange[1],
        curve_ids: selectedIds,
      });
      setInterpretation({
        text: result.interpretation,
        source: result.source,
        curves_analyzed: result.curves_analyzed || [],
        depth_start: result.depth_start ?? depthRange[0],
        depth_end: result.depth_end ?? depthRange[1],
      });
      setInterpretTime(
        new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        })
      );
    } catch (err) {
      console.error(err);
      setInterpretation({
        text: "Interpretation request failed. Check that the backend is running.",
        source: "error",
        curves_analyzed: [],
        depth_start: depthRange[0],
        depth_end: depthRange[1],
      });
    }
    setInterpretLoading(false);
  }

  /* ---------------------------------------------------------------- */
  /*  Chat                                                             */
  /* ---------------------------------------------------------------- */
  async function handleSendChat(msg?: string) {
    const text = (msg ?? chatMsg).trim();
    if (!text) return;
    setChatLoading(true);
    setChatHistory((p) => [...p, { role: "user", content: text, time: now() }]);
    setChatMsg("");
    try {
      // Pass current selection context so the AI can focus on what the user is viewing
      const selectedNames = selectedIds.map(
        (id) => allCurves.find((c) => c.id === id)?.name
      ).filter(Boolean) as string[];

      const res = await chat(text, fileId, {
        selected_curve_names: selectedNames.length ? selectedNames : undefined,
        depth_start: depthRange[0],
        depth_end: depthRange[1],
      });
      setChatHistory((p) => [
        ...p,
        { role: "assistant", content: res.reply, time: now() },
      ]);
    } catch {
      setChatHistory((p) => [
        ...p,
        { role: "assistant", content: "Failed to get reply.", time: now() },
      ]);
    }
    setChatLoading(false);
  }

  const quickQueries = [
    "What's the average porosity?",
    "Identify hydrocarbon zones",
    "Show formation boundaries",
    "Assess reservoir quality",
  ];

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  /* ---------- Not yet mounted or restoring — show spinner ---------- */
  if (!mounted || restoring) {
    return (
      <div className="min-h-screen bg-[#0b1120] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full border-2 border-teal-400/30 border-t-teal-400 animate-spin" />
          <p className="text-sm text-slate-400">Loading&hellip;</p>
        </div>
      </div>
    );
  }

  /* ---------- Upload / Landing Screen ---------- */
  if (!wellMeta) {
    return (
      <div className="min-h-screen bg-[#0b1120] flex flex-col">
        {/* ── Navbar ── */}
        <nav className="h-14 flex items-center justify-between px-6 border-b border-slate-800/60 bg-[#0b1120]/80 backdrop-blur-md sticky top-0 z-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-teal-500/20">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <span className="text-base font-bold text-white tracking-tight">
              WellLog<span className="text-teal-400">AI</span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-500 hidden sm:block">Subsurface Analytics Platform</span>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300 transition-colors" aria-label="GitHub repository">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            </a>
          </div>
        </nav>

        {/* ── Hero Section ── */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden">
          {/* Background glow effects */}
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-teal-500/5 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-1/4 w-[400px] h-[400px] bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="relative z-10 flex flex-col items-center max-w-3xl w-full">
            {/* Badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-teal-500/20 bg-teal-500/5 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
              <span className="text-xs text-teal-400 font-medium">AI-Powered Well Log Analysis</span>
            </div>

            {/* Title */}
            <h1 className="text-4xl md:text-5xl font-bold text-center leading-tight mb-4">
              <span className="text-white">Analyze Subsurface Data</span>
              <br />
              <span className="bg-gradient-to-r from-teal-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
                with Intelligence
              </span>
            </h1>

            <p className="text-slate-400 text-center text-base md:text-lg max-w-xl mb-10 leading-relaxed">
              Upload your LAS files, visualize well-log curves interactively,
              and get AI-driven petrophysical interpretation — all in one platform.
            </p>

            {/* ── Upload Card ── */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f?.name.endsWith(".las")) onFilePicked(f);
              }}
              onClick={() => !loading && fileInputRef.current?.click()}
              className={`w-full max-w-lg rounded-2xl p-8 flex flex-col items-center gap-5 transition-colors duration-200 cursor-pointer group ${
                dragOver
                  ? "border-2 border-teal-400 bg-teal-500/10 shadow-2xl shadow-teal-500/20"
                  : "border border-slate-700/60 bg-[#111827]/80 hover:border-teal-500/40 hover:bg-[#111827]"
              }`}
            >
              {loading ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-teal-500/20 flex items-center justify-center">
                    <div className="w-7 h-7 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-slate-200 mb-1">Processing...</p>
                    <p className="text-xs text-teal-400/80 font-medium">{uploadStatus || "Preparing upload..."}</p>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-teal-500 to-cyan-400 rounded-full animate-pulse" style={{ width: "70%" }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-teal-500/10 group-hover:bg-teal-500/20 flex items-center justify-center transition-colors">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-base font-semibold text-slate-200 mb-1">
                      {dragOver ? "Drop your file here" : "Upload LAS File"}
                    </p>
                    <p className="text-sm text-slate-500">
                      Drag and drop your .las file, or click to browse
                    </p>
                  </div>
                  <Button
                    className="bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-black font-semibold rounded-lg px-8 py-2 shadow-lg shadow-teal-500/20 transition-colors hover:shadow-teal-500/30"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    Choose File
                  </Button>
                  <p className="text-[11px] text-slate-600">
                    Supports LAS 2.0 format
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".las"
                className="hidden"
                onChange={(e) => onFilePicked(e.target.files?.[0])}
              />
            </div>

            {/* ── Upload Error ── */}
            {uploadError && (
              <div className="w-full max-w-lg mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-red-400">Upload Failed</p>
                  <p className="text-xs text-red-400/70 mt-0.5">{uploadError}</p>
                </div>
                <button onClick={() => setUploadError("")} className="ml-auto text-red-400/60 hover:text-red-400 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            )}

            {/* ── Feature Pills ── */}
            <div className="flex flex-wrap items-center justify-center gap-3 mt-10">
              {[
                { icon: "M3 3v18h18", label: "Interactive Visualization" },
                { icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5", label: "Multi-Track Analysis" },
                { icon: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z", label: "AI Interpretation" },
                { icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", label: "Jarvis Chatbot" },
              ].map((feat) => (
                <div
                  key={feat.label}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-slate-800/60 border border-slate-700/40"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={feat.icon} />
                  </svg>
                  <span className="text-xs text-slate-300 font-medium">{feat.label}</span>
                </div>
              ))}
            </div>

            {/* ── Recent Wells — horizontal scroll carousel ── */}
            {previousFiles.length > 0 && (
              <div className="w-full max-w-xl mt-10">
                <p className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider text-center mb-3">Recent Wells</p>
                <div className="flex items-center gap-2">
                  {/* Left arrow */}
                  <button
                    onClick={() => recentScrollRef.current?.scrollBy({ left: -170, behavior: "smooth" })}
                    className="w-8 h-8 rounded-lg border border-slate-700/50 bg-slate-800/50 flex items-center justify-center hover:border-teal-500/40 hover:bg-slate-800 transition-colors shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                  </button>
                  {/* Scrollable cards */}
                  <div className="relative flex-1 min-w-0">
                    <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-4 z-10 bg-gradient-to-r from-[#0b1120] to-transparent" />
                    <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-4 z-10 bg-gradient-to-l from-[#0b1120] to-transparent" />
                    <div ref={recentScrollRef} className="flex gap-2.5 overflow-x-auto px-1 pb-1 scrollbar-none">
                      {previousFiles.map((pf) => (
                        <button
                          key={pf.file_id}
                          onClick={() => loadExistingFile(pf.file_id)}
                          disabled={loading}
                          className="shrink-0 w-40 rounded-xl border border-slate-800/60 bg-slate-800/30 hover:border-teal-500/30 hover:bg-slate-800/60 transition-all group p-3 text-left"
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <div className="w-7 h-7 rounded-lg bg-slate-700/40 flex items-center justify-center group-hover:bg-teal-500/10 transition-colors">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:stroke-teal-400 transition-colors">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                              </svg>
                            </div>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto group-hover:stroke-teal-400 transition-colors">
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </div>
                          <p className="text-[11px] font-medium text-slate-300 truncate group-hover:text-white transition-colors">{pf.filename}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">{pf.curve_count} curves</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Right arrow */}
                  <button
                    onClick={() => recentScrollRef.current?.scrollBy({ left: 170, behavior: "smooth" })}
                    className="w-8 h-8 rounded-lg border border-slate-700/50 bg-slate-800/50 flex items-center justify-center hover:border-teal-500/40 hover:bg-slate-800 transition-colors shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── How It Works — Animated Pipeline ── */}
        <div className="border-t border-slate-800/60 bg-[#070d1a] relative overflow-hidden">
          {/* Background ambient glows */}
          <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-teal-500/[0.02] rounded-full blur-[120px] pointer-events-none" />
          <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-purple-500/[0.02] rounded-full blur-[120px] pointer-events-none" />

          <div className="max-w-5xl mx-auto px-6 py-20 relative z-10">
            <p className="text-xs font-semibold text-teal-400 uppercase tracking-[0.2em] text-center mb-3">The Data Pipeline</p>
            <h2 className="text-2xl md:text-3xl font-bold text-white text-center mb-3">Watch Your Data Transform</h2>
            <p className="text-sm text-slate-500 text-center mb-14 max-w-lg mx-auto">From raw LAS upload to AI-powered geological insights — see every step come alive</p>

            <PipelineAnim />
          </div>
        </div>

        {/* ── Tech Stack Bar ── */}
        <div className="border-t border-slate-800/60 py-6 bg-[#0b1120]">
          <div className="max-w-4xl mx-auto px-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
            {["Next.js", "FastAPI", "PostgreSQL", "TimescaleDB", "Amazon S3", "Plotly.js", "Groq AI"].map((t) => (
              <span key={t} className="text-[11px] text-slate-600 font-medium uppercase tracking-wider">{t}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Main 3-panel Dashboard ---------- */
  return (
    <div className="h-screen flex flex-col bg-[#0b1120] overflow-hidden">
      {/* ====== Top Bar ====== */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-slate-800/60 bg-[#0d1526] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setWellMeta(null); setFileId(null); setFile(null); setPlotTraces([]); setSelectedIds([]); setInterpretation(null); setChatHistory([]); setChatOpen(false); syncUrlFileId(null); }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title="Back to home"
          >
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <span className="text-sm font-bold text-white tracking-tight">
              WellLog<span className="text-teal-400">AI</span>
            </span>
          </button>
          <span className="text-slate-700 mx-1">|</span>
          <div className="flex items-center gap-1.5 bg-slate-800/60 rounded-md px-2.5 py-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span className="text-xs text-slate-300 font-medium">{wellMeta.filename}</span>
          </div>
          <div className="hidden md:flex items-center gap-3 ml-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              {wellMeta.total_curves} curves
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="2" x2="12" y2="22"/><polyline points="18 16 12 22 6 16"/></svg>
              {wellMeta.min_depth}–{wellMeta.max_depth} {wellMeta.depth_unit}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => { setWellMeta(null); setFileId(null); setFile(null); setPlotTraces([]); setSelectedIds([]); setInterpretation(null); syncUrlFileId(null); }} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-teal-400 hover:bg-slate-800/60 rounded-md px-2.5 py-1.5 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            New File
          </button>
        </div>
      </header>

      {/* ====== Body: 3 panels ====== */}
      <div className="flex flex-1 overflow-hidden">

        {/* ======== LEFT SIDEBAR ======== */}
        <aside className="w-72 border-r border-slate-800/60 bg-[#0d1526] flex flex-col overflow-hidden shrink-0">

          {/* -- Sidebar Header: Curves title + actions (pinned) -- */}
          <div className="px-4 pt-4 pb-2 shrink-0">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Curve Explorer</span>
              </div>
              <span className="text-[10px] bg-teal-500/10 text-teal-400 font-semibold px-1.5 py-0.5 rounded">
                {selectedIds.length}/{allCurves.length}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] mt-1">
              <button onClick={clearAll} className="text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
            </div>
            {curveLimitMsg && (
              <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200">
                <div className="flex items-start justify-between gap-2">
                  <span>{curveLimitMsg}</span>
                  <button
                    onClick={() => setCurveLimitMsg("")}
                    className="text-rose-200/70 hover:text-rose-200 transition-colors"
                    aria-label="Dismiss"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* -- Curve Categories (scrollable area) -- */}
          <div className="flex-1 overflow-y-auto px-3 pb-2">
            {Object.entries(wellMeta.categories).map(([cat, curves]) => {
              const isExpanded = expandedCats.includes(cat);
              const selectedInCat = curves.filter((c) => selectedIds.includes(c.id)).length;
              return (
                <div key={cat} className="mb-1">
                  <button
                    onClick={() =>
                      setExpandedCats((p) =>
                        p.includes(cat) ? p.filter((x) => x !== cat) : [...p, cat]
                      )
                    }
                    className="flex items-center gap-2 w-full text-left py-2 px-2 hover:bg-slate-800/40 rounded-lg transition-colors group"
                  >
                    <span className={`transition-transform duration-200 text-slate-600 text-[10px] ${isExpanded ? "rotate-90" : ""}`}>&#9654;</span>
                    <span className="text-[13px] text-slate-300 font-semibold flex-1">{cat}</span>
                    <span className="text-[10px] text-slate-600 bg-slate-800/60 rounded px-1.5 py-0.5">
                      {selectedInCat > 0 && <span className="text-teal-400">{selectedInCat}/</span>}{curves.length}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="ml-1 mt-0.5 max-h-48 overflow-y-auto rounded-lg bg-slate-900/30 border border-slate-800/40 p-1 space-y-px">
                      {curves.map((c) => {
                        const isSelected = selectedIds.includes(c.id);
                        const color = TRACK_COLORS[allCurves.findIndex((x) => x.id === c.id) % TRACK_COLORS.length];
                        return (
                          <label
                            key={c.id}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-teal-500/10 border-l-2 border-teal-400"
                                : "hover:bg-slate-800/50 border-l-2 border-transparent"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleCurve(c.id)}
                              className="accent-teal-500 w-3 h-3 shrink-0"
                            />
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                            <span className={`text-[12px] truncate flex-1 ${isSelected ? "text-slate-200 font-medium" : "text-slate-400"}`}>
                              {c.name}
                            </span>
                            <span className="text-[9px] text-slate-600 shrink-0 font-mono">
                              {c.unit || "—"}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* -- Depth Range (pinned at bottom, above action) -- */}
          <div className="px-4 py-3 border-t border-slate-800/60 shrink-0 space-y-3 bg-[#0d1526]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2"><line x1="12" y1="2" x2="12" y2="22"/><polyline points="18 16 12 22 6 16"/></svg>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Depth Range</span>
              </div>
              <span className="text-[10px] text-teal-400 font-mono">
                {Math.round(depthRange[1] - depthRange[0])} {wellMeta.depth_unit}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[9px] text-slate-600 uppercase font-semibold tracking-wider">From</label>
                <div className="flex items-center bg-slate-800/80 rounded-md px-2 py-1.5 border border-slate-700/40 focus-within:border-teal-500/40 transition-colors">
                  <input
                    type="number"
                    value={minInput}
                    onChange={(e) => setMinInput(e.target.value)}
                    onBlur={() => { const v = parseFloat(minInput); if (!isNaN(v) && v < depthRange[1]) setDepthRange([v, depthRange[1]]); }}
                    className="bg-transparent w-full text-xs text-slate-300 outline-none font-mono"
                  />
                </div>
              </div>
              <span className="text-slate-700 mt-3.5 text-xs">—</span>
              <div className="flex-1">
                <label className="text-[9px] text-slate-600 uppercase font-semibold tracking-wider">To</label>
                <div className="flex items-center bg-slate-800/80 rounded-md px-2 py-1.5 border border-slate-700/40 focus-within:border-teal-500/40 transition-colors">
                  <input
                    type="number"
                    value={maxInput}
                    onChange={(e) => setMaxInput(e.target.value)}
                    onBlur={() => { const v = parseFloat(maxInput); if (!isNaN(v) && v > depthRange[0]) setDepthRange([depthRange[0], v]); }}
                    className="bg-transparent w-full text-xs text-slate-300 outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            <Slider
              value={depthRange}
              min={wellMeta.min_depth}
              max={wellMeta.max_depth}
              step={1}
              onValueChange={(v) => setDepthRange([v[0], v[1]] as [number, number])}
            />
            <div className="flex justify-between text-[9px] text-slate-600 font-mono -mt-1">
              <span>{wellMeta.min_depth}</span>
              <span>{wellMeta.max_depth}</span>
            </div>
          </div>

          {/* -- Run Analysis Button (pinned) -- */}
          <div className="px-4 py-3 border-t border-slate-800/60 shrink-0 bg-[#0d1526]">
            <Button
              onClick={handleRunAnalysis}
              disabled={interpretLoading || !selectedIds.length}
              className="w-full bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-black font-semibold rounded-lg flex items-center justify-center gap-2 h-9 shadow-lg shadow-teal-500/10 disabled:opacity-40"
            >
              {interpretLoading ? (
                <><div className="w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin" /> Analyzing...</>
              ) : (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run AI Analysis</>
              )}
            </Button>
            {!selectedIds.length && (
              <p className="text-[10px] text-slate-600 text-center mt-1.5">Select at least one curve to analyze</p>
            )}
          </div>
        </aside>

        {/* ======== CENTER: Visualization ======== */}
        <main className="flex-1 flex flex-col overflow-hidden bg-[#0b1120]">
          {plotTraces.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-5">
              <div className="w-20 h-20 rounded-2xl bg-slate-800/50 border border-slate-700/30 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              </div>
              <div className="text-center">
                <h3 className="text-lg font-semibold text-slate-300 mb-1">No Curves Selected</h3>
                <p className="text-sm text-slate-500 max-w-sm">
                  Select one or more curves from the left panel to begin visualizing well-log data
                </p>
              </div>
              <div className="flex items-center gap-4 text-[11px] text-slate-600">
                <span className="flex items-center gap-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scroll to zoom</span>
                <span className="flex items-center gap-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l4-4 4 4"/><path d="M5 15l4 4 4-4"/></svg> Drag to pan</span>
                <span className="flex items-center gap-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Double-click to reset</span>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Active curve legend bar */}
              <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800/40 shrink-0 bg-[#0b1120]">
                <span className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider shrink-0">Active:</span>
                <div className="flex gap-3 flex-wrap">
                  {plotNames.map((name, i) => (
                    <div key={i} className="flex items-center gap-1.5 bg-slate-800/50 rounded-md px-2 py-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TRACK_COLORS[i % TRACK_COLORS.length] }} />
                      <span className="text-[11px] font-medium text-slate-300">{name}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-hidden p-2">
                <Plot
                  data={plotTraces}
                  layout={(() => {
                    const n = plotTraces.length;
                    const gap = 0.02;
                    const trackWidth = n > 0 ? (1 - gap * (n - 1)) / n : 1;

                    // Build dynamic x-axes: each curve gets its own x-axis with independent domain
                    const layout: any = {
                      autosize: true,
                      paper_bgcolor: "#0b1120",
                      plot_bgcolor: "#0f172a",
                      font: { color: "#94a3b8", size: 10 },
                      hovermode: "closest",
                      yaxis: {
                        autorange: "reversed",
                        title: { text: `Depth (${wellMeta.depth_unit})`, font: { color: "#cbd5e1", size: 11 } },
                        tickfont: { color: "#cbd5e1", size: 10 },
                        gridcolor: "#1e293b",
                        zerolinecolor: "#1e293b",
                        showline: true,
                        linecolor: "#334155",
                        linewidth: 1,
                        ticks: "outside",
                        tickcolor: "#334155",
                        ticklen: 4,
                      },
                      showlegend: false,
                      margin: { t: 30, r: 15, b: 10, l: 55 },
                    };

                    for (let i = 0; i < n; i++) {
                      const axisName = i === 0 ? "xaxis" : `xaxis${i + 1}`;
                      const domainStart = i * (trackWidth + gap);
                      const domainEnd = domainStart + trackWidth;
                      layout[axisName] = {
                        domain: [domainStart, domainEnd],
                        title: {
                          text: plotNames[i] || "",
                          font: { color: TRACK_COLORS[i % TRACK_COLORS.length], size: 10 },
                        },
                        gridcolor: "#1e293b",
                        zerolinecolor: "#1e293b",
                        side: "top",
                        tickfont: { color: "#cbd5e1", size: 9 },
                        ticks: "outside",
                        tickcolor: "#334155",
                        ticklen: 4,
                        tickwidth: 1,
                        showline: true,
                        linecolor: "#334155",
                        linewidth: 1,
                        anchor: "y",
                      };
                      // Draw vertical separator lines between tracks
                      if (i > 0) {
                        layout[`shape${i}`] = undefined; // placeholder
                      }
                    }

                    // Add vertical separators between tracks
                    if (n > 1) {
                      layout.shapes = Array.from({ length: n - 1 }, (_, i) => ({
                        type: "line",
                        xref: "paper",
                        yref: "paper",
                        x0: (i + 1) * (trackWidth + gap) - gap / 2,
                        x1: (i + 1) * (trackWidth + gap) - gap / 2,
                        y0: 0,
                        y1: 1,
                        line: { color: "#1e293b", width: 1, dash: "dot" },
                      }));
                    }

                    return layout;
                  })()}
                  config={{ scrollZoom: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] }}
                  useResizeHandler
                  style={{ width: "100%", height: "100%" }}
                />
              </div>
            </div>
          )}
        </main>

        {/* ======== RIGHT PANEL: Jarvis (Analysis + Chat tabs) ======== */}
        <aside className="w-80 border-l border-slate-800/60 bg-[#0d1526] flex flex-col overflow-hidden shrink-0">
          {/* Tab header */}
          <div className="shrink-0 border-b border-slate-800/60">
            <div className="flex items-center gap-2 px-4 pt-3 pb-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
              <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Jarvis</h3>
            </div>
            <div className="flex px-4 gap-1">
              <button
                onClick={() => setChatOpen(false)}
                className={`flex-1 text-[11px] font-semibold py-2 rounded-t-lg transition-colors ${
                  !chatOpen
                    ? "text-teal-400 border-b-2 border-teal-400 bg-teal-500/5"
                    : "text-slate-500 hover:text-slate-400 border-b-2 border-transparent"
                }`}
              >
                Analysis
              </button>
              <button
                onClick={() => setChatOpen(true)}
                className={`flex-1 text-[11px] font-semibold py-2 rounded-t-lg transition-colors ${
                  chatOpen
                    ? "text-teal-400 border-b-2 border-teal-400 bg-teal-500/5"
                    : "text-slate-500 hover:text-slate-400 border-b-2 border-transparent"
                }`}
              >
                Chat
              </button>
            </div>
          </div>

          {/* ── Analysis Tab ── */}
          <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${chatOpen ? "hidden" : ""}`}>
            {!interpretation && !interpretLoading && (
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700/30 flex items-center justify-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-400 mb-1">No Analysis Yet</h4>
                  <p className="text-xs text-slate-600 max-w-[200px]">
                    Select curves and depth range, then click &quot;Run AI Analysis&quot; from the sidebar
                  </p>
                </div>
              </div>
            )}

            {interpretLoading && (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <div className="relative">
                  <div className="w-10 h-10 border-2 border-teal-500/30 rounded-full" />
                  <div className="absolute inset-0 w-10 h-10 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                </div>
                <div className="text-center">
                  <p className="text-xs text-slate-400 font-medium">Analyzing data...</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">
                    {selectedIds.length} curve{selectedIds.length > 1 ? "s" : ""} &middot; depth {depthRange[0]}–{depthRange[1]}
                  </p>
                </div>
              </div>
            )}

            {interpretation && !interpretLoading && (
              <>
                {/* Metadata badges */}
                <div className="space-y-2">
                  <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Results</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] bg-slate-800/80 text-teal-400 rounded-md px-2 py-1 font-mono border border-slate-700/30">
                      {interpretation.depth_start} – {interpretation.depth_end}
                    </span>
                    <span className="text-[10px] bg-slate-800/80 text-slate-400 rounded-md px-2 py-1 border border-slate-700/30">
                      {interpretation.curves_analyzed.length} curve{interpretation.curves_analyzed.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-[10px] text-slate-600">{interpretTime}</span>
                  </div>
                </div>

                {/* Curves Analyzed */}
                {interpretation.curves_analyzed.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Curve Statistics</p>
                    {interpretation.curves_analyzed.map((ca, i) => (
                      <div key={i} className="bg-slate-800/40 rounded-lg p-2.5 border border-slate-700/30">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: TRACK_COLORS[i % TRACK_COLORS.length] }} />
                          <span className="text-[12px] font-semibold text-slate-300 truncate">{ca.name}</span>
                          {ca.unit && <span className="text-[9px] text-slate-600 ml-auto font-mono shrink-0">{ca.unit}</span>}
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-[10px]">
                          <div className="text-center bg-slate-900/40 rounded py-1">
                            <span className="block text-slate-600 text-[8px] uppercase font-bold">Min</span>
                            <span className="text-slate-300 font-mono">{ca.min}</span>
                          </div>
                          <div className="text-center bg-slate-900/40 rounded py-1">
                            <span className="block text-slate-600 text-[8px] uppercase font-bold">Mean</span>
                            <span className="text-teal-400 font-mono font-semibold">{typeof ca.mean === "number" ? ca.mean.toFixed(2) : ca.mean}</span>
                          </div>
                          <div className="text-center bg-slate-900/40 rounded py-1">
                            <span className="block text-slate-600 text-[8px] uppercase font-bold">Max</span>
                            <span className="text-slate-300 font-mono">{ca.max}</span>
                          </div>
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-600">
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>
                          {ca.count.toLocaleString()} samples
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Interpretation Text */}
                <div className="space-y-2">
                  <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">
                    {interpretation.source.includes("groq") || interpretation.source.includes("gemini") ? "AI Interpretation" : "Data-Driven Analysis"}
                  </p>
                  <div className="bg-slate-800/40 rounded-lg p-3 border border-slate-700/30 max-h-[350px] overflow-y-auto">
                    {interpretation.text.split("\n").map((line, i) => {
                      const trimmed = line.trim();
                      if (!trimmed) return <div key={i} className="h-1.5" />;
                      if (trimmed.startsWith("===") || trimmed.startsWith("WELL LOG") || trimmed.startsWith("CROSS-CURVE") || trimmed.startsWith("INTERPRETATION SUMMARY"))
                        return <p key={i} className="text-[11px] font-bold text-teal-400 mt-2.5 mb-1 border-b border-slate-700/30 pb-1">{trimmed.replace(/^=+\s*/, "").replace(/\s*=+$/, "")}</p>;
                      if (trimmed.startsWith("▸"))
                        return <p key={i} className="text-[11px] font-semibold text-slate-200 mt-2">{trimmed}</p>;
                      if (trimmed.startsWith("•"))
                        return <p key={i} className="text-[11px] text-slate-300 leading-relaxed pl-2">{trimmed}</p>;
                      if (line.startsWith("  "))
                        return <p key={i} className="text-[10px] text-slate-400 leading-relaxed pl-2 font-mono">{trimmed}</p>;
                      return <p key={i} className="text-[11px] text-slate-300 leading-relaxed">{trimmed}</p>;
                    })}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleRunAnalysis}
                    className="flex-1 text-[11px] text-teal-400 hover:text-teal-300 border border-teal-500/20 hover:border-teal-500/40 rounded-lg py-2 transition-colors font-medium"
                  >
                    Re-run Analysis
                  </button>
                  <button
                    onClick={() => {
                      if (!interpretation) return;
                      const header = `WellLogAI — Interpretation Report\nFile: ${wellMeta.filename}\nDepth: ${interpretation.depth_start}–${interpretation.depth_end} ${wellMeta.depth_unit}\nCurves: ${interpretation.curves_analyzed.map((c) => c.name).join(", ")}\nSource: ${interpretation.source}\nGenerated: ${interpretTime}\n\n`;
                      const blob = new Blob([header + interpretation.text], { type: "text/plain" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = `interpretation_${wellMeta.filename.replace(".las", "")}.txt`;
                      a.click();
                    }}
                    title="Export interpretation as text"
                    className="text-[11px] text-slate-500 hover:text-teal-400 border border-slate-700/40 hover:border-teal-500/30 rounded-lg px-3 py-2 transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── Chat Tab ── */}
          <div className={`flex-1 flex flex-col overflow-hidden ${chatOpen ? "" : "hidden"}`}>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatHistory.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-teal-500/10 border border-teal-500/15 flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.5">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-300 mb-1">Ask Jarvis</h4>
                    <p className="text-xs text-slate-600 max-w-[200px]">
                      Ask data-driven questions about your well log — porosity, lithology, anomalies, formation boundaries.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-1.5 mt-2">
                    {quickQueries.map((q) => (
                      <button
                        key={q}
                        onClick={() => handleSendChat(q)}
                        className="text-[10px] text-slate-400 border border-slate-700/60 rounded-full px-2.5 py-1 hover:bg-slate-800 hover:text-teal-400 hover:border-teal-500/30 transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {chatHistory.map((m, i) => (
                <div
                  key={i}
                  className={`rounded-lg p-3 text-xs leading-relaxed ${
                    m.role === "user"
                      ? "bg-teal-500/10 border border-teal-500/20 ml-6 text-slate-300"
                      : "bg-slate-800/50 mr-6 text-slate-300"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  {m.time && (
                    <p className="text-[10px] text-slate-600 mt-1">{m.time}</p>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div className="bg-slate-800/50 rounded-lg p-3 mr-6">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="shrink-0 p-3 border-t border-slate-800/60 flex gap-2">
              <input
                value={chatMsg}
                onChange={(e) => setChatMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSendChat()}
                placeholder="Ask about your well log data..."
                className="flex-1 bg-slate-800/60 rounded-lg px-3 py-2 text-xs text-slate-300 placeholder-slate-600 outline-none focus:ring-1 focus:ring-teal-500/50"
              />
              <button
                onClick={() => handleSendChat()}
                disabled={chatLoading || !chatMsg.trim()}
                className="text-teal-400 hover:text-teal-300 disabled:text-slate-700"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
