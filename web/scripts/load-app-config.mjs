import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAppConfig() {
  const configPath = path.resolve(__dirname, "../../config/app.json");
  return JSON.parse(readFileSync(configPath, "utf8"));
}
