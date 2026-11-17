#!/bin/sh
set -eu

pipeline_dir=../../tools/asset-pipeline
pipeline_cli="$pipeline_dir/src/cli.ts"

: "${VITE_BUNDLE_BASE_URL:=$(node -p "require('../../infra/cloudflare/part-bundles.json').public_base_url")}"
export VITE_BUNDLE_BASE_URL
: "${PART_BUNDLE_WAIT_MINUTES:=42}"
export PART_BUNDLE_WAIT_MINUTES

if [ "${VERCEL_ENV:-production}" != production ]; then
  served_output="$(mktemp)"
  trap 'rm -f "$served_output"' EXIT
  PART_BUNDLE_BASE_URL="$VITE_BUNDLE_BASE_URL" GITHUB_OUTPUT="$served_output" node "$pipeline_cli" served
  served="$(cat "$served_output")"
  rm -f "$served_output"

  case "$served" in
    served=true) ;;
    served=false)
      manifest_file="$(node "$pipeline_cli" manifest-file)"
      bundle_lods="$(cd "$pipeline_dir" && node --input-type=module -e 'import { BundleLod } from "@brr/schema/bundle"; process.stdout.write(BundleLod.options.join(" "))')"
      absent_lods=""
      for lod in $bundle_lods; do
        manifest_url="${VITE_BUNDLE_BASE_URL%/}/$lod/$manifest_file"
        status="$(node -e 'fetch(process.argv[1], { method: "HEAD" }).then((response) => process.stdout.write(String(response.status)), () => process.stdout.write("unreachable"))' "$manifest_url")"
        case "$status" in
          200) ;;
          404) absent_lods="$absent_lods $lod" ;;
          *)
            echo "Can't tell whether $manifest_url exists: the bucket answered $status, not 200 or 404." >&2
            exit 1
            ;;
        esac
      done
      if [ -z "$absent_lods" ]; then
        echo "cli.ts served reported served=false, but every manifest for $manifest_file answered 200." >&2
        exit 1
      fi
      echo "Preview skipped: part bundle $manifest_file is absent from $VITE_BUNDLE_BASE_URL (404 for$absent_lods). This commit's part bundle inputs differ from every bundle main has published, and only main publishes part bundles (docs/part-bundle.md)."
      rm -rf dist
      mkdir dist
      cp preview-skipped.html dist/index.html
      exit 0
      ;;
    *)
      echo "cli.ts served reported '$served', expected served=true or served=false." >&2
      exit 1
      ;;
  esac
fi

VITE_BUNDLE_MANIFEST_FILE="$(node "$pipeline_cli" await-served)"
export VITE_BUNDLE_MANIFEST_FILE
exec pnpm run build
