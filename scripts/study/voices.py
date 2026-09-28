"""Natural-sounding word audio for a lesson (Microsoft Edge neural voices via
edge-tts, the same voices and speeds as the russian-study Anki decks).

Every distinct word and phrase in the lesson, plus each word's dictionary form,
is recorded at two speeds: a comfortable learner pace, then a slower repeat.
Clips go to out/audio/<hash>.mp3, and lesson.json gets an "audio" map
{text: [clip at normal pace, clip slow]} that the app plays when a word is tapped.

Optional: if the voice service is unreachable, the lesson is published without
clips and the app falls back to the iPhone's built-in voice.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

OUT = Path("out")
VOICE = os.environ.get("STUDY_VOICE") or "ru-RU-SvetlanaNeural"
RATES = ["-25%", "-40%"]          # learner pace, then slower (as in russian-study)
CONCURRENCY = 8


def speakable(text):
    """"Пра́в." → "прав": no stress marks, no surrounding punctuation."""
    t = unicodedata.normalize("NFD", text or "").replace("́", "")
    t = unicodedata.normalize("NFC", t)
    t = re.sub(r"[^\w\s-]", " ", t)
    return " ".join(t.split()).lower()


def clip_name(text, rate):
    return hashlib.sha1(f"{VOICE}|{rate}|{text}".encode("utf-8")).hexdigest()[:12] + ".mp3"


async def synthesize(edge_tts, text, rate, out, sem, attempts=4):
    proxy = os.environ.get("HTTPS_PROXY") or None
    async with sem:
        for attempt in range(1, attempts + 1):
            try:
                await edge_tts.Communicate(text, VOICE, rate=rate, proxy=proxy).save(str(out))
                if out.exists() and out.stat().st_size > 0:
                    return True
            except Exception as exc:  # noqa: BLE001
                if attempt == attempts:
                    print(f"  no audio for {text!r}: {type(exc).__name__}")
                    return False
            if out.exists():
                out.unlink()
            await asyncio.sleep(2 * attempt)
    return False


def main(lesson_path=OUT / "lesson.json", audio_dir=OUT / "audio"):
    lesson_path, audio_dir = Path(lesson_path), Path(audio_dir)
    lesson = json.loads(lesson_path.read_text(encoding="utf-8"))

    texts = []
    for s in lesson["sentences"]:
        for tok in s["tokens"]:
            for t in (tok.get("w"), tok.get("b")):
                t = speakable(t)
                if t and re.search(r"\w", t):
                    texts.append(t)
    texts = list(dict.fromkeys(texts))
    if not texts:
        return

    try:
        import edge_tts
    except ImportError:
        print("::warning::edge-tts not installed; no natural voice for this lesson")
        return

    audio_dir.mkdir(parents=True, exist_ok=True)
    todo = [(t, r) for t in texts for r in RATES if not (audio_dir / clip_name(t, r)).exists()]
    print(f"Recording {len(texts)} words/phrases × {len(RATES)} speeds with {VOICE} ({len(todo)} clips)…", flush=True)

    async def run():
        sem = asyncio.Semaphore(CONCURRENCY)
        return await asyncio.gather(*(synthesize(edge_tts, t, r, audio_dir / clip_name(t, r), sem) for t, r in todo))

    t0 = time.time()
    results = asyncio.run(run())
    made = sum(results)
    print(f"  {made}/{len(todo)} clips in {time.time() - t0:.0f}s")

    clips = {}
    for t in texts:
        names = [clip_name(t, r) for r in RATES]
        if all((audio_dir / n).exists() for n in names):
            clips[t] = names
    if not clips:
        print("::warning::The voice service returned no audio; the app will use the iPhone voice")
        return
    lesson["audio"] = {"voice": VOICE, "rates": RATES, "clips": clips}
    lesson_path.write_text(json.dumps(lesson, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Natural voice for {len(clips)} of {len(texts)} words/phrases")


if __name__ == "__main__":
    main(*sys.argv[1:])
