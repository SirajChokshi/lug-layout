#!/usr/bin/env bash
set -euo pipefail

SHA="${1:?usage: s7-macbook.sh <commit sha of siraj/m1-model-lods-134d> [evidence ref]}"
EVIDENCE_REF="${2:-origin/siraj/m1-s7-evidence-134d}"
OUT="${OUT:-$PWD/s7-macbook-${SHA:0:7}}"
VIEW_W="${VIEW_W:-1800}"
VIEW_H="${VIEW_H:-1000}"
DPR="${DPR:-2}"

git fetch origin siraj/m1-model-lods-134d siraj/m1-s7-evidence-134d
git checkout --detach "$SHA"
pnpm install --frozen-lockfile
pnpm --filter @brr/asset-pipeline build
pnpm --filter @brr/web build

WORK="$(mktemp -d)"
git archive "$EVIDENCE_REF" m1/s7/scripts | tar -x -C "$WORK"
SCRIPTS="$WORK/m1/s7/scripts"
(cd "$WORK" && npm init -y > /dev/null && npm install --silent playwright-core)
export NODE_PATH="$WORK/node_modules"

(cd apps/web && exec ./node_modules/.bin/vite preview --port 4173 --strictPort) > "$WORK/preview.log" 2>&1 &
PREVIEW=$!
trap 'kill "$PREVIEW" 2> /dev/null || true' EXIT
until curl -sf http://localhost:4173/ > /dev/null; do sleep 1; done

mkdir -p "$OUT"
{
  echo "commit $(git rev-parse HEAD)"
  sw_vers 2> /dev/null || true
  sysctl -n machdep.cpu.brand_string hw.memsize 2> /dev/null || true
  pmset -g 2> /dev/null | grep -iE "powermode|lowpowermode|AC Power|Battery Power" || true
  pmset -g batt 2> /dev/null || true
  uptime
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2> /dev/null || true
} > "$OUT/machine.txt"

for API in webgpu webgl2; do
  node "$SCRIPTS/s7-models.cjs" --channel chrome --api "$API" --dpr "$DPR" --out "$OUT/models-$API"
  node "$SCRIPTS/s7-scene.cjs" --channel chrome --scene 10 --api "$API" \
    --width "$VIEW_W" --height "$VIEW_H" --dpr "$DPR" --measure auto,near,mid,far \
    --video 1 --out "$OUT/scene10-$API"
  node "$SCRIPTS/s7-scene.cjs" --channel chrome --scene 50 --api "$API" \
    --width "$VIEW_W" --height "$VIEW_H" --dpr "$DPR" --measure auto,near,mid,far \
    --out "$OUT/scene50-$API"
done
uptime >> "$OUT/machine.txt"
echo "results in $OUT"
