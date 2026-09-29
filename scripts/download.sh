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
  # Study lessons: 480p keeps files small; also grab human-made Russian
  # subtitles when the video has them (auto-generated ones are skipped).
  study) args+=(-f "bv*+ba/b" -S "res:480,fps:30,hdr:sdr,vcodec:h264,acodec:aac" --merge-output-format mp4
                --write-subs --sub-langs "ru.*,ru" --sub-format vtt) ;;
  # Captions-only test: no video or audio at all, just YouTube's captions
  # (the creator's if any, else the automatic ones) and the video's details.
  captions) args+=(--skip-download --write-subs --write-auto-subs --sub-langs "ru,ru-orig" --sub-format json3) ;;
esac

run() {
  yt-dlp "${args[@]}" "$@" -- "$URL" 2>&1 | tee out/log.txt
  return "${PIPESTATUS[0]}"
}

blocked() {
  grep -qiE "not a bot|sign in to confirm|HTTP Error 403|HTTP Error 429|Requested format is not available" out/log.txt
}

# Routes the runner's traffic through Cloudflare WARP (free VPN) so the site
# sees a Cloudflare IP instead of one of GitHub's data-center IPs.
enable_warp() {
  echo "::group::Connecting to Cloudflare WARP"
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg |
    sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" |
    sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq cloudflare-warp > /dev/null
  sudo systemctl start warp-svc 2>/dev/null || true
  for _ in $(seq 1 15); do warp-cli --accept-tos status > /dev/null 2>&1 && break; sleep 1; done
  warp-cli --accept-tos registration new
  warp-cli --accept-tos connect
  for _ in $(seq 1 20); do
    curl -fsS --max-time 5 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on' && break
    sleep 1
  done
  curl -fsS --max-time 5 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(warp|colo)=' || true
  echo "::endgroup::"
}

set +e
run
status=$?

# YouTube often blocks data-center IPs ("confirm you're not a bot"). Retry
# through WARP, also posing as other YouTube clients.
if [ "$status" -ne 0 ] && blocked; then
  echo "::warning::Blocked by the site; retrying through Cloudflare WARP"
  enable_warp
  for clients in "" "tv_simply,web_safari" "mweb,web_embedded" "tv,ios"; do
    rm -f out/media.*
    if [ -n "$clients" ]; then
      echo "::warning::Retrying as player_client=$clients"
      run --extractor-args "youtube:player_client=$clients"
    else
      run
    fi
    status=$?
    [ "$status" -eq 0 ] && break
    blocked || break
  done
fi
set -e

if [ "$status" -ne 0 ]; then
  grep -E '^ERROR:' out/log.txt | tail -n 3 > out/error.txt || true
  [ -s out/error.txt ] || tail -n 3 out/log.txt > out/error.txt
  exit "$status"
fi

ls -la out
