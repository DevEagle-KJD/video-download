"""Adds the three study lines to every sentence and writes out/lesson.json.

For each Russian sentence Claude returns:
  - the words with stress marks (молоко́), each with its literal meaning in
    this context ("to-me", "it-seems"), its dictionary form and its general
    meaning; set phrases grouped as one unit
  - a natural English translation
Each word then gets its own start/end time (from Whisper's word timings, or
estimated) so the app can highlight words as they're spoken.

Without an ANTHROPIC_API_KEY the lesson is still written, with plain words and
no translations, so the video and tap-to-replay transcript still work.
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import unicodedata

OUT = "out"
BATCH = 25
MODEL = os.environ.get("STUDY_MODEL") or "claude-opus-5"

SYSTEM = """You prepare Russian video transcripts for an English speaker who learns Russian by sentence mining: real spoken sentences, heard and repeated, never grammar lessons.

For every sentence you are given, return:
1. tokens: the sentence split into words, in order, each with:
   - w: the word exactly as transcribed, plus a stress mark: a combining acute accent (U+0301) right after the stressed vowel of every word with two or more syllables (молоко́, по́мнишь, говори́т). Don't mark ё (it is always stressed) or one-syllable words. Keep attached punctuation on the word (e.g. "пра́в." or "Приве́т,").
   - g: the literal English meaning of that word in THIS sentence, short and hyphenated when it takes several English words ("to-me", "it-seems", "there's-no", "(they)-call"). Mirror the Russian closely so the learner sees how Russian builds the idea; don't smooth it into natural English. Never mention grammar terms (no "genitive", "perfective", etc.).
   - When a few words form a fixed phrase whose word-by-word meaning would mislead (да ладно, ну и что, как раз, всё равно), keep them together as ONE token (w with a space inside) and gloss the whole phrase literally, e.g. w "Да ла́дно" g "yes fine".
   - Words that are fillers (ну, вот, типа) still get a gloss ("well", "so", "like").
   - b: the word's dictionary form with a stress mark (книгу → "кни́га", говорю́ → "говори́ть", лучше → "хоро́ший"), or "" when the word is already in its dictionary form or is a fixed phrase.
   - m: a short general dictionary meaning of the word (1-4 English words, e.g. "book", "to speak, say"), for learning the word beyond this sentence.
2. en: a natural, idiomatic English translation of the whole sentence as a native speaker would say it.

Rules:
- Keep the Russian words exactly as transcribed (only add stress marks). Don't add, drop or correct words.
- Return every sentence you were given, with the same "i" numbers, in the same order.
- Use the earlier sentences only as context for meaning; don't return them."""

SCHEMA = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "tokens": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "w": {"type": "string"},
                                "g": {"type": "string"},
                                "b": {"type": "string"},
                                "m": {"type": "string"},
                            },
                            "required": ["w", "g", "b", "m"],
                            "additionalProperties": False,
                        },
                    },
                    "en": {"type": "string"},
                },
                "required": ["i", "tokens", "en"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}


def plain_tokens(text):
    return [{"w": w, "g": "", "b": "", "m": ""} for w in text.split()]


def norm(word):
    """Lowercase letters/digits only, without stress marks: "Пра́в." → "прав"."""
    word = unicodedata.normalize("NFD", word.lower()).replace("\u0301", "")
    word = unicodedata.normalize("NFC", word).replace("ё", "е")
    return re.sub(r"[^\w]", "", word)


