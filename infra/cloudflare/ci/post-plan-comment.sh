#!/usr/bin/env bash
set -euo pipefail

if (($# != 2)); then
  echo "usage: post-plan-comment.sh <pull-request-number> <report.md>" >&2
  exit 2
fi

pull_request="$1"
report="$2"
heading="### Terraform plan: catalog Worker"
bot="github-actions[bot]"
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

body_file="$(mktemp)"
{
  echo "$heading"
  echo
  if [[ -s "$report" ]]; then
    cat "$report"
  else
    echo "Terraform failed before producing a plan. See the job log."
  fi
  echo
  echo "Commit \`${PLAN_COMMIT:-$GITHUB_SHA}\` · [run log](${run_url})"
} >"$body_file"

comment_id="$(
  gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pull_request}/comments" \
    --jq ".[] | select(.user.login == \"$bot\" and (.body | startswith(\"$heading\"))) | .id" |
    tail -n 1
)"

if [[ -n "$comment_id" ]]; then
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
    -F "body=@${body_file}" >/dev/null
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pull_request}/comments" \
    -F "body=@${body_file}" >/dev/null
fi
