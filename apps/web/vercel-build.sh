#!/bin/sh
set -eu

: "${VITE_BUNDLE_BASE_URL:=$(node -p "require('../../infra/cloudflare/part-bundles.json').public_base_url")}"
export VITE_BUNDLE_BASE_URL
VITE_BUNDLE_MANIFEST_FILE="$(node ../../tools/asset-pipeline/src/cli.ts await-served)"
export VITE_BUNDLE_MANIFEST_FILE
exec pnpm run build