def add_timings(tokens, sentence):
    """Gives every token "t": [start, end].

    Uses Whisper's word timings when the words line up; anything left over
    is estimated by spreading the gap over the words by length.
    """
    words = [(norm(w), a, b) for w, a, b in sentence.get("words") or [] if norm(w)]
    wi = 0
    for tok in tokens:
        parts = [p for p in (norm(x) for x in tok["w"].split()) if p]
        times = []
        for part in parts:
            # Look a few words ahead in case Whisper split or merged differently.
            for j in range(wi, min(wi + 4, len(words))):
                if words[j][0] == part or words[j][0].startswith(part) or part.startswith(words[j][0]):
                    times.append((words[j][1], words[j][2]))
                    wi = j + 1
                    break
        tok["t"] = [times[0][0], times[-1][1]] if times else None

    # Fill the gaps proportionally to word length.
    n = len(tokens)
    i = 0
    while i < n:
        if tokens[i]["t"]:
            i += 1
            continue
        j = i
        while j < n and not tokens[j]["t"]:
            j += 1
        lo = tokens[i - 1]["t"][1] if i > 0 else sentence["start"]
        hi = tokens[j]["t"][0] if j < n else sentence["end"]
        hi = max(hi, lo + 0.05 * (j - i))
        lengths = [max(1, len(norm(t["w"]))) for t in tokens[i:j]]
        total, pos = sum(lengths), lo
        for k, L in zip(range(i, j), lengths):
            step = (hi - lo) * L / total
            tokens[k]["t"] = [pos, pos + step]
            pos += step
        i = j
    for tok in tokens:
        tok["t"] = [round(tok["t"][0], 2), round(tok["t"][1], 2)]
    return tokens


def enrich_batch(client, title, sentences, start, n=BATCH):
    """Returns {index: {"tokens": [...], "en": str}} for sentences[start:start+n]."""
    import anthropic

    batch = sentences[start:start + n]
    context = sentences[max(0, start - 3):start]
    lines = [f"Video title: {title}", ""]
    if context:
        lines.append("Earlier sentences (context only, don't return):")
        lines += [f"- {s['text']}" for s in context]
        lines.append("")
    lines.append("Sentences to prepare:")
    lines += [f"{start + k}. {s['text']}" for k, s in enumerate(batch)]

    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": "\n".join(lines)}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
    except anthropic.APIStatusError as e:
        print(f"  batch {start}: API error {e.status_code}: {e.message}", flush=True)
        return {}
    except anthropic.APIConnectionError as e:
        print(f"  batch {start}: connection error: {e}", flush=True)
        return {}

    if response.stop_reason != "end_turn":
        print(f"  batch {start}: stopped ({response.stop_reason})", flush=True)
        # Too long or declined: retry as two halves.
        if len(batch) > 1 and response.stop_reason in ("max_tokens", "refusal"):
            half = len(batch) // 2
            left = enrich_batch(client, title, sentences, start, half)
            right = enrich_batch(client, title, sentences, start + half, len(batch) - half)
            return {**left, **right}
        return {}

    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        print(f"  batch {start}: unreadable JSON", flush=True)
        return {}

    result = {}
    for s in data.get("sentences", []):
        i = s.get("i")
        if isinstance(i, int) and start <= i < start + len(batch) and s.get("tokens"):
            result[i] = {"tokens": s["tokens"], "en": s.get("en", "")}
    print(f"  batch {start}: {len(result)}/{len(batch)} sentences", flush=True)
    return result


def main():
    with open(os.path.join(OUT, "sentences.json"), encoding="utf-8") as f:
        data = json.load(f)
    sentences = data["sentences"]

    info = {}
    if os.path.exists(os.path.join(OUT, "media.info.json")):
        with open(os.path.join(OUT, "media.info.json"), encoding="utf-8") as f:
            info = json.load(f)
    title = info.get("title") or "Russian video"

    enriched = {}
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic

        client = anthropic.Anthropic(max_retries=4)
        print(f"Adding stress, literal meanings and translations with {MODEL} "
              f"({len(sentences)} sentences)…", flush=True)
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(enrich_batch, client, title, sentences, start)
                       for start in range(0, len(sentences), BATCH)]
            for fut in cf.as_completed(futures):
                enriched.update(fut.result())
    else:
        print("::warning::No ANTHROPIC_API_KEY secret: lesson will have no translations")

    lesson = {
        "title": title,
        "url": os.environ.get("URL", ""),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "source": data.get("source"),
        "model": MODEL if enriched else None,
        "enriched": len(enriched),
        "sentences": [],
    }
    for i, s in enumerate(sentences):
        e = enriched.get(i)
        tokens = e["tokens"] if e else plain_tokens(s["text"])
        lesson["sentences"].append({
            "start": s["start"],
            "end": s["end"],
            "ru": s["text"],
            "tokens": add_timings(tokens, s),
            "en": e["en"] if e else "",
        })

    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"lesson.json: {len(sentences)} sentences, {len(enriched)} with translations")


if __name__ == "__main__":
    sys.exit(main())
