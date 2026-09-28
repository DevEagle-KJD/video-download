#!/usr/bin/env bash
# Downloads $URL at $QUALITY (best | 1080 | 720 | audio) into out/media.<ext>
set -euo pipefail
mkdir -p out

args=(
  --no-progress --newline
  --playlist-items 1            # a playlist/carousel link grabs its first item
  --restrict-filenames
  -o "out/media.%(ext)s"
  --write-info-json
  --embed-metadata
  --retries 10 --fragment-retries 10 --concurrent-fragments 8
  --extractor-args "generic:impersonate"
)

if [ -n "${COOKIES:-}" ]; then
  printf '%s\n' "$COOKIES" > cookies.txt
  args+=(--cookies cookies.txt)
fi

# Format sort (-S): "res" compares the shorter side, so "res:1080" means
# 1080p for both landscape and vertical videos. Among equal resolutions we
# prefer codecs the iPhone plays natively (H.265/H.264 + AAC) and SDR.
case "$QUALITY" in
  best)  args+=(-f "bv*+ba/b" -S "res,fps,hdr:sdr,vcodec:h265,acodec:aac" --merge-output-format mp4) ;;
  1080)  args+=(-f "bv*+ba/b" -S "res:1080,fps,hdr:sdr,vcodec:h264,acodec:aac" --merge-output-format mp4) ;;
  720)   args+=(-f "bv*+ba/b" -S "res:720,fps,hdr:sdr,vcodec:h264,acodec:aac" --merge-output-format mp4) ;;
  audio) args+=(-f "ba/b" -x --audio-format mp3 --audio-quality 0 --embed-thumbnail) ;;
esac

set +e
yt-dlp "${args[@]}" -- "$URL" 2>&1 | tee out/log.txt
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  grep -E '^ERROR:' out/log.txt | tail -n 3 > out/error.txt || true
  [ -s out/error.txt ] || tail -n 3 out/log.txt > out/error.txt
  exit "$status"
fi

ls -la out
