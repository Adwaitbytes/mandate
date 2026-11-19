#!/usr/bin/env bash
# Full-page screenshots of every page in a direction at 360, 768 and 1440 px.
# Usage: design/shoot.sh design/directions/a-reporter [dark]
set -euo pipefail
dir="$(cd "$1" && pwd)"
scheme="${2:-light}"
for page in "$dir"/*.html; do
  name="$(basename "$page" .html)"
  for w in 360 768 1440; do
    suffix=""; [ "$scheme" = dark ] && suffix="-dark"
    npx --yes playwright@1.65.1 screenshot --full-page --color-scheme="$scheme" --wait-for-timeout=600 \
      --viewport-size="$w,900" "file://$page?still" "$dir/shots/$name-$w$suffix.png" >/dev/null
  done
done
ls "$dir/shots"
