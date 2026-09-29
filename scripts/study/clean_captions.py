"""Captions-only test: Claude cleans up YouTube's automatic captions.

Automatic captions have no punctuation or capitals and some misrecognised
words. With no audio to re-listen to (the captions-only mode downloads none),
Claude works from the text and context alone:
  - splits the word stream into real sentences (YouTube's caption lines and
    pauses don't follow sentences, so a word like "вкусно" could end up in
    the wrong sentence); the timings still come from the caption words,
  - restores punctuation and capitalisation,
  - fixes words that are clearly misrecognised,
  - lists every word it changed and every word it's still unsure of.
Those words are flagged for the learner ("may not be accurate"), with the
original caption word shown for changed ones.

Creator-made captions are left as they are. Without an API key, automatic
captions are used as-is (every lesson from them is lower accuracy).
"""
import concurrent.futures as cf
import difflib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from enrich import MODEL, norm  # noqa: E402
from transcribe import group_words  # noqa: E402

OUT = "out"

CHUNK = 150          # caption words per request (split at pauses)

SYSTEM = """You turn YouTube's automatic Russian captions into clean sentences for language learners, who will study every word, so accuracy matters more than anything.

The captions are a stream of words with no punctuation, no capital letters and no sentence breaks, and the speech recogniser sometimes writes a wrong word (usually one that sounds similar). You can't hear the audio; work from the text, the context and the video's title/description. "(pause)" marks a silence in the speech.

Split the numbered words into sentences, in order, covering every word exactly once. Each sentence gives "from" and "to", the numbers of its first and last word. Make them sentences a learner can study one at a time: end one where the speaker ends a sentence or a question; split long run-on speech at natural breaks (about 12 words or fewer when the speech allows it); never join words across a change of speaker when you can tell; keep a short reply ("Да.", "Вкусно!") as its own sentence or attached to the sentence it belongs to. A word must go with the sentence it belongs to in meaning (e.g. "пахнет вкусно" stays together).

For each sentence return:
- text: its words with correct punctuation and capitalisation, and with any clearly misrecognised word replaced by the word that was almost certainly said. Keep the speaker's real words, including colloquial speech, fillers, repetitions and small grammar slips; don't "improve" what was said. Don't add or remove words except to fix a clear recognition error, and keep them in the same order. Only change a word when the caption word clearly can't be right; a word that makes sense stays, even if another word would fit the topic better.
- changed: every word in your text that differs from the caption apart from punctuation/capitals (exactly as written in your text).
- unsure: words in your text you can't be confident about (e.g. a word that doesn't fit but has no obvious fix, an unclear name). Be honest; use [] when confident."""

SCHEMA = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                    "text": {"type": "string"},
                    "changed": {"type": "array", "items": {"type": "string"}},
                    "unsure": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["from", "to", "text", "changed", "unsure"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}


def chunks_of(words):
    """Word index lists of about CHUNK words, cut at pauses (usually sentence ends)."""
    out, cur = [], []
    for k, w in enumerate(words):
        cur.append(k)
        gap = words[k + 1][1] - w[2] if k + 1 < len(words) else 99
        if (len(cur) >= CHUNK * 0.6 and gap > 1.0) or len(cur) >= CHUNK:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def clean_chunk(client, title, description, words, idx, before):
    """Claude splits one chunk of caption words into cleaned sentences.
    Returns [(from, to, result)] with indices into `words`, or None."""
    import anthropic

    lines = [f"Video title: {title}"]
    if description:
        lines.append(f"Video description: {description[:1200]}")
    if before:
        lines.append(f"Just before this part (context only): …{before}")
    lines.append("")
    parts = []
    for n, k in enumerate(idx):
        parts.append(f"[{n}] {words[k][0]}")
        if n + 1 < len(idx) and words[idx[n + 1]][1] - words[k][2] > 0.5:
            parts.append("(pause)")
    lines.append("Words: " + " ".join(parts))
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
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        print(f"  chunk at word {idx[0]}: API error: {e}", flush=True)
        return None
    if response.stop_reason != "end_turn":
        print(f"  chunk at word {idx[0]}: stopped ({response.stop_reason})", flush=True)
        return None
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        got = sorted(json.loads(text).get("sentences", []), key=lambda r: r["from"])
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    # The sentences must cover every word once, in order.
    expect = 0
    for r in got:
        if r["from"] != expect or r["to"] < r["from"] or r["to"] >= len(idx):
            print(f"  chunk at word {idx[0]}: sentences don't line up with the words; kept as is", flush=True)
            return None
        expect = r["to"] + 1
    if expect != len(idx):
        print(f"  chunk at word {idx[0]}: some words were left out; kept as is", flush=True)
        return None
    return [(idx[r["from"]], idx[r["to"]], r) for r in got]


