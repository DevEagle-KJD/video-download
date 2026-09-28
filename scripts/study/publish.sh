#!/usr/bin/env bash
# Publishes a lesson as release "study-$JOB_ID" with media.mp4 + lesson.json.
# The release body is a short JSON summary the app lists lessons from.
set -euo pipefail

notes=$(jq -c '{ok: true, kind: "study", title, url, duration, thumbnail, source,
                engine: (.engine // "ai"), enriched, count: (.sentences | length)}' out/lesson.json)
title=$(jq -r '.title' out/lesson.json | cut -c1-120)

assets=(out/media.mp4 out/lesson.json)
if [ -d out/audio ] && [ -n "$(ls -A out/audio)" ]; then
  (cd out && zip -q -r audio.zip audio)
  assets+=(out/audio.zip)
fi

gh release create "study-$JOB_ID" "${assets[@]}" \
  --target "$GITHUB_SHA" --prerelease --latest=false \
  --title "Lesson: $title" --notes "$notes"

echo "Published study-$JOB_ID ($(du -h out/media.mp4 | cut -f1) video)"
