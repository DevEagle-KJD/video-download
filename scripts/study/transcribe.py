"""Turns a video into timed Russian sentences (out/sentences.json).

Normal lessons: uses the video's human-made Russian subtitles when yt-dlp found
some (out/media.ru*.vtt); otherwise transcribes out/media.mp4 with Whisper
(faster-whisper, large-v3: the most accurate Whisper model; slower than turbo
on CPU, fast on a GPU).

Captions-only test (ENGINE=captions): no video or audio is downloaded; the
transcript comes from YouTube's own captions (out/media.ru*.json3): the
creator's captions if the video has them, otherwise YouTube's automatic ones
(which have word timings but no punctuation).
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

    return cues_to_sentences(cues)


def group_words(words, max_gap=1.2, max_words=MAX_WORDS):
    """[(text, start, end, prob)] → sentences, split at . ! ? …, pauses, or length."""
    sentences, cur = [], []

    def flush():
        if cur:
            sentences.append({
                "start": cur[0][1], "end": cur[-1][2],
                "text": " ".join(w[0] for w in cur).strip(),
                "words": [[w[0], round(w[1], 2), round(w[2], 2), round(w[3], 3)] for w in cur],
            })
            cur.clear()

    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt[1] - w[2]) if nxt else 0
        if (END.search(w[0]) and len(cur) >= 2) or (gap > max_gap and len(cur) >= 3) or len(cur) >= max_words:
            flush()
    flush()
    return sentences


def from_json3(path, manual):
    """YouTube's json3 captions → sentences.

    Creator captions: one caption line per event, merged into sentences like VTT cues.
    Automatic captions: word-level timings but no punctuation, so sentences are
    split at pauses (Claude restores punctuation later in clean_captions.py).
    """
    events = json.load(open(path, encoding="utf-8")).get("events", [])
    if manual:
        cues = []
        for e in events:
            text = "".join(sg.get("utf8", "") for sg in e.get("segs") or [])
            text = re.sub(r"\[[^\]]*\]", "", text)
            text = re.sub(r"\s+", " ", text).strip(" -–")
            if not text:
                continue
            start = e.get("tStartMs", 0) / 1000
            cues.append({"start": start, "end": start + e.get("dDurationMs", 0) / 1000, "text": text})
        return cues_to_sentences(cues)

    words = []
    for e in events:
        t0 = e.get("tStartMs", 0) / 1000
        t_end = t0 + e.get("dDurationMs", 0) / 1000
        for sg in e.get("segs") or []:
            text = sg.get("utf8", "").strip()
            if not text or text.startswith("["):
                continue
            words.append([text, t0 + sg.get("tOffsetMs", 0) / 1000, t_end, 1.0])
    # Captions only give each word's start. Estimate its length from its size,
    # so real pauses show up as gaps between words (and split sentences).
    for n, w in enumerate(words):
        nxt = words[n + 1][1] if n + 1 < len(words) else w[2]
        w[2] = max(w[1] + 0.1, min(nxt, w[1] + 0.12 + 0.065 * len(w[0])))
    return group_words([tuple(w) for w in words], max_gap=0.8, max_words=20)


def cues_to_sentences(cues):
    """Joins subtitle cues into whole sentences (a sentence often spans several cues)."""
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

    words = whisper_on_modal(wav)
    if words is not None:
        return group_whisper(words)

    model = WhisperModel(os.environ.get("WHISPER_MODEL") or "large-v3", device="cpu", compute_type="int8",
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

    return group_whisper(words)


def whisper_on_modal(wav):
    """Whisper large-v3 on a Modal GPU (scripts/modal/asr.py) when the Modal
    secrets are set; None means "do it here on the CPU instead"."""
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return None
    try:
        import modal
        from types import SimpleNamespace

        opus = os.path.join(OUT, "audio.ogg")   # ~20x smaller than the WAV to send
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
                        "-c:a", "libopus", "-b:a", "48k", opus], check=True)
        t0 = time.time()
        print("Transcribing on a Modal GPU…", flush=True)
        fn = modal.Function.from_name("nativnik-asr", "whisper")
        raw = fn.remote(open(opus, "rb").read(), ".ogg", "ru")
        print(f"  done in {time.time() - t0:.0f}s ({len(raw)} words)", flush=True)
        return [SimpleNamespace(word=w, start=a, end=b, probability=p) for w, a, b, p in raw]
    except Exception as e:  # noqa: BLE001
        print(f"::warning::Modal GPU unavailable ({e}); transcribing on the CPU instead", flush=True)
        return None


def group_whisper(words):
    sentences, cur = [], []

    def flush():
        if cur:
            sentences.append({
                "start": cur[0].start,
                "end": cur[-1].end,
                "text": "".join(w.word for w in cur).strip(),
                # Per-word timings and Whisper's confidence (0-1) in each word.
                "words": [[w.word.strip(), round(w.start, 2), round(w.end, 2), round(w.probability, 3)]
                          for w in cur],
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


def captions_main():
    info = {}
    if os.path.exists(os.path.join(OUT, "media.info.json")):
        with open(os.path.join(OUT, "media.info.json"), encoding="utf-8") as f:
            info = json.load(f)
    manual_langs = set(info.get("subtitles") or {})
    # Prefer the plain "ru" track (creator captions win over automatic ones there).
    files = sorted(glob.glob(os.path.join(OUT, "media.ru*.json3")), key=lambda p: (not p.endswith("media.ru.json3"), p))
    if not files:
        with open(os.path.join(OUT, "error.txt"), "w") as f:
            f.write("This video has no Russian captions on YouTube (neither the creator's nor automatic ones).")
        sys.exit(1)
    path = files[0]
    lang = os.path.basename(path)[len("media."):-len(".json3")]
    manual = lang in manual_langs
    sentences = from_json3(path, manual)
    source = "creator-captions" if manual else "auto-captions"
    print(f"Using YouTube {'creator' if manual else 'automatic'} captions ({lang}): {len(sentences)} sentences")
    return sentences, source


def main():
    if os.environ.get("ENGINE") == "captions":
        sentences, source = captions_main()
        finish(sentences, source)
        return

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
        print(f"Transcribing with Whisper ({os.environ.get('WHISPER_MODEL') or 'large-v3'})…", flush=True)
        sentences = from_whisper(video)
    finish(sentences, source)


def finish(sentences, source):
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
