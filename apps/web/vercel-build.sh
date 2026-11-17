#!/bin/sh
set -eu

: "${VITE_BUNDLE_BASE_URL:=$(node -p "require('../../infra/cloudflare/part-bundles.json').public_base_url")}"
export VITE_BUNDLE_BASE_URL
: "${VITE_LDRAW_LIBRARY_BASE_URL:=$(node -p "require('../../infra/cloudflare/ldraw-library.json').public_base_url ?? ''")}"
if [ -n "$VITE_LDRAW_LIBRARY_BASE_URL" ]; then
  export VITE_LDRAW_LIBRARY_BASE_URL
else
  unset VITE_LDRAW_LIBRARY_BASE_URL
fi
exec pnpm run build
