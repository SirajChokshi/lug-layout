#!/usr/bin/env bash
set -euo pipefail
out="${1:-studio-samples}"
mkdir -p "$out"
tail -n +2 "$(dirname "$0")/samples.tsv" | while IFS=$'\t' read -r name repo commit path sha license; do
  url="https://raw.githubusercontent.com/$repo/$commit/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$path")"
  curl -fsSL -o "$out/$name" "$url"
  echo "$sha  $out/$name" | sha256sum -c --quiet
done
echo "fetched $(ls "$out" | wc -l) files into $out"
