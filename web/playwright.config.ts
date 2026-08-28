import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(os.tmpdir(), "labelkit-v1-e2e");
const python = process.env.LABELKIT_PYTHON || path.join(repositoryRoot, ".venv", "Scripts", "python.exe");
const apiUrl = "http://127.0.0.1:8011";
const webUrl = "http://127.0.0.1:3004";

process.env.LABELKIT_E2E_RUNTIME = runtimeRoot;
process.env.LABELKIT_E2E_API_URL = apiUrl;
process.env.LABELKIT_E2E_PYTHON = python;

export default defineConfig({
  testDir: "./e2e",
  timeout: 6 * 60 * 1000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `"${python}" -m server.run`,
      cwd: repositoryRoot,
      url: `${apiUrl}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATA_DIR: path.join(runtimeRoot, "data"),
        DATABASE_URL: `sqlite:///${path.join(runtimeRoot, "labelkit.db").replaceAll("\\", "/")}`,
        API_PORT: "8011",
      },
    },
    {
      command: "npx next dev -p 3004",
      cwd: __dirname,
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: apiUrl,
      },
    },
  ],
});
