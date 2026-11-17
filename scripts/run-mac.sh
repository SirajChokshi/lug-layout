#!/usr/bin/env bash
set -euo pipefail
REF="$1"
LABEL="$2"
EXTRA="${3:-}"
THROTTLE="${THROTTLE:-1}"
REPEATS="${REPEATS:-3}"
ROOT="${PERF_ROOT:-$HOME/lug-layout-perf}"
EVIDENCE="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$ROOT/.git" ]; then git clone https://github.com/SirajChokshi/lug-layout.git "$ROOT"; fi
cd "$ROOT"
git fetch origin "$REF"
git checkout -q --detach FETCH_HEAD
SHA=$(git rev-parse HEAD)
pnpm install --frozen-lockfile
pnpm --filter @brr/asset-pipeline build
pnpm --filter @brr/web build
lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill 2>/dev/null || true
(pnpm --filter @brr/web preview --port 4173 --strictPort --host 127.0.0.1 > "/tmp/preview-$LABEL.log" 2>&1 &) 
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4173/ >/dev/null && break; sleep 1; done
mkdir -p "$EVIDENCE/results/$LABEL"
{ echo "ref=$REF sha=$SHA"; sw_vers; sysctl -n machdep.cpu.brand_string; pmset -g batt | head -2; uptime; "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version; } > "$EVIDENCE/results/$LABEL/machine.txt" 2>&1 || true
ln -sfn "$ROOT/tools/e2e/node_modules" "$EVIDENCE/node_modules"
if [ "${MODE:-layout}" = "pointer" ]; then
  node "$EVIDENCE/scripts/pointer-move.mjs" --out="$EVIDENCE/results/$LABEL" --throttle="$THROTTLE"
else
  node "$EVIDENCE/scripts/measure.mjs" --label="$LABEL" --out="$EVIDENCE/results/$LABEL" --extra="$EXTRA" --throttle="$THROTTLE" --repeats="$REPEATS"
fi
lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill 2>/dev/null || true
