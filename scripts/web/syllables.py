"""Records every syllable on its own (owner's choice, so a tapped syllable is never
cut off), in the same natural voice and speeds as voices.py. One shared set for
the whole app: storage lessons/syl/<sha1("<syllable>|<0 normal, 1 slow>")[:16]>.mp3,
where <syllable> is the lowercased letters only ("сто́" → "сто"). The app's
playSyllable() looks a syllable up by the same name, and falls back to cutting it
out of the word's recording when it isn't recorded yet.

  python3 scripts/web/syllables.py out/lesson.json   # the syllables of one lesson / phrase / deck / verse
  python3 scripts/web/syllables.py --all             # every lesson, phrase, deck and Bible verse

Syllables are split exactly like the app's syllables() (study.js). Already
recorded ones are skipped. Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and edge-tts.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "study"))
import supa  # noqa: E402
from voices import VOICE, RATES, synthesize  # noqa: E402

VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
ACUTE = "́"


def syllables(word):
    """Port of study.js syllables(): one vowel each; a single consonant goes to the
    next syllable, a leading й/р/л/м/н of a cluster stays with this one."""
    w = re.sub(r"[.,!?…:;«»\"“”()]+", "", str(word or "")).strip()
    chars = list(w)
    is_v = [c in VOWELS for c in chars]
    out, cur, i = [], "", 0
    while i < len(chars):
        cur += chars[i]
        vowel = is_v[i]
        if i + 1 < len(chars) and chars[i + 1] == ACUTE:
            i += 1
            cur += chars[i]
        if vowel:
            j = i + 1
            while j < len(chars) and not is_v[j]:
                j += 1
            if j < len(chars):
                cluster = [c for c in chars[i + 1:j] if c != ACUTE]
                real = [c for c in cluster if c not in "ьъЬЪ"]
                keep = 0
                if len(real) > 1 and cluster[0] in "йрлмнЙРЛМН":
                    keep = 1
                    while keep < len(cluster) and cluster[keep] in "ьъЬЪ":
                        keep += 1
                for _ in range(keep):
                    i += 1
                    cur += chars[i]
                out.append(cur)
                cur = ""
        i += 1
    if cur:
        if out and not any(c in VOWELS for c in cur):
            out[-1] += cur
        else:
            out.append(cur)
    return out or [w]


def key(syl):
    return re.sub(r"[^а-яё]", "", syl.lower())


def name(k, slow):
    return hashlib.sha1(f"{k}|{1 if slow else 0}".encode("utf-8")).hexdigest()[:16] + ".mp3"


def from_lesson(data, found):
    for s in data.get("sentences", []):
        for t in s.get("tokens", []):
            for sy in syllables(t.get("w", "")):
                k = key(sy)
                if k and any(c in VOWELS for c in k):
                    found.add(k)


def everything():
    found = set()
    rows = json.loads(supa._req("GET", "/rest/v1/lessons?status=eq.ready&select=video_id"))
    for r in rows:
        data = supa.lesson_json(r["video_id"])
        if data:
            from_lesson(json.loads(data), found)
    rows = json.loads(supa._req("GET", "/rest/v1/phrases?status=eq.ready&select=id"))
    for r in rows:
        pid = r["id"]
        path = (f"/storage/v1/object/{supa.PRIVATE}/{pid}/lesson.json" if pid.startswith("bv-")
                else f"/storage/v1/object/public/lessons/{pid}/lesson.json")
        try:
            from_lesson(json.loads(supa._req("GET", path)), found)
        except Exception as e:  # noqa: BLE001
            print(f"  skipped {pid}: {e}")
    print(f"{len(rows)} phrases/decks/verses and the lessons read")
    return found


def recorded():
    have, offset = set(), 0
    while True:
        page = json.loads(supa._req("POST", "/storage/v1/object/list/lessons",
                                    {"prefix": "syl", "limit": 1000, "offset": offset}))
        have.update(x["name"] for x in page)
        if len(page) < 1000:
            return have
        offset += 1000


async def record(todo):
    import edge_tts
    sem = asyncio.Semaphore(16)
    tmp = Path(tempfile.mkdtemp())
    done = 0

    async def one(k, slow):
        nonlocal done
        out = tmp / name(k, slow)
        if await synthesize(edge_tts, k, RATES[1 if slow else 0], out, sem):
            for attempt in range(4):
                try:
                    await asyncio.to_thread(supa.upload, f"syl/{out.name}", out.read_bytes(), "audio/mpeg")
                    done += 1
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 3:
                        print(f"  upload failed {k}: {e}")
            out.unlink()

    await asyncio.gather(*(one(k, slow) for k, slow in todo))
    return done


def main():
    found = set()
    if sys.argv[1:] == ["--all"]:
        found = everything()
    else:
        for p in sys.argv[1:]:
            from_lesson(json.loads(Path(p).read_text(encoding="utf-8")), found)
    have = recorded()
    todo = [(k, slow) for k in sorted(found) for slow in (False, True) if name(k, slow) not in have]
    print(f"{len(found)} syllables, {len(todo)} recordings to make (voice {VOICE})")
    if todo:
        print(f"Recorded {asyncio.run(record(todo))}/{len(todo)}")


if __name__ == "__main__":
    main()
