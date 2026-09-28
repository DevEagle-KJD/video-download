#!/usr/bin/env bash
# Attaches out/media.* to a release tagged dl-$JOB_ID. The release body is a
# small JSON document the app reads (title, duration, source...).
set -euo pipefail

file=$(ls out/media.* | grep -vE '\.(json|txt|part|vtt|srt|wav)$' | head -n 1)
ext="${file##*.}"
info=out/media.info.json
[ -f "$info" ] || info=/dev/null

notes=$(jq -n --slurpfile i <(cat "$info" 2>/dev/null || echo '{}') \
  --arg quality "$QUALITY" --arg ext "$ext" --arg url "$URL" \
  --argjson size "$(stat -c %s "$file")" '
  ($i[0] // {}) as $i | {
    ok: true,
    title: ($i.title // $i.fulltitle // "Download"),
    uploader: ($i.uploader // $i.channel // null),
    site: ($i.extractor_key // null),
    duration: ($i.duration // null),
    thumbnail: ($i.thumbnail // null),
    height: ($i.height // null),
    quality: $quality, ext: $ext, size: $size, url: $url
  }')

title=$(jq -r '.title' <<<"$notes" | cut -c1-120)

gh release create "dl-$JOB_ID" "$file#media.$ext" \
  --target "$GITHUB_SHA" --prerelease --latest=false \
  --title "$title" --notes "$notes"

echo "Published dl-$JOB_ID ($(du -h "$file" | cut -f1))"
