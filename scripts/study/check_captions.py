"""Caption check: which Russian captions does this YouTube video have?

Reads out/media.info.json (yt-dlp --skip-download) and prints a small JSON
summary, used as the body of release "check-<id>" for the app:
  creator: the creator's own Russian caption tracks (accurate)
  auto:    whether YouTube's automatic Russian captions exist (less accurate)
"""
import json

info = json.load(open("out/media.info.json", encoding="utf-8"))
creator = sorted(k for k in (info.get("subtitles") or {}) if k.lower().startswith("ru") and "live_chat" not in k)
auto_tracks = info.get("automatic_captions") or {}
# Automatic captions also list machine translations into every language; the
# real speech recognition track is the original language, marked "-orig".
orig = next((k[:-5] for k in auto_tracks if k.endswith("-orig")), None) or info.get("language") or ""
auto = orig.lower().startswith("ru") and any(k.lower().startswith("ru") for k in auto_tracks)
print(json.dumps({
    "ok": True, "kind": "check", "creator": creator, "auto": auto,
    "language": orig or None, "title": info.get("title"), "duration": info.get("duration"),
    "url": info.get("webpage_url"),
}, ensure_ascii=False))
