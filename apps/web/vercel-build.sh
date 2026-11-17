#!/bin/sh
set -eu

: "${VITE_BUNDLE_BASE_URL:=$(node -p "require('../../infra/cloudflare/part-bundles.json').public_base_url")}"
export VITE_BUNDLE_BASE_URL
: "${VITE_BUNDLE_MANIFEST_FILE:=$(node -p "require('../../infra/cloudflare/bundle-fallback.json').manifest_file")}"
export VITE_BUNDLE_MANIFEST_FILE
: "${VITE_LDRAW_LIBRARY_BASE_URL:=$(node -p "require('../../infra/cloudflare/ldraw-library.json').public_base_url ?? ''")}"
if [ -n "$VITE_LDRAW_LIBRARY_BASE_URL" ]; then
  export VITE_LDRAW_LIBRARY_BASE_URL
else
  unset VITE_LDRAW_LIBRARY_BASE_URL
fi
: "${VITE_CATALOG_API_BASE_URL:=$(node -p "require('../../infra/cloudflare/catalog-api.json').base_url ?? ''")}"
export VITE_CATALOG_API_BASE_URL
exec pnpm run build
