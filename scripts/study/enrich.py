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
MODEL = os.environ.get("STUDY_MODEL") or "claude-sonnet-5"

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


REVIEW_SYSTEM = """You are a meticulous Russian teacher doing the final check of a lesson before learners study it. Learners trust every mark, so find and fix real mistakes.

Each sentence comes with its tokens as [word with stress mark, literal meaning here, dictionary form, general meaning] and a natural English translation. Some tokens also have a second opinion on the stress from a stress-dictionary tool (RUAccent); it's usually right for ordinary words but can be wrong for names, homographs (за́мок/замо́к, до́ма/дома́) and context.

Check every sentence for:
- wrong or missing stress marks (words of 2+ syllables need exactly one acute accent U+0301 on the stressed vowel; ё needs none),
- a literal meaning that doesn't fit how the word is used in THIS sentence,
- a wrong dictionary form or general meaning,
- an English translation that is wrong, misses meaning, or sounds unnatural.

Return only the fixes:
- fixes: tokens to correct, with sentence i, token k and the full corrected w, g, b, m. In w you may only change the stress mark, never the letters.
- en: sentences whose English translation should be replaced.
- flags: tokens that you believe may be wrong but can't settle (e.g. an unclear name), with a short note for the learner.
Return empty lists when a batch is already correct. Don't rewrite things that are merely a matter of style."""

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "fixes": {"type": "array", "items": {"type": "object", "properties": {
            "i": {"type": "integer"}, "k": {"type": "integer"},
            "w": {"type": "string"}, "g": {"type": "string"}, "b": {"type": "string"}, "m": {"type": "string"}},
            "required": ["i", "k", "w", "g", "b", "m"], "additionalProperties": False}},
        "en": {"type": "array", "items": {"type": "object", "properties": {
            "i": {"type": "integer"}, "en": {"type": "string"}},
            "required": ["i", "en"], "additionalProperties": False}},
        "flags": {"type": "array", "items": {"type": "object", "properties": {
            "i": {"type": "integer"}, "k": {"type": "integer"}, "note": {"type": "string"}},
            "required": ["i", "k", "note"], "additionalProperties": False}},
    },
    "required": ["fixes", "en", "flags"],
    "additionalProperties": False,
}

VOWELS = "аеёиоуыэюя"


def stress_pos(word):
    """Index of the stressed vowel (count of vowels before it), or None."""
    n = 0
    for ch in unicodedata.normalize("NFD", word.lower()):
        if ch == "\u0301":
            return n - 1
        if ch in VOWELS:
            n += 1
    return None


def syllable_count(word):
    return sum(ch in VOWELS for ch in plain(word).lower())


def plain(word):
    return unicodedata.normalize("NFC", unicodedata.normalize("NFD", word).replace("\u0301", ""))


def load_ruaccent():
    try:
        from ruaccent import RUAccent

        acc = RUAccent()
        acc.load(omograph_model_size="turbo", use_dictionary=True)
        return acc
    except Exception as e:  # noqa: BLE001
        print(f"::warning::RUAccent unavailable for the stress double-check: {e}")
        return None


def ruaccent_words(acc, text):
    """RUAccent's stressed version of a sentence, split like the tokens."""
    out, i, marked = [], 0, acc.process_all(text)
    res = []
    while i < len(marked):
        if marked[i] == "+" and i + 1 < len(marked):
            res.append(marked[i + 1] + "\u0301")
            i += 2
        else:
            res.append(marked[i])
            i += 1
    return "".join(res).split()


def mark_flags(tokens, sentence):
    """Copies transcription doubts onto the tokens as "u" (shown to the learner)."""
    for f in sentence.get("flags") or []:
        for tok in tokens:
            if "u" not in tok and f["w"] and f["w"] in [norm(x) for x in tok["w"].split()]:
                tok["u"] = {"alt": f.get("alt", ""), "note": "The two transcribers didn't agree on this word."
                            if f.get("alt") else "This word may have been misheard."}
                break
    return tokens


