"""Turns out/media.mp4 into timed Russian sentences (out/sentences.json).

Uses the video's human-made Russian subtitles when yt-dlp found some
(out/media.ru*.vtt); otherwise transcribes the audio with Whisper
(faster-whisper, large-v3-turbo), which is very accurate for Russian.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

OUT = "out"
END = re.compile(r"[.!?…]+[»\")]*$")
MAX_WORDS = 30


def vtt_time(s):
    parts = s.replace(",", ".").split(":")
    parts = [float(p) for p in parts]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    h, m, sec = parts
    return h * 3600 + m * 60 + sec


def from_vtt(path):
    cues = []
    text = open(path, encoding="utf-8").read()
    for block in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in block.strip().splitlines()]
        timing = next((l for l in lines if "-->" in l), None)
        if not timing:
            continue
        start, end = [vtt_time(t.strip().split()[0]) for t in timing.split("-->")]
        body = " ".join(lines[lines.index(timing) + 1:])
        body = re.sub(r"<[^>]+>", "", body)          # <c>, <i>, timing tags
        body = re.sub(r"\[[^\]]*\]|\([^)]*музыка[^)]*\)", "", body, flags=re.I)
        body = re.sub(r"\s+", " ", body).strip(" -–")
        if body and (not cues or body != cues[-1]["text"]):
            cues.append({"start": start, "end": end, "text": body})

    # Join cues into whole sentences (a sentence often spans several cues).
    sentences, cur = [], None
    for c in cues:
        if cur is None:
            cur = dict(c)
        else:
            cur["text"] += " " + c["text"]
            cur["end"] = c["end"]
        if END.search(cur["text"]) or cur["end"] - cur["start"] > 12:
            sentences.append(cur)
            cur = None
    if cur:
        sentences.append(cur)
    return sentences


def from_whisper(video):
    from faster_whisper import WhisperModel

    wav = os.path.join(OUT, "audio.wav")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video,
                    "-vn", "-ac", "1", "-ar", "16000", wav], check=True)

    model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8",
                         cpu_threads=os.cpu_count() or 4)
    segments, info = model.transcribe(
        wav, language="ru", beam_size=5, vad_filter=True,
        word_timestamps=True, condition_on_previous_text=False,
    )

    words, t0, last = [], time.time(), 0
    for seg in segments:
        words.extend(seg.words or [])
        if seg.end - last > 60:
            last = seg.end
            print(f"  transcribed {seg.end / 60:.1f} / {info.duration / 60:.1f} min "
                  f"({time.time() - t0:.0f}s elapsed)", flush=True)

    sentences, cur = [], []

    def flush():
        if cur:
            sentences.append({
                "start": cur[0].start,
                "end": cur[-1].end,
                "text": "".join(w.word for w in cur).strip(),
                # Per-word timings, used to highlight each word as it's spoken.
                "words": [[w.word.strip(), round(w.start, 2), round(w.end, 2)] for w in cur],
            })
            cur.clear()

    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt.start - w.end) if nxt else 0
        if (END.search(w.word.strip()) and len(cur) >= 2) \
                or (gap > 1.2 and len(cur) >= 3) or len(cur) >= MAX_WORDS:
            flush()
    flush()
    return sentences


def main():
    video = os.path.join(OUT, "media.mp4")
    if not os.path.exists(video):
        sys.exit("no out/media.mp4 to transcribe")

    subs = sorted(glob.glob(os.path.join(OUT, "media.ru*.vtt")))
    sentences, source = [], "whisper"
    if subs:
        sentences = from_vtt(subs[0])
        source = "subtitles"
        print(f"Using subtitles {subs[0]}: {len(sentences)} sentences")
    if len(sentences) < 3:
        source = "whisper"
        print("Transcribing with Whisper (large-v3-turbo)…", flush=True)
        sentences = from_whisper(video)

    sentences = [s for s in sentences if s["text"]]
    for s in sentences:
        s["start"] = round(max(0.0, s["start"]), 2)
        s["end"] = round(max(s["end"], s["start"] + 0.3), 2)
    if not sentences:
        with open(os.path.join(OUT, "error.txt"), "w") as f:
            f.write("No Russian speech was found in this video.")
        sys.exit(1)

    with open(os.path.join(OUT, "sentences.json"), "w", encoding="utf-8") as f:
        json.dump({"source": source, "sentences": sentences}, f, ensure_ascii=False)
    print(f"{len(sentences)} sentences from {source}")


if __name__ == "__main__":
    main()
