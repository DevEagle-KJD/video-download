"""Check 2: Claude settles the words the two transcribers disagreed on.

For each sentence with doubtful words, Claude sees Whisper's version (doubtful
words marked), the second transcriber's version, the neighbouring sentences
and the video's title/description, and returns the corrected sentence plus
any words it still isn't sure about.

Guard rail: Claude may only change doubtful words. If its answer changes any
other word, the correction is thrown away and the doubts stay flagged.
Claude can't hear the audio, so when it can't tell, the word stays flagged
for the learner instead of being guessed.

Writes "flags" (words still doubtful) into sentences.json. Without an API key
(or with the free engine) every doubtful word simply becomes a flag.
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

SYSTEM = """You proofread automatic transcripts of Russian videos for language learners, who will study every word, so accuracy matters more than anything.

Two independent speech recognisers transcribed each sentence. You get:
- A: the main transcript, with doubtful words marked like ⟦word⟧ (the recognisers disagreed there, or the main one was unsure),
- B: the second recogniser's version of the same audio (lowercase or punctuation may differ),
- the neighbouring sentences and the video's title/description for context.

For each sentence, return the most likely correct sentence as it was actually spoken:
- Only change the ⟦marked⟧ words: keep them, replace them, remove them, or add a missing word right next to one. Copy every unmarked word exactly as it is, in the same order.
- Use B, the context, and what makes sense in natural spoken Russian. Prefer the version that fits the meaning of the conversation.
- Keep the speaker's actual words, including colloquial speech, fillers and small grammar slips; don't "improve" what was said.
- Return the text without the ⟦ ⟧ marks, with normal punctuation.
- unsure: the words in your corrected sentence (exactly as written there) that you still can't be confident about. Be honest: if A and B disagree and nothing in the context settles it, list the word. Use [] when you're confident.
- Return every sentence you were given, with the same "i" numbers."""

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
                    "unsure": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["i", "text", "unsure"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}


def marked(s):
    words = s["text"].split()
    doubt = {d["i"] for d in s.get("doubts", [])}
    return " ".join(f"⟦{w}⟧" if k in doubt else w for k, w in enumerate(words))


def only_doubtful_changed(s, new_text):
    """True when every change in new_text touches a doubtful word (or sits beside one)."""
    old = [norm(w) for w in s["text"].split()]
    new = [norm(w) for w in new_text.split()]
    doubt = {d["i"] for d in s.get("doubts", [])}
    for op, i1, i2, _, _ in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op == "insert":
            if not ({i1 - 1, i1} & doubt):
                return False
        elif not all(k in doubt for k in range(i1, i2)):
            return False
    return True


def flags_from_doubts(s):
    words = s["text"].split()
    return [{"w": norm(words[d["i"]]), "alt": d.get("heard", ""), "why": d.get("why", "")}
            for d in s.get("doubts", []) if d["i"] < len(words)]


def proofread_batch(client, title, description, sentences, idx):
    import anthropic

    lines = [f"Video title: {title}"]
    if description:
        lines.append(f"Video description: {description[:1200]}")
    lines.append("")
    for i in idx:
        s = sentences[i]
        prev = sentences[i - 1]["text"] if i > 0 else ""
        nxt = sentences[i + 1]["text"] if i + 1 < len(sentences) else ""
        lines += [f"Sentence {i}:", f"  before: {prev}", f"  A: {marked(s)}", f"  B: {s.get('alt', '')}", f"  after: {nxt}", ""]
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
        print(f"  proofread batch {idx[0]}: API error: {e}", flush=True)
        return {}
    if response.stop_reason != "end_turn":
        print(f"  proofread batch {idx[0]}: stopped ({response.stop_reason})", flush=True)
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
    todo = [i for i, s in enumerate(sentences) if s.get("doubts")]

    use_ai = os.environ.get("ENGINE") == "ai" and os.environ.get("ANTHROPIC_API_KEY")
    fixed = kept = rejected = 0
    if todo and use_ai:
        import anthropic

        info = {}
        if os.path.exists(os.path.join(OUT, "media.info.json")):
            with open(os.path.join(OUT, "media.info.json"), encoding="utf-8") as f:
                info = json.load(f)
        client = anthropic.Anthropic(max_retries=4)
        print(f"Proofreading {len(todo)} sentences with doubtful words ({MODEL})…", flush=True)
        batches = [todo[k:k + BATCH] for k in range(0, len(todo), BATCH)]
        results = {}
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            for r in pool.map(lambda b: proofread_batch(client, info.get("title", ""), info.get("description", ""), sentences, b), batches):
                results.update(r)

        for i in todo:
            s = sentences[i]
            r = results.get(i)
            if not r:
                s["flags"] = flags_from_doubts(s)
                continue
            new_text = " ".join(r["text"].split())
            if not new_text or not only_doubtful_changed(s, new_text):
                rejected += 1
                s["flags"] = flags_from_doubts(s)
                continue
            old_words = s["text"].split()
            alts = {norm(old_words[d["i"]]): d.get("heard", "") for d in s["doubts"] if d["i"] < len(old_words)}
            if norm(new_text) != norm(s["text"]):
                fixed += 1
                s["text"] = new_text
            else:
                kept += 1
            s["flags"] = [{"w": norm(u), "alt": alts.get(norm(u), ""), "why": "still unsure after checking"}
                          for u in r.get("unsure", []) if norm(u)]
    else:
        if todo:
            print("No AI proofreading (free engine or no API key): doubtful words will be flagged for the learner.")
        for i in todo:
            sentences[i]["flags"] = flags_from_doubts(sentences[i])

    flagged = sum(len(s.get("flags", [])) for s in sentences)
    data.setdefault("checks", {}).update({"proofread_fixed": fixed, "proofread_confirmed": kept,
                                          "proofread_rejected": rejected, "flagged_words": flagged})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Proofread: {fixed} corrected, {kept} confirmed, {rejected} rejected by the guard rail; "
          f"{flagged} words still flagged for the learner")


if __name__ == "__main__":
    main()
