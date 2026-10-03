"""Whisper large-v3 on a Modal GPU: the slow step of making a lesson (about
13 min on GitHub's CPU, 1-2 min here).

Deployed by .github/workflows/modal-deploy.yml whenever this file changes
(needs the MODAL_TOKEN_ID / MODAL_TOKEN_SECRET secrets). scripts/study/transcribe.py
calls it when those secrets are present and falls back to the CPU if anything fails.

Input: the lesson audio (any format ffmpeg reads; small Opus file).
Output: every word as [text, start, end, probability], same settings as the CPU run.
"""
import modal

APP = "nativnik-asr"
MODEL = "large-v3"

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg")
    .pip_install("faster-whisper>=1.1", "av<19")
    # Bake the model into the image so a cold start doesn't download 3 GB.
    .run_commands(f"python -c \"from faster_whisper import WhisperModel; WhisperModel('{MODEL}', device='cpu', compute_type='int8')\"")
)

app = modal.App(APP, image=image)


@app.function(gpu="L4", timeout=1800, scaledown_window=60)
def whisper(audio: bytes, suffix: str = ".ogg", language: str = "ru") -> list:
    import tempfile
    from faster_whisper import WhisperModel

    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(audio)
        f.flush()
        model = WhisperModel(MODEL, device="cuda", compute_type="float16")
        segments, info = model.transcribe(
            f.name, language=language, beam_size=5, vad_filter=True,
            word_timestamps=True, condition_on_previous_text=False,
        )
        words = []
        for seg in segments:
            words.extend([w.word, w.start, w.end, w.probability] for w in seg.words or [])
    print(f"{len(words)} words from {info.duration / 60:.1f} min of audio")
    return words
