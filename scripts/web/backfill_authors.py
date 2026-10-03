"""Fills in the channel link (author_url) and channel name for lessons made before
they were recorded, from YouTube's public oEmbed. Safe to re-run."""
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import supa  # noqa: E402


def norm(url):   # same rule as normChannel() in web/api/_lib.js
    u = url.strip().replace("http://", "https://", 1).replace("://youtube.com", "://www.youtube.com")
    return u.rstrip("/").lower()


rows = json.loads(supa._req("GET", "/rest/v1/lessons?or=(author_url.is.null,channel.is.null)&select=video_id"))
for r in rows:
    vid = r["video_id"]
    q = urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}", safe="")
    try:
        with urllib.request.urlopen(f"https://www.youtube.com/oembed?format=json&url={q}", timeout=30) as f:
            info = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"  {vid}: {e}")
        continue
    supa._req("PATCH", f"/rest/v1/lessons?video_id=eq.{vid}",
              {"author_url": norm(info["author_url"]), "channel": info.get("author_name")}, {"Prefer": "return=minimal"})
    print(f"  {vid}: {info.get('author_name')} {norm(info['author_url'])}")
print(f"{len(rows)} lesson(s) needed a channel link")
