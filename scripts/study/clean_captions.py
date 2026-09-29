"""Captions-only test: Claude cleans up YouTube's automatic captions.

Automatic captions have no punctuation or capitals and some misrecognised
words. With no audio to re-listen to (the captions-only mode downloads none),
Claude works from the text and context alone:
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

OUT = "out"
BATCH = 20

SYSTEM = """You clean up YouTube's automatic Russian captions for language learners, who will study every word, so accuracy matters more than anything.

The captions have no punctuation or capital letters, and the speech recogniser sometimes writes a wrong word (usually one that sounds similar). You can't hear the audio; work from the text, the neighbouring sentences and the video's title/description.

For each sentence, return:
- text: the sentence with correct punctuation and capitalisation, and with any clearly misrecognised word replaced by the word that was almost certainly said. Keep the speaker's real words, including colloquial speech, fillers, repetitions and small grammar slips; don't "improve" what was said. Don't add or remove words except to fix a clear recognition error. Keep the same words in the same order otherwise.
- changed: every word in your text that differs from the caption apart from punctuation/capitals (exactly as written in your text).
- unsure: words in your text you can't be confident about (e.g. a word that doesn't fit but has no obvious fix, an unclear name). Be honest; use [] when confident.
Return every sentence you were given, with the same "i" numbers."""

SCHEMA = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "text": {"type": "string"},
                    "changed": {"type": "array", "items": {"type": "string"}},
                    "unsure": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["i", "text", "changed", "unsure"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}


def clean_batch(client, title, description, sentences, idx):
    import anthropic

    lines = [f"Video title: {title}"]
    if description:
        lines.append(f"Video description: {description[:1200]}")
    lines.append("")
    for i in idx:
        prev = sentences[i - 1]["text"] if i > 0 else ""
        nxt = sentences[i + 1]["text"] if i + 1 < len(sentences) else ""
        lines += [f"Sentence {i}:", f"  before: {prev}", f"  caption: {sentences[i]['text']}", f"  after: {nxt}", ""]
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
        print(f"  batch {idx[0]}: API error: {e}", flush=True)
        return {}
    if response.stop_reason != "end_turn":
        print(f"  batch {idx[0]}: stopped ({response.stop_reason})", flush=True)
        return {}
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return {r["i"]: r for r in json.loads(text).get("sentences", []) if r.get("i") in idx}
    except json.JSONDecodeError:
        return {}


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
        print(f"Cleaning up {len(sentences)} automatic-caption sentences with {MODEL}…", flush=True)
        batches = [list(range(k, min(k + BATCH, len(sentences)))) for k in range(0, len(sentences), BATCH)]
        results = {}
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            for r in pool.map(lambda b: clean_batch(client, info.get("title", ""), info.get("description", ""), sentences, b), batches):
                results.update(r)

        changed_words = rejected = 0
        for i, s in enumerate(sentences):
            r = results.get(i)
            if not r or not r["text"].strip():
                continue
            old = [norm(w) for w in s["text"].split()]
            new = [norm(w) for w in r["text"].split()]
            # Guard rail: a cleanup that rewrites much of the sentence is rejected.
            if difflib.SequenceMatcher(a=old, b=new, autojunk=False).ratio() < 0.6:
                rejected += 1
                continue
            # Original caption words, to show the learner what YouTube wrote.
            alts = {}
            for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
                if op != "equal":
                    for w in r["text"].split()[j1:j2]:
                        alts[norm(w)] = " ".join(s["text"].split()[i1:i2])
            s["text"] = " ".join(r["text"].split())
            flags = []
            for w in r.get("changed", []):
                if norm(w):
                    changed_words += 1
                    flags.append({"w": norm(w), "alt": alts.get(norm(w), ""),
                                  "note": "Corrected from YouTube's automatic captions (not checked against the audio)."})
            for w in r.get("unsure", []):
                if norm(w) and norm(w) not in {f["w"] for f in flags}:
                    flags.append({"w": norm(w), "alt": alts.get(norm(w), ""),
                                  "note": "This word may have been misrecognised in YouTube's automatic captions."})
            s["flags"] = flags
        checks.update({"captions_cleaned": len(results), "captions_changed_words": changed_words,
                       "captions_rejected": rejected})
        print(f"Cleanup: {len(results)} sentences, {changed_words} words corrected, {rejected} rejected by the guard rail")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
