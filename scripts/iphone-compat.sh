#!/usr/bin/env bash
# Makes out/media.* play on iPhone and save to Photos: MP4 with H.264/HEVC + AAC.
# Only re-encodes when the codec isn't iPhone-friendly (e.g. VP9/AV1 4K on YouTube).
set -euo pipefail

src=$(ls out/media.* | grep -vE '\.(json|txt|part)$' | head -n 1)
probe() { ffprobe -v error -select_streams "$1:0" -show_entries stream=codec_name -of csv=p=0 "$src" || true; }
vcodec=$(probe v)
acodec=$(probe a)
echo "source: $src  video: ${vcodec:-none}  audio: ${acodec:-none}"

if [ -z "$vcodec" ]; then
  echo "No video stream; leaving as is."
  exit 0
fi

vargs=(-c:v copy)
case "$vcodec" in
  h264) ;;
  hevc) vargs+=(-tag:v hvc1) ;;   # hvc1 tag is required for QuickTime/Photos
  *)    vargs=(-c:v libx264 -preset veryfast -crf 19 -pix_fmt yuv420p -profile:v high) ;;
esac

case "$acodec" in
  aac|mp3|"") aargs=(-c:a copy) ;;
  *)          aargs=(-c:a aac -b:a 192k) ;;
esac

ffmpeg -hide_banner -loglevel warning -stats -y -i "$src" \
  -map 0:v:0 -map "0:a:0?" "${vargs[@]}" "${aargs[@]}" \
  -movflags +faststart -map_metadata 0 out/final.mp4

rm -f "$src"
mv out/final.mp4 out/media.mp4
