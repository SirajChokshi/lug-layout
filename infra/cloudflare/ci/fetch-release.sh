#!/usr/bin/env bash
set -euo pipefail

if (($# != 3)); then
  echo "usage: fetch-release.sh <https-url> <sha256> <output-file>" >&2
  exit 2
fi

url="$1"
expected="$2"
out="$3"

if [[ "$url" != https://* ]]; then
  echo "::error::release_url must be an https:// URL."
  exit 1
fi
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::release_sha256 must be 64 lowercase hex digits."
  exit 1
fi

curl --fail --silent --show-error --location \
  --proto "=https" --proto-redir "=https" --retry 3 \
  --output "$out" "$url"

actual="$(sha256sum "$out" | cut -d " " -f 1)"
if [[ "$actual" != "$expected" ]]; then
  echo "::error::release file SHA-256 is $actual, expected $expected."
  exit 1
fi
echo "Fetched $(stat --format=%s "$out") bytes, SHA-256 $actual."
