#!/usr/bin/env bash
set -euo pipefail

if (($# != 2)); then
  echo "usage: plan-report.sh <plan.json> <report.md>" >&2
  exit 2
fi

plan_json="$1"
report="$2"
output="${GITHUB_OUTPUT:-/dev/stdout}"

jq -r '
  def action_name:
    if . == ["create"] then "create"
    elif . == ["update"] then "update"
    elif . == ["delete"] then "destroy"
    elif (index("create") != null and index("delete") != null) then "replace"
    else empty end;
  [.resource_changes[]? | {address, action: (.change.actions | action_name)}] as $changes
  | ($changes | map(select(.action == "create" or .action == "replace")) | length) as $add
  | ($changes | map(select(.action == "update")) | length) as $change
  | ($changes | map(select(.action == "destroy" or .action == "replace")) | length) as $destroy
  | if ($changes | length) == 0 then
      "No changes. The deployed Worker and its resources match this commit."
    else
      "**Plan: \($add) to add, \($change) to change, \($destroy) to destroy.**",
      "",
      "| Action | Resource |",
      "|---|---|",
      ($changes[] | "| \(.action) | `\(.address)` |")
    end
' "$plan_json" >"$report"

destroyed_list="$(mktemp)"
jq -r '
  .resource_changes[]?
  | select(.type == "cloudflare_d1_database" or .type == "cloudflare_r2_bucket")
  | select(.change.actions | index("delete") != null)
  | .address
' "$plan_json" >"$destroyed_list"
mapfile -t destroyed_data <"$destroyed_list"

if ((${#destroyed_data[@]} > 0)); then
  addresses="$(printf "\`%s\`, " "${destroyed_data[@]}")"
  {
    echo
    echo "**Refused:** this plan destroys catalog data: ${addresses%, }. The deploy workflow never applies such a plan. If it is intended, apply it locally (\`infra/cloudflare/README.md\`)."
  } >>"$report"
  echo "refused=true" >>"$output"
else
  echo "refused=false" >>"$output"
fi