def make_sentence(words, a, b, r):
    """One lesson sentence from caption words a..b and Claude's cleanup r (or None).
    Returns (sentence, changed word count, rejected?)."""
    span = words[a:b + 1]
    raw = " ".join(w[0] for w in span)
    s = {"start": span[0][1], "end": span[-1][2], "text": raw, "words": span}
    if not r or not r["text"].strip():
        return s, 0, False
    old = [norm(w) for w in raw.split()]
    new = [norm(w) for w in r["text"].split()]
    # Guard rail: a cleanup that rewrites much of the sentence is rejected.
    if difflib.SequenceMatcher(a=old, b=new, autojunk=False).ratio() < 0.6:
        return s, 0, True
    # Original caption words, to show the learner what YouTube wrote.
    alts = {}
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if op != "equal":
            for w in r["text"].split()[j1:j2]:
                alts[norm(w)] = " ".join(raw.split()[i1:i2])
    s["text"] = " ".join(r["text"].split())
    flags, changed = [], 0
    for w in r.get("changed", []):
        if norm(w):
            changed += 1
            flags.append({"w": norm(w), "alt": alts.get(norm(w), ""),
                          "note": "Corrected from YouTube's automatic captions (not checked against the audio)."})
    for w in r.get("unsure", []):
        if norm(w) and norm(w) not in {f["w"] for f in flags}:
            flags.append({"w": norm(w), "alt": alts.get(norm(w), ""),
                          "note": "This word may have been misrecognised in YouTube's automatic captions."})
    s["flags"] = flags
    return s, changed, False


def main():
    path = os.path.join(OUT, "sentences.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    sentences = data["sentences"]
    checks = data.setdefault("checks", {})
    checks["captions"] = data.get("source")

    if data.get("source") != "auto-captions":
        print("Creator captions: used as they are.")
    elif not os.environ.get("ANTHROPIC_API_KEY"):
        print("::warning::No ANTHROPIC_API_KEY: automatic captions used without cleanup")
    else:
        import anthropic

        info = {}
        if os.path.exists(os.path.join(OUT, "media.info.json")):
            with open(os.path.join(OUT, "media.info.json"), encoding="utf-8") as f:
                info = json.load(f)
        client = anthropic.Anthropic(max_retries=4)
        words = [w for s in sentences for w in s.get("words") or []]
        chunks = chunks_of(words)
        print(f"Cleaning up {len(words)} automatic-caption words ({len(chunks)} parts) with {MODEL}…", flush=True)

        def run(idx):
            before = " ".join(w[0] for w in words[max(0, idx[0] - 30):idx[0]])
            return idx, clean_chunk(client, info.get("title", ""), info.get("description", ""), words, idx, before)

        out, changed_words, rejected, cleaned, kept = [], 0, 0, 0, 0
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            for idx, got in pool.map(run, chunks):
                if got is None:
                    # Fall back to the pause-based sentences, uncleaned.
                    kept += 1
                    for g in group_words([tuple(words[k]) for k in idx], max_gap=0.8, max_words=20):
                        out.append(g)
                    continue
                for a_, b_, r in got:
                    s, n, rej = make_sentence(words, a_, b_, r)
                    out.append(s)
                    changed_words += n
                    rejected += rej
                    cleaned += 1
        data["sentences"] = sentences = out
        checks.update({"captions_cleaned": cleaned, "captions_changed_words": changed_words,
                       "captions_rejected": rejected, "captions_parts_uncleaned": kept})
        print(f"Cleanup: {len(out)} sentences ({cleaned} cleaned), {changed_words} words corrected, "
              f"{rejected} rejected by the guard rail, {kept} parts left as they were")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
