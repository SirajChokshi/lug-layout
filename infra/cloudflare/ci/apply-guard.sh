#!/usr/bin/env bash
set -euo pipefail

if (($# != 3)); then
  echo "usage: apply-guard.sh <workflow.yml> <commit> <main-tip>" >&2
  exit 2
fi

workflow="$1"
commit="$2"
tip="$3"
output="${GITHUB_OUTPUT:-/dev/stdout}"

patterns_file="$(mktemp)"
yq 'explode(.) | .on.push.paths[]' "$workflow" >"$patterns_file"
mapfile -t patterns <"$patterns_file"
if ((${#patterns[@]} == 0)); then
  echo "::error::No on.push.paths in $workflow."
  exit 1
fi

pathspecs=()
for pattern in "${patterns[@]}"; do
  if [[ "$pattern" == "!"* ]]; then
    pathspecs+=(":(exclude,glob)${pattern#!}")
  else
    pathspecs+=(":(glob)${pattern}")
  fi
done

skip() {
  echo "::notice::Apply skipped: $1"
  echo "apply=false" >>"$output"
  exit 0
}

ancestor=0
git merge-base --is-ancestor "$commit" "$tip" || ancestor=$?
case "$ancestor" in
  0) ;;
  1) skip "${commit} is not an ancestor of main's tip ${tip}, so it is not on main any more." ;;
  *) exit "$ancestor" ;;
esac

changed=0
git diff --quiet "$commit" "$tip" -- "${pathspecs[@]}" || changed=$?
case "$changed" in
  0) ;;
  1) skip "main's tip ${tip} has different deploy inputs than ${commit}. The run for the push that changed them applies them." ;;
  *) exit "$changed" ;;
esac

echo "Deploy inputs at ${commit} match main's tip ${tip}. Applying."
echo "apply=true" >>"$output"
