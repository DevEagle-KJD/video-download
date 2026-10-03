"""Accuracy check before switching transcription to Groq: for one finished lesson,
transcribes its audio with the CPU (current engine) and with Groq, then compares
both, word by word, with the finished lesson text (after proofreading).

  VIDEO_ID=… python3 scripts/study/asr_compare.py        (needs out/media.* and GROQ_API_KEY)

Writes out/compare.json and adds a table to the GitHub job summary.
"""
import difflib
import glob
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "web"))
import supa  # noqa: E402
import transcribe as tr  # noqa: E402

OUT = "out"
VID = os.environ["VIDEO_ID"]


def plain_words(text):
    t = text.lower().replace("ё", "е").replace("́", "")
    return [w for w in re.sub(r"[^\w\s-]", " ", t).split() if w.strip("-")]


def wer(ref, hyp):
    """Word error rate and the differing spots (ref words → hyp words)."""
    sm = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
    errors, diffs = 0, []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        errors += max(i2 - i1, j2 - j1)
        diffs.append((" ".join(ref[i1:i2]) or "∅", " ".join(hyp[j1:j2]) or "∅"))
    return errors / max(1, len(ref)), diffs


def timed(words):
    return [(tr._plain(w.word), w.start) for w in words if tr._plain(w.word)]


def main():
    lesson = json.loads(supa.lesson_json(VID))
    final = plain_words(" ".join(s.get("ru") or s.get("text") or "" for s in lesson["sentences"]))

    media = sorted(glob.glob(os.path.join(OUT, "media.*")))
    media = [m for m in media if not m.endswith((".json", ".vtt", ".txt"))][0]
    wav = os.path.join(OUT, "audio.wav")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)

    t0 = time.time()
    groq = tr.whisper_on_groq(wav)
    t_groq = time.time() - t0
    if groq is None:
        sys.exit("Groq failed (see warning above)")

    t0 = time.time()
    os.environ.pop("MODAL_TOKEN_ID", None)
    from faster_whisper import WhisperModel
    model = WhisperModel("large-v3", device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    segs, _ = model.transcribe(wav, language="ru", beam_size=5, vad_filter=True, word_timestamps=True,
                               condition_on_previous_text=False)
    cpu = [w for s in segs for w in (s.words or [])]
    t_cpu = time.time() - t0

    cpu_words = plain_words(" ".join(w.word for w in cpu))
    groq_words = plain_words(" ".join(w.word for w in groq))
    wer_cpu, diff_cpu = wer(final, cpu_words)
    wer_groq, diff_groq = wer(final, groq_words)
    wer_between, _ = wer(cpu_words, groq_words)

    # Word timing: for words both engines agree on, how far apart are their start times?
    a, b = timed(cpu), timed(groq)
    sm = difflib.SequenceMatcher(a=[x[0] for x in a], b=[x[0] for x in b], autojunk=False)
    gaps = [abs(a[i1 + k][1] - b[j1 + k][1]) for op, i1, i2, j1, j2 in sm.get_opcodes() if op == "equal" for k in range(i2 - i1)]
    gaps.sort()
    timing = {"median_s": round(gaps[len(gaps) // 2], 2) if gaps else None,
              "within_0_3s": round(sum(g <= 0.3 for g in gaps) / max(1, len(gaps)), 3)}

    result = {"video": VID, "title": lesson.get("title"), "final_words": len(final),
              "cpu": {"seconds": round(t_cpu), "wer_vs_final": round(wer_cpu, 4), "differences": diff_cpu[:25]},
              "groq": {"seconds": round(t_groq), "wer_vs_final": round(wer_groq, 4), "differences": diff_groq[:25]},
              "cpu_vs_groq_wer": round(wer_between, 4), "timing": timing}
    json.dump(result, open(os.path.join(OUT, "compare.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    lines = [f"### {lesson.get('title') or VID}",
             f"{len(final)} words in the finished lesson",
             "", "| | Time | Words different from finished lesson |", "|---|---|---|",
             f"| CPU (now) | {t_cpu:.0f}s | {wer_cpu:.1%} |",
             f"| Groq | {t_groq:.0f}s | {wer_groq:.1%} |",
             "", f"CPU vs Groq: {wer_between:.1%} different. Word timing: median {timing['median_s']}s apart, "
             f"{timing['within_0_3s']:.0%} within 0.3s.",
             "", "Groq differences (finished → Groq): " + "; ".join(f"{r} → {h}" for r, h in diff_groq[:15])]
    report = "\n".join(lines)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8").write(report + "\n")


if __name__ == "__main__":
    main()