def review_batch(client, lesson_sentences, hints, idx):
    """Check 3: returns (fixes, en_fixes, flags) for sentences idx."""
    import anthropic

    items = []
    for i in idx:
        s = lesson_sentences[i]
        item = {"i": i, "tokens": [[t["w"], t.get("g", ""), t.get("b", ""), t.get("m", "")] for t in s["tokens"]], "en": s["en"]}
        if hints.get(i):
            item["ruaccent"] = {str(k): w for k, w in hints[i].items()}
        items.append(item)
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=REVIEW_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(items, ensure_ascii=False)}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": REVIEW_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        print(f"  review batch {idx[0]}: API error: {e}", flush=True)
        return [], [], []
    if response.stop_reason != "end_turn":
        print(f"  review batch {idx[0]}: stopped ({response.stop_reason})", flush=True)
        return [], [], []
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return [], [], []
    ok = set(idx)
    return ([f for f in data.get("fixes", []) if f.get("i") in ok],
            [e for e in data.get("en", []) if e.get("i") in ok],
            [f for f in data.get("flags", []) if f.get("i") in ok])


def review(client, lesson_sentences):
    """Check 3: second-opinion stress (RUAccent) + a Claude review pass."""
    acc = load_ruaccent()
    hints = {}
    if acc:
        for i, s in enumerate(lesson_sentences):
            try:
                ra = ruaccent_words(acc, s["ru"])
            except Exception:  # noqa: BLE001
                continue
            if len(ra) != len(s["tokens"]):
                continue
            for k, (tok, alt) in enumerate(zip(s["tokens"], ra)):
                if " " in tok["w"] or syllable_count(tok["w"]) < 2:
                    continue
                if norm(alt) == norm(tok["w"]) and stress_pos(alt) is not None and stress_pos(alt) != stress_pos(tok["w"]):
                    hints.setdefault(i, {})[k] = alt
        print(f"RUAccent disagrees on stress in {sum(len(h) for h in hints.values())} words; sending them for review")

    batches = [list(range(k, min(k + BATCH, len(lesson_sentences)))) for k in range(0, len(lesson_sentences), BATCH)]
    n_fix = n_en = n_flag = 0
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        for fixes, ens, flags in pool.map(lambda b: review_batch(client, lesson_sentences, hints, b), batches):
            for f in fixes:
                toks = lesson_sentences[f["i"]]["tokens"]
                if not 0 <= f["k"] < len(toks):
                    continue
                tok = toks[f["k"]]
                if norm(f["w"]) == norm(tok["w"]):      # only the stress may change, never the letters
                    tok["w"] = f["w"]
                tok["g"], tok["b"], tok["m"] = f["g"], f["b"], f["m"]
                n_fix += 1
            for e in ens:
                if e["en"].strip():
                    lesson_sentences[e["i"]]["en"] = e["en"].strip()
                    n_en += 1
            for f in flags:
                toks = lesson_sentences[f["i"]]["tokens"]
                if 0 <= f["k"] < len(toks) and "u" not in toks[f["k"]]:
                    toks[f["k"]]["u"] = {"alt": "", "note": f["note"]}
                    n_flag += 1
    print(f"Review: {n_fix} word fixes, {n_en} translations improved, {n_flag} words flagged")
    return {"review_word_fixes": n_fix, "review_translation_fixes": n_en, "review_flags": n_flag}


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
    words = [(norm(w[0]), w[1], w[2]) for w in sentence.get("words") or [] if norm(w[0])]
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
        "engine": "ai",
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
            "tokens": mark_flags(add_timings(tokens, s), s),
            "en": e["en"] if e else "",
        })

    checks = dict(data.get("checks") or {})
    if enriched:
        checks.update(review(client, lesson["sentences"]))
    checks["flagged_words"] = sum("u" in t for s in lesson["sentences"] for t in s["tokens"])
    lesson["checks"] = checks

    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"lesson.json: {len(sentences)} sentences, {len(enriched)} with translations, "
          f"{checks['flagged_words']} words flagged for the learner")


if __name__ == "__main__":
    sys.exit(main())
