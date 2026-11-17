#!/bin/sh
set -eu

pipeline_cli=../../tools/asset-pipeline/src/cli.ts

: "${VITE_BUNDLE_BASE_URL:=$(node -p "require('../../infra/cloudflare/part-bundles.json').public_base_url")}"
export VITE_BUNDLE_BASE_URL
: "${PART_BUNDLE_WAIT_MINUTES:=42}"
export PART_BUNDLE_WAIT_MINUTES

bundle_served() {
  served_output="$(mktemp)"
  PART_BUNDLE_BASE_URL="$VITE_BUNDLE_BASE_URL" GITHUB_OUTPUT="$served_output" node "$pipeline_cli" served
  grep -qx "served=true" "$served_output"
}

skip_preview() {
  manifest_file="$(node "$pipeline_cli" manifest-file)"
  echo "Preview skipped: part bundle $manifest_file is not served from $VITE_BUNDLE_BASE_URL. This commit's part bundle inputs differ from every bundle main has published, and only main publishes part bundles (docs/part-bundle.md)."
  rm -rf dist
  mkdir dist
  cp preview-skipped.html dist/index.html
}

if [ "${VERCEL_ENV:-production}" != production ] && ! bundle_served; then
  skip_preview
  exit 0
fi

VITE_BUNDLE_MANIFEST_FILE="$(node "$pipeline_cli" await-served)"
export VITE_BUNDLE_MANIFEST_FILE
exec pnpm run build
