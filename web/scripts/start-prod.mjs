#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "./load-app-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const { runtime } = loadAppConfig();
const port = process.env.PORT || String(runtime.webPort);
const hostname = process.env.WEB_HOST || runtime.host || "0.0.0.0";
const nextBin = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextBin, "start", "-H", hostname, "-p", port], {
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
