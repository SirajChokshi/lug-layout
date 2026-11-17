#!/usr/bin/env bash
set -euo pipefail

module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_API_TOKEN_ID:-}" ]]; then
  echo "terraform.sh needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID." >&2
  exit 1
fi

secret_access_key="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d " " -f 1)"

export AWS_ACCESS_KEY_ID="$CLOUDFLARE_API_TOKEN_ID"
export AWS_SECRET_ACCESS_KEY="$secret_access_key"
exec terraform -chdir="$module_dir" "$@"
