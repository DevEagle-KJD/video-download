"""Tiny Supabase client for the web lesson worker (service key from the
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets).

  python3 scripts/web/supa.py stage <video_id> "Transcribing speech"
  python3 scripts/web/supa.py fail <video_id>          (reads out/error.txt)
"""
import json
import os
import sys
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _req(method, path, data=None, headers=None, raw=False):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    h.update(headers or {})
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    if not raw and data is not None:
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(f"{URL}{path}", data=body, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def update_lesson(video_id, **fields):
    from datetime import datetime, timezone
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    _req("PATCH", f"/rest/v1/lessons?video_id=eq.{video_id}", fields, {"Prefer": "return=minimal"})


def upload(path, data, content_type, cache="max-age=31536000"):
    _req("POST", f"/storage/v1/object/lessons/{path}", data,
         {"Content-Type": content_type, "x-upsert": "true", "Cache-Control": cache}, raw=True)


if __name__ == "__main__":
    cmd, vid = sys.argv[1], sys.argv[2]
    if cmd == "stage":
        update_lesson(vid, status="processing", stage=sys.argv[3])
    elif cmd == "fail":
        msg = "The lesson couldn't be made."
        if os.path.exists("out/error.txt"):
            msg = open("out/error.txt", encoding="utf-8").read().strip()[:500] or msg
        update_lesson(vid, status="failed", error=msg, stage=None)
