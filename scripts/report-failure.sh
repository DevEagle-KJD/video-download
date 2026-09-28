#!/usr/bin/env bash
# Creates an asset-less release whose body carries the error, so the app can
# show a useful message instead of just "failed".
set -uo pipefail

msg="Something went wrong. Open the run on GitHub for details."
[ -s out/error.txt ] && msg=$(cat out/error.txt)

notes=$(jq -n --arg error "$msg" --arg url "$URL" \
  --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  '{ok: false, error: $error, url: $url, run: $run}')

gh release delete "dl-$JOB_ID" --cleanup-tag -y 2>/dev/null || true
gh release create "dl-$JOB_ID" --target "$GITHUB_SHA" --prerelease --latest=false \
  --title "Failed download" --notes "$notes"
