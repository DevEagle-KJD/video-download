"""Copies web/channels.tsv into the Supabase channels table (upsert by author_url),
then prints what the table holds. Uses the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets.

  python3 scripts/web/channels.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from supa import _req  # noqa: E402


def norm(url):
    # Same rule as normChannel() in web/api/_lib.js, so lookups match.
    u = url.strip().replace("http://", "https://", 1).replace("://youtube.com", "://www.youtube.com")
    return u.rstrip("/").lower()


rows = []
for line in open("web/channels.tsv", encoding="utf-8"):
    if not line.strip() or line.startswith("#"):
        continue
    url, name, lang, approved, notes = (line.rstrip("\n").split("\t") + [""] * 5)[:5]
    rows.append({"author_url": norm(url), "name": name.strip() or None, "language": lang.strip() or "ru",
                 "approved": approved.strip().lower() == "true", "notes": notes.strip() or None})

if rows:
    _req("POST", "/rest/v1/channels?on_conflict=author_url", rows,
         {"Prefer": "resolution=merge-duplicates,return=minimal"})
print(f"Saved {len(rows)} channel(s).")
for r in json.loads(_req("GET", "/rest/v1/channels?select=author_url,name,approved&order=author_url")):
    print(f"  {'APPROVED' if r['approved'] else 'not approved':12} {r['author_url']}  ({r['name']})")
