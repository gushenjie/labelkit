#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web"
if [ ! -d "node_modules" ]; then
  npm install
fi
if [ "${CLEAN:-0}" = "1" ] || [ "${1:-}" = "--clean" ]; then
  rm -rf .next
  echo "[web] 已清理 .next 构建缓存"
  exec npm run dev:clean
fi
exec npm run dev
