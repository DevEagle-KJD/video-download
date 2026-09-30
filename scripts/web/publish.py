"""Publishes a finished lesson to Supabase: lesson.json and the voice clips go
to storage (bucket "lessons", folder <video_id>/), and the lessons row is
marked ready with its details."""
import concurrent.futures as cf
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import supa  # noqa: E402

OUT = Path("out")


def main(video_id):
    lesson = json.loads((OUT / "lesson.json").read_text(encoding="utf-8"))
    lesson["video"] = False                  # always played through YouTube
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
    supa.upload(f"{video_id}/lesson.json",
                json.dumps(lesson, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                "application/json", cache="no-cache")
    supa.update_lesson(video_id, status="ready", stage=None, error=None,
                       title=lesson.get("title"), duration=lesson.get("duration"),
                       sentence_count=len(lesson.get("sentences", [])))
    print(f"Published {video_id}: {len(lesson.get('sentences', []))} sentences")


if __name__ == "__main__":
    main(sys.argv[1])
