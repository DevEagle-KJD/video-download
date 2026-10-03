"""One-off (safe to re-run): moves every video lesson's lesson.json from the public
"lessons" bucket to the private "lesson-data" bucket, so free users can only get
the first sentences (through /api/lesson). Voice clips stay public."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import supa  # noqa: E402

supa.ensure_private_bucket()
rows = json.loads(supa._req("GET", "/rest/v1/lessons?status=eq.ready&select=video_id"))
for r in rows:
    vid = r["video_id"]
    data = supa.lesson_json(vid)
    if data is None:
        print(f"  {vid}: no lesson.json found")
        continue
    supa.upload_private(f"{vid}/lesson.json", data, "application/json")
    supa.delete_public(f"{vid}/lesson.json")
    print(f"  {vid}: private")
print(f"{len(rows)} lesson(s) checked")
