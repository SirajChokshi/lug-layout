#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "plan" && "$mode" != "apply" ]]; then
  echo "usage: configure.sh plan|apply" >&2
  exit 2
fi

module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${RUNNER_TEMP:?RUNNER_TEMP must be set}"
output="${GITHUB_OUTPUT:-/dev/stdout}"
report="$out_dir/catalog-plan.md"

required_env_and_secret=(
  "CLOUDFLARE_ACCOUNT_ID=CLOUDFLARE_ACCOUNT_ID"
  "CLOUDFLARE_API_TOKEN=TERRAFORM_CLOUDFLARE_API_TOKEN"
  "AWS_ACCESS_KEY_ID=TERRAFORM_STATE_R2_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY=TERRAFORM_STATE_R2_SECRET_ACCESS_KEY"
)

missing=()
for pair in "${required_env_and_secret[@]}"; do
  env_name="${pair%%=*}"
  if [[ -z "${!env_name:-}" ]]; then
    missing+=("${pair#*=}")
  fi
done

if ((${#missing[@]} > 0)); then
  list="${missing[*]}"
  if [[ "$mode" == "apply" ]]; then
    echo "::error::Environment secrets missing: ${list// /, }. See infra/cloudflare/README.md."
    exit 1
  fi
  echo "::warning::Plan skipped. Environment secrets missing: ${list// /, }."
  {
    echo "Plan skipped: the environment is missing these secrets: \`${list// /\`, \`}\`."
    echo
    echo "Setup: \`infra/cloudflare/README.md\`, section *Deploy from GitHub Actions*."
  } >"$report"
  echo "configured=false" >>"$output"
  exit 0
fi

if [[ ! "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]]; then
  echo "::error::CLOUDFLARE_ACCOUNT_ID is not a 32-character hex account id."
  exit 1
fi

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
  echo "configured=true"
  echo "backend_config=$backend_config"
  echo "var_file=$var_file"
} >>"$output"
