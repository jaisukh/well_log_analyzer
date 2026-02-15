"use client";

import { useEffect, useRef, useState } from "react";
import anime from "animejs";

const STEPS = [
  {
    key: "upload",
    title: "Upload",
    subtitle: "LAS File Ingestion",
    desc: "Your .las well-log file is validated and securely transferred to the cloud.",
    color: "#2dd4bf",
  },
  {
    key: "store",
    title: "Parse & Store",
    subtitle: "S3 + TimescaleDB",
    desc: "Raw file archived in S3. Curves parsed and indexed into a hypertable for fast queries.",
    color: "#22d3ee",
  },
  {
    key: "visualize",
    title: "Visualize",
    subtitle: "Multi-Track Charts",
    desc: "Interactive Plotly charts render each curve on its own axis with zoom & pan.",
    color: "#818cf8",
  },
  {
    key: "interpret",
    title: "AI Interpret",
    subtitle: "LLM-Powered Analysis",
    desc: "Groq/Gemini AI analyzes your data for lithology, anomalies and formation insights.",
    color: "#c084fc",
  },
];

export default function PipelineAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(-1);
  const hasStarted = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || hasStarted.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted.current) {
          hasStarted.current = true;
          runAnimation(el);
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function runAnimation(el: HTMLElement) {
    const tl = anime.timeline({ loop: true });

    // ─── Phase 1: Cards rise in ───
    tl.add({
      targets: el.querySelectorAll(".pipe-card"),
      opacity: [0, 1],
      translateY: [50, 0],
      scale: [0.95, 1],
      delay: anime.stagger(100),
      duration: 700,
      easing: "easeOutCubic",
    });

    // ─── Phase 2: Beam draws ───
    tl.add({
      targets: el.querySelector(".beam-fill"),
      scaleX: [0, 1],
      duration: 1000,
      easing: "easeInOutQuart",
    }, "-=300");

    // ─── Phase 3: Orb travels to each step ───
    const stops = [12.5, 37.5, 62.5, 87.5];
    STEPS.forEach((step, i) => {
      const stopX = `${stops[i]}%`;

      // Move orb
      tl.add({
        targets: el.querySelector(".orb"),
        left: stopX,
        duration: i === 0 ? 500 : 700,
        easing: "easeInOutCubic",
        begin: () => setActiveStep(i),
      }, i === 0 ? "+=100" : "+=200");

      // Orb arrival burst — scale up then settle
      tl.add({
        targets: el.querySelector(".orb-glow"),
        scale: [1, 2.5, 1],
        opacity: [0.8, 0.2, 0.8],
        duration: 600,
        easing: "easeOutQuad",
      }, "-=500");

      // Card border lights up
      tl.add({
        targets: el.querySelector(`.card-border-${i}`),
        opacity: [0, 1],
        duration: 400,
        easing: "easeOutQuad",
      }, "-=500");

      // Illustration draws
      tl.add({
        targets: el.querySelectorAll(`.illus-${i} .draw`),
        strokeDashoffset: [anime.setDashoffset, 0],
        opacity: [0, 1],
        duration: 500,
        delay: anime.stagger(60),
        easing: "easeOutCubic",
      }, "-=400");

      // Number counter ticks up
      tl.add({
        targets: el.querySelector(`.step-num-${i}`),
        opacity: [0, 1],
        translateY: [-8, 0],
        duration: 300,
        easing: "easeOutQuad",
      }, "-=400");

      // Hold
      tl.add({ duration: 1000 });

      // Fade card glow (except last)
      if (i < STEPS.length - 1) {
        tl.add({
          targets: el.querySelector(`.card-border-${i}`),
          opacity: [1, 0.2],
          duration: 300,
          easing: "easeInQuad",
        });
      }
    });

    // ─── Phase 4: All glow, final hold ───
    tl.add({
      targets: el.querySelectorAll("[class*='card-border-']"),
      opacity: 1,
      duration: 400,
    });
    tl.add({ duration: 2000 });

    // ─── Phase 5: Reset for loop ───
    tl.add({
      targets: el.querySelectorAll(".pipe-card"),
      opacity: 0,
      translateY: 30,
      scale: 0.95,
      duration: 500,
      easing: "easeInCubic",
    });
    tl.add({
      targets: [el.querySelector(".beam-fill"), el.querySelector(".orb"), el.querySelector(".orb-glow")],
      opacity: 0,
      duration: 400,
    }, "-=500");
    tl.add({
      targets: el.querySelectorAll("[class*='card-border-']"),
      opacity: 0,
      duration: 1,
    });
    tl.add({
      targets: el.querySelectorAll("[class*='step-num-']"),
      opacity: 0,
      duration: 1,
    });
    tl.add({
      targets: el.querySelectorAll("[class*='illus-'] .draw"),
      opacity: 0,
      strokeDashoffset: [0, anime.setDashoffset],
      duration: 1,
    });
    // Reset orb position back to first card center
    tl.add({
      targets: el.querySelector(".orb"),
      left: "12.5%",
      duration: 1,
    });
    tl.add({
      targets: [el.querySelector(".beam-fill"), el.querySelector(".orb"), el.querySelector(".orb-glow")],
      opacity: 1,
      duration: 1,
    });
    tl.add({
      targets: el.querySelector(".beam-fill"),
      scaleX: 0,
      duration: 1,
    });

    tl.add({ duration: 800 });
  }

  // Card center positions as percentages: center of each column in a 4-col grid
  const stopPositions = [12.5, 37.5, 62.5, 87.5];

  return (
    <div ref={containerRef} className="relative">
      {/* ── Beam — sits above the cards, from center of first card to center of last ── */}
      <div className="relative h-10 mb-8">
        {/* Track line */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-[2px] bg-slate-800/50 rounded-full"
          style={{ left: `${stopPositions[0]}%`, right: `${100 - stopPositions[3]}%` }}
        />
        {/* Gradient fill */}
        <div
          className="beam-fill absolute top-1/2 -translate-y-1/2 h-[2px] rounded-full origin-left"
          style={{
            left: `${stopPositions[0]}%`,
            right: `${100 - stopPositions[3]}%`,
            background: "linear-gradient(90deg, #2dd4bf, #22d3ee, #818cf8, #c084fc)",
            transform: "scaleX(0)",
          }}
        />
        {/* Orb — starts at first card center */}
        <div
          className="orb absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20"
          style={{ left: `${stopPositions[0]}%` }}
        >
          <div
            className="orb-glow absolute -inset-4 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(45,212,191,0.3) 0%, transparent 70%)" }}
          />
          <div
            className="w-3.5 h-3.5 rounded-full relative"
            style={{
              background: "#fff",
              boxShadow: "0 0 10px #2dd4bf, 0 0 25px #2dd4bf80, 0 0 50px #2dd4bf30",
            }}
          />
        </div>
        {/* Marker dots — one at the exact center-top of each card */}
        {STEPS.map((step, i) => (
          <div
            key={step.key}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
            style={{ left: `${stopPositions[i]}%` }}
          >
            <div
              className="w-2 h-2 rounded-full transition-all duration-500"
              style={{
                background: activeStep >= i ? step.color : "#1e293b",
                boxShadow: activeStep >= i ? `0 0 10px ${step.color}80` : "none",
              }}
            />
          </div>
        ))}
      </div>

      {/* ── Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {STEPS.map((step, i) => (
          <div key={step.key} className="pipe-card relative" style={{ opacity: 0 }}>
            {/* Active border glow */}
            <div
              className={`card-border-${i} absolute -inset-[1px] rounded-2xl pointer-events-none z-0`}
              style={{
                opacity: 0,
                background: `linear-gradient(135deg, ${step.color}50, transparent 50%, transparent 50%, ${step.color}30)`,
                padding: "1px",
                mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                maskComposite: "exclude",
                WebkitMaskComposite: "xor",
              }}
            />

            {/* Card */}
            <div
              className="relative rounded-2xl border border-slate-800/50 overflow-hidden h-full z-10 transition-all duration-700"
              style={{
                background: activeStep === i
                  ? `linear-gradient(180deg, ${step.color}08 0%, rgba(7,13,26,0.95) 40%)`
                  : "rgba(7, 13, 26, 0.9)",
              }}
            >
              <div className="p-5">
                {/* Step number — fades in when active */}
                <div className="flex items-center justify-between mb-3">
                  <span
                    className={`step-num-${i} text-[10px] font-bold uppercase tracking-widest`}
                    style={{ color: step.color, opacity: 0 }}
                  >
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                {/* Illustration */}
                <div
                  className="w-full h-24 rounded-xl mb-4 flex items-center justify-center relative overflow-hidden"
                  style={{ background: `${step.color}05` }}
                >
                  {/* Subtle grid */}
                  <div
                    className="absolute inset-0 opacity-[0.04]"
                    style={{
                      backgroundImage: `linear-gradient(${step.color} 1px, transparent 1px), linear-gradient(90deg, ${step.color} 1px, transparent 1px)`,
                      backgroundSize: "16px 16px",
                    }}
                  />

                  {i === 0 && (
                    <svg className={`illus-${i} relative z-10`} width="64" height="64" viewBox="0 0 64 64" fill="none">
                      <rect className="draw" x="18" y="16" width="28" height="36" rx="4" stroke={step.color} strokeWidth="1.5" />
                      <line className="draw" x1="24" y1="26" x2="40" y2="26" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="24" y1="32" x2="36" y2="32" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="24" y1="38" x2="38" y2="38" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="24" y1="44" x2="34" y2="44" stroke={step.color} strokeWidth="1" />
                      <polyline className="draw" points="32,4 32,18" stroke={step.color} strokeWidth="2" />
                      <polyline className="draw" points="26,12 32,6 38,12" stroke={step.color} strokeWidth="2" />
                      <circle className="draw" cx="48" cy="12" r="5" stroke={`${step.color}60`} strokeWidth="1" strokeDasharray="3 2" />
                      <polyline className="draw" points="46,12 48,14 52,10" stroke={step.color} strokeWidth="1.5" />
                    </svg>
                  )}
                  {i === 1 && (
                    <svg className={`illus-${i} relative z-10`} width="64" height="64" viewBox="0 0 64 64" fill="none">
                      <ellipse className="draw" cx="22" cy="18" rx="12" ry="4" stroke={step.color} strokeWidth="1.5" />
                      <path className="draw" d="M10 18v8c0 2.2 5.4 4 12 4s12-1.8 12-4V18" stroke={step.color} strokeWidth="1.5" />
                      <path className="draw" d="M10 26v8c0 2.2 5.4 4 12 4s12-1.8 12-4V26" stroke={step.color} strokeWidth="1.5" />
                      <path className="draw" d="M10 34v8c0 2.2 5.4 4 12 4s12-1.8 12-4V34" stroke={step.color} strokeWidth="1.5" />
                      <line className="draw" x1="38" y1="28" x2="46" y2="28" stroke={step.color} strokeWidth="1.5" strokeDasharray="2 2" />
                      <polyline className="draw" points="44,24 48,28 44,32" stroke={step.color} strokeWidth="1.5" />
                      <rect className="draw" x="48" y="20" width="10" height="16" rx="2" stroke={`${step.color}80`} strokeWidth="1" />
                      <line className="draw" x1="51" y1="25" x2="55" y2="25" stroke={`${step.color}60`} strokeWidth="0.8" />
                      <line className="draw" x1="51" y1="28" x2="55" y2="28" stroke={`${step.color}60`} strokeWidth="0.8" />
                      <line className="draw" x1="51" y1="31" x2="54" y2="31" stroke={`${step.color}60`} strokeWidth="0.8" />
                    </svg>
                  )}
                  {i === 2 && (
                    <svg className={`illus-${i} relative z-10`} width="64" height="64" viewBox="0 0 64 64" fill="none">
                      <line className="draw" x1="10" y1="52" x2="56" y2="52" stroke={`${step.color}40`} strokeWidth="1" />
                      <line className="draw" x1="10" y1="8" x2="10" y2="52" stroke={`${step.color}40`} strokeWidth="1" />
                      <polyline className="draw" points="10,36 16,30 22,38 28,22 34,28 40,16 46,24 52,18" stroke={step.color} strokeWidth="2" />
                      <polyline className="draw" points="10,42 16,40 22,44 28,36 34,38 40,32 46,36 52,34" stroke={`${step.color}50`} strokeWidth="1.2" />
                      <polyline className="draw" points="10,46 16,44 22,48 28,42 34,44 40,40 46,42 52,40" stroke={`${step.color}30`} strokeWidth="1" />
                      {/* Cursor crosshair */}
                      <line className="draw" x1="34" y1="12" x2="34" y2="48" stroke={`${step.color}25`} strokeWidth="0.5" strokeDasharray="3 3" />
                    </svg>
                  )}
                  {i === 3 && (
                    <svg className={`illus-${i} relative z-10`} width="64" height="64" viewBox="0 0 64 64" fill="none">
                      <circle className="draw" cx="32" cy="28" r="16" stroke={step.color} strokeWidth="1.5" />
                      <circle className="draw" cx="32" cy="28" r="9" stroke={`${step.color}60`} strokeWidth="1" />
                      <circle className="draw" cx="32" cy="28" r="3" stroke={step.color} strokeWidth="2" />
                      {/* Rays */}
                      <line className="draw" x1="32" y1="4" x2="32" y2="10" stroke={step.color} strokeWidth="1.2" />
                      <line className="draw" x1="32" y1="46" x2="32" y2="52" stroke={step.color} strokeWidth="1.2" />
                      <line className="draw" x1="8" y1="28" x2="14" y2="28" stroke={step.color} strokeWidth="1.2" />
                      <line className="draw" x1="50" y1="28" x2="56" y2="28" stroke={step.color} strokeWidth="1.2" />
                      <line className="draw" x1="15" y1="11" x2="19.5" y2="15.5" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="44.5" y1="40.5" x2="49" y2="45" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="49" y1="11" x2="44.5" y2="15.5" stroke={step.color} strokeWidth="1" />
                      <line className="draw" x1="15" y1="45" x2="19.5" y2="40.5" stroke={step.color} strokeWidth="1" />
                      {/* Sparkle dots */}
                      <circle className="draw" cx="22" cy="16" r="1" stroke={`${step.color}80`} strokeWidth="1" />
                      <circle className="draw" cx="42" cy="16" r="1" stroke={`${step.color}80`} strokeWidth="1" />
                      <circle className="draw" cx="42" cy="40" r="1" stroke={`${step.color}80`} strokeWidth="1" />
                    </svg>
                  )}
                </div>

                <h3 className="text-[13px] font-bold text-white mb-0.5">{step.title}</h3>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: step.color }}>
                  {step.subtitle}
                </p>
                <p className="text-[11px] text-slate-500 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
