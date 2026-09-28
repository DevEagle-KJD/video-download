"""Check 1: a second, independent transcriber listens to every sentence.

Whisper's words are compared with the second transcriber's words. A word is
"doubtful" when the two disagree, or when Whisper itself wasn't sure of it.
Doubtful words are written to sentences.json ("doubts") for Claude to settle
(proofread.py) and, if still unsure, for the app to flag to the user.

Second transcriber per language (only Russian so far):
  ru: GigaAM v3 (Sber, open-source, trained on Russian speech)

Skipped when the transcript came from the video's own human-made subtitles.
"""
import difflib
import json
import os
import sys
import tempfile
import time
import wave

sys.path.insert(0, os.path.dirname(__file__))
from enrich import norm  # noqa: E402

OUT = "out"
LANG = os.environ.get("STUDY_LANG") or "ru"
SECOND = {"ru": ("GigaAM v3", "v3_e2e_rnnt")}
LOW_CONFIDENCE = 0.25      # Whisper probability below which a word is doubtful even if both agree
MAX_CLIP = 22.0            # GigaAM's short-form limit is ~25 s


def load_model():
    name, model_id = SECOND[LANG]
    import gigaam

    return name, gigaam.load_model(model_id, device="cpu", fp16_encoder=False)


def clip_texts(model, wav_path, start, end, rate, frames):
    """Transcribes [start, end] of the 16 kHz mono WAV, in ≤22 s pieces."""
    texts = []
    t = max(0.0, start - 0.2)
    end = end + 0.2
    while t < end:
        stop = min(end, t + MAX_CLIP)
        a, b = int(t * rate) * 2, int(stop * rate) * 2
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = tmp.name
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(frames[a:b])
        try:
            texts.append(model.transcribe(path).text.strip())
        finally:
            os.unlink(path)
        t = stop
    return " ".join(x for x in texts if x)


def compare(words, alt_text):
    """Returns (doubts, agreement) for Whisper words vs the second transcript."""
    a = [norm(w[0]) for w in words]
    alt_words = alt_text.split()
    b = [norm(w) for w in alt_words]
    doubts = {}
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        heard = " ".join(alt_words[j1:j2])
        if op == "insert":
            # The second transcriber heard extra words here; doubt the neighbour.
            k = i1 if i1 < len(words) else i1 - 1
            if k >= 0:
                doubts.setdefault(k, {"i": k, "heard": heard, "why": "extra"})
            continue
        for k in range(i1, i2):
            doubts[k] = {"i": k, "heard": heard, "why": "differs"}
    for k, w in enumerate(words):
        p = w[3] if len(w) > 3 else 1.0
        if p < LOW_CONFIDENCE and k not in doubts:
            doubts[k] = {"i": k, "heard": "", "why": "low confidence"}
    agree = sm.ratio() if a or b else 1.0
    return sorted(doubts.values(), key=lambda d: d["i"]), agree


def main():
    path = os.path.join(OUT, "sentences.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    sentences = data["sentences"]

    if data.get("source") == "subtitles":
        print("Transcript is from the video's own subtitles; no second check needed.")
        return
    if LANG not in SECOND:
        print(f"No second transcriber set up for '{LANG}' yet; skipping.")
        return
    wav = os.path.join(OUT, "audio.wav")
    if not os.path.exists(wav):
        print("::warning::No audio.wav; skipping second transcriber")
        return

    try:
        name, model = load_model()
    except Exception as e:  # noqa: BLE001
        print(f"::warning::Second transcriber unavailable ({e}); lesson continues with Whisper only")
        return
    print(f"Second transcriber: {name}")

    with wave.open(wav) as w:
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())

    t0, doubtful, agree_sum = time.time(), 0, 0.0
    for n, s in enumerate(sentences):
        try:
            alt = clip_texts(model, wav, s["start"], s["end"], rate, frames)
        except Exception as e:  # noqa: BLE001
            print(f"  sentence {n}: second transcriber failed: {e}")
            continue
        doubts, agree = compare(s.get("words") or [[w, 0, 0, 1] for w in s["text"].split()], alt)
        s["alt"] = alt
        s["doubts"] = doubts
        doubtful += bool(doubts)
        agree_sum += agree
        if n % 50 == 0:
            print(f"  {n}/{len(sentences)} sentences ({time.time() - t0:.0f}s)", flush=True)

    data["checks"] = {
        "second": name,
        "agreement": round(agree_sum / max(1, len(sentences)), 3),
        "doubtful_sentences": doubtful,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Agreement {data['checks']['agreement']:.1%}; {doubtful} of {len(sentences)} sentences have doubtful words")


if __name__ == "__main__":
    main()
