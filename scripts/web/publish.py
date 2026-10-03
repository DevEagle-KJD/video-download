"""Publishes a finished lesson to Supabase: voice clips go to storage (public
bucket "lessons", folder <video_id>/audio/), lesson.json to the private bucket
"lesson-data" (phrases and decks: the public one), and the row is marked ready."""
import concurrent.futures as cf
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import supa  # noqa: E402

OUT = Path("out")


def main(video_id, phrase=False):
    lesson = json.loads((OUT / "lesson.json").read_text(encoding="utf-8"))
    lesson["video"] = False                  # always played through YouTube (or none, for phrases)
    clips = sorted((OUT / "audio").glob("*.mp3")) if (OUT / "audio").is_dir() else []
    print(f"Uploading {len(clips)} voice clips…", flush=True)

    def put(p):
        for attempt in range(4):
            try:
                supa.upload(f"{video_id}/audio/{p.name}", p.read_bytes(), "audio/mpeg")
                return True
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    print(f"  failed {p.name}: {e}")
        return False

    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        ok = sum(pool.map(put, clips))
    print(f"  {ok}/{len(clips)} uploaded")
    body = json.dumps(lesson, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if phrase:   # a learner's own phrase or deck: public, like its voice clips
        supa.upload(f"{video_id}/lesson.json", body, "application/json", cache="no-cache")
    else:        # a video lesson: private; the app gets it through /api/lesson (free plan sees part)
        supa.upload_private(f"{video_id}/lesson.json", body, "application/json")
        supa.delete_public(f"{video_id}/lesson.json")
    if phrase:
        supa.update_phrase(video_id, status="ready", stage=None, error=None)
        print(f"Published phrase {video_id}")
        return
    supa.update_lesson(video_id, status="ready", stage=None, error=None,
                       title=lesson.get("title"), duration=lesson.get("duration"),
                       sentence_count=len(lesson.get("sentences", [])))
    print(f"Published {video_id}: {len(lesson.get('sentences', []))} sentences")


if __name__ == "__main__":
    main(sys.argv[1], phrase="--phrase" in sys.argv)
