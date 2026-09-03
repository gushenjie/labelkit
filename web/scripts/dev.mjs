#!/usr/bin/env node
/**
 * 本地开发启动器：可选清理 .next，避免 chunk 丢失（Cannot find module './xxx.js'）
 */
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "./load-app-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const nextDir = path.join(webRoot, ".next");
const { runtime } = loadAppConfig();
const port = process.env.PORT || String(runtime.webPort);
const hostname = process.env.WEB_HOST || runtime.host || "0.0.0.0";
const clean = process.argv.includes("--clean");

if (clean && existsSync(nextDir)) {
  rmSync(nextDir, { recursive: true, force: true });
  console.log("[dev] 已清理 .next 构建缓存");
}

const nextBin = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", port], {
  cwd: webRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
