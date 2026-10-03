"""Tiny Supabase client for the web lesson worker (service key from the
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets).

  python3 scripts/web/supa.py stage <video_id> "Transcribing speech"
  python3 scripts/web/supa.py fail <video_id>          (reads out/error.txt)
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _req(method, path, data=None, headers=None, raw=False):
    h = {"apikey": KEY}
    if KEY.startswith("eyJ"):  # legacy JWT key; newer "sb_secret_..." keys go in apikey only
        h["Authorization"] = f"Bearer {KEY}"
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


PRIVATE = "lesson-data"   # video lessons' lesson.json: read only by the server (free plan sees part)


def ensure_private_bucket():
    try:
        _req("POST", "/storage/v1/bucket", {"id": PRIVATE, "name": PRIVATE, "public": False})
    except urllib.error.HTTPError as e:
        if e.code not in (400, 409):   # already exists
            raise


def upload_private(path, data, content_type):
    ensure_private_bucket()
    _req("POST", f"/storage/v1/object/{PRIVATE}/{path}", data,
         {"Content-Type": content_type, "x-upsert": "true", "Cache-Control": "no-cache"}, raw=True)


def delete_public(path):
    try:
        _req("DELETE", f"/storage/v1/object/lessons/{path}")
    except urllib.error.HTTPError:
        pass


def lesson_json(video_id):
    """A video lesson's lesson.json (private bucket, else the old public copy)."""
    for path in (f"/storage/v1/object/{PRIVATE}/{video_id}/lesson.json",
                 f"/storage/v1/object/public/lessons/{video_id}/lesson.json"):
        try:
            return _req("GET", path)
        except urllib.error.HTTPError:
            continue
    return None


def update_phrase(phrase_id, **fields):
    from datetime import datetime, timezone
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    _req("PATCH", f"/rest/v1/phrases?id=eq.{phrase_id}", fields, {"Prefer": "return=minimal"})


def phrase_text(phrase_id):
    rows = json.loads(_req("GET", f"/rest/v1/phrases?id=eq.{phrase_id}&select=text"))
    return rows[0]["text"] if rows else ""


def download_library(language="ru", folder="out/library"):
    """Every ready lesson's lesson.json (real native sentences) for phrase matching."""
    os.makedirs(folder, exist_ok=True)
    rows = json.loads(_req("GET", f"/rest/v1/lessons?status=eq.ready&language=eq.{language}&select=video_id"))
    n = 0
    for r in rows:
        try:
            data = lesson_json(r["video_id"])
            if data is None:
                raise RuntimeError("no lesson.json")
            with open(os.path.join(folder, f"{r['video_id']}.json"), "wb") as f:
                f.write(data)
            n += 1
        except Exception as e:  # noqa: BLE001
            print(f"  skipped {r['video_id']}: {e}")
    print(f"{n} lessons in the library")


if __name__ == "__main__":
    cmd, vid = sys.argv[1], sys.argv[2]
    if cmd == "pstage":
        update_phrase(vid, status="processing", stage=sys.argv[3])
    elif cmd == "pfail":
        update_phrase(vid, status="failed", stage=None, error="It couldn't be made. Try again.")
    elif cmd == "ptext":
        print(phrase_text(vid))
    elif cmd == "library":
        download_library(vid)
    elif cmd == "stage":
        update_lesson(vid, status="processing", stage=sys.argv[3])
    elif cmd == "fail":
        msg = "The lesson couldn't be made."
        if os.path.exists("out/error.txt"):
            msg = open("out/error.txt", encoding="utf-8").read().strip()[:500] or msg
        update_lesson(vid, status="failed", error=msg, stage=None)
