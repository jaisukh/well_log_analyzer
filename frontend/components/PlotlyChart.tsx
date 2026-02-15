"use client";

import dynamic from "next/dynamic";

// Load Plotly only on client to avoid SSR resolution issues
const Plot = dynamic(
  () => import("react-plotly.js").then((mod) => mod.default),
  { ssr: false }
);

export default Plot;
