import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["react-plotly.js", "plotly.js"],
};

export default nextConfig;
