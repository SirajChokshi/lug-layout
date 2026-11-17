#!/usr/bin/env bash
set -euo pipefail

module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${RUNNER_TEMP:?RUNNER_TEMP must be set}"
output="${GITHUB_OUTPUT:-/dev/stdout}"

missing=()
for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_API_TOKEN_ID; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if ((${#missing[@]} > 0)); then
  list="${missing[*]}"
  echo "::error::Environment secrets missing: ${list// /, }. See infra/cloudflare/README.md."
  exit 1
fi

if [[ ! "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]]; then
  echo "::error::CLOUDFLARE_ACCOUNT_ID is not a 32-character hex account id."
  exit 1
fi
if [[ ! "$CLOUDFLARE_API_TOKEN_ID" =~ ^[0-9a-f]{32}$ ]]; then
  echo "::error::CLOUDFLARE_API_TOKEN_ID is not a 32-character hex token id. It is the token's id, not its value."
  exit 1
fi

echo "::add-mask::$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d " " -f 1)"

backend_config="$out_dir/backend.hcl"
endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
sed -E "s#https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com#${endpoint}#" \
  "$module_dir/backend.hcl.example" >"$backend_config"
if ! grep -qF "\"$endpoint\"" "$backend_config"; then
  echo "::error::backend.hcl.example has no R2 endpoint line to point at the account."
  exit 1
fi

tfvars_json="${CATALOG_TFVARS_JSON:-}"
if [[ -z "$tfvars_json" ]]; then
  tfvars_json="{}"
fi
if ! jq -e 'type == "object" and (has("account_id") or has("cloudflare_api_token") | not)' \
  <<<"$tfvars_json" >/dev/null; then
  echo "::error::CATALOG_TFVARS_JSON must be a JSON object without account_id or cloudflare_api_token."
  exit 1
fi
var_file="$out_dir/catalog.tfvars.json"
jq --arg account_id "$CLOUDFLARE_ACCOUNT_ID" '. + {account_id: $account_id}' \
  <<<"$tfvars_json" >"$var_file"

{
  echo "backend_config=$backend_config"
  echo "var_file=$var_file"
} >>"$output"
