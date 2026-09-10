import { defineConfig } from "@playwright/test";

// All API traffic is intercepted by the suite; no training or deletion reaches the server.
export default defineConfig({
  testDir: "./e2e", testMatch: "ux-motion.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 },
  outputDir: process.env.LABELKIT_UX_BASELINE ? "artifacts/ux-before" : "artifacts/ux-validation",
  reporter: [["list"], ["json", { outputFile: process.env.LABELKIT_UX_BASELINE ? "artifacts/ux-before-results.json" : "artifacts/ux-results.json" }]],
  use: { baseURL: process.env.LABELKIT_UX_URL || "http://127.0.0.1:3003", viewport: { width: 1440, height: 900 }, video: "on", screenshot: "on", trace: "on" },
  projects: [
    { name: "visual", grepInvert: /warmed motion/ },
    // PerformanceObserver is the evidence; recording/DOM tracing is measured separately.
    { name: "performance", grep: /warmed motion/, use: { video: "off", trace: "off" } },
  ],
});
