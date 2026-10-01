""""Say it like a native": how natives really say something the learner wants to say.

  python3 scripts/study/phrase.py prepare   # PHRASE env → out/sentences.json + out/phrase.json
  (then enrich.py adds stress marks, literal meanings, English and its review)
  python3 scripts/study/phrase.py finish    # merges out/phrase.json into out/lesson.json

1. Claude, acting as a native speaker, gives 1-3 everyday versions (casual / polite /
   anywhere) with a usage tip and its own confidence. If the learner typed Russian,
   it also says whether natives would say it like that.
2. A second, independent pass judges each version only by how people really talk
   ("natural" / "slightly off" / "unnatural") and offers a better wording.
   Unnatural versions are replaced; doubts become flags the learner sees.
3. Real speech: every sentence from the lessons made so far (real native audio,
   double-transcribed and checked) is searched for the same phrase, so the app can
   show "Heard in real videos" with the native's own voice.
"""
import glob
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(__file__))
from enrich import MODEL  # noqa: E402

OUT = "out"

GEN_SYSTEM = """You are a native Russian speaker helping an English speaker learn to talk like a native through real sentences, never grammar lessons.

The learner tells you something they want to be able to say: usually in English, sometimes in Russian they heard or wrote themselves.
Return how native Russians actually say it in everyday conversation today:
- 1 to 3 versions. Prefer what people really say out loud over textbook phrasing. When casual and polite speech differ, give a version for friends/family and a polite one for strangers/work; give a single version when one fits everywhere.
- For each version:
  - ru: the Russian, with normal punctuation and no stress marks;
  - context: "with friends", "polite" or "anywhere";
  - en: what it means, in natural English;
  - note: a short tip on when natives use it (at most 15 words, no grammar terms); "" if nothing useful to add;
  - confidence: "high" if natives commonly say exactly this, "medium" if it's natural but equally common alternatives exist, "low" if you're unsure.
- If the learner wrote Russian, also fill check: verdict "natural", "understandable but not natural" or "wrong", and a one-line comment in English. Include their wording as a version only if natives would really say it.
- If the learner wrote English, return check with verdict "" and comment "".
Never invent slang you're not sure of. If the request is ambiguous, use the most common meaning and mention it in a note."""

GEN_SCHEMA = {
    "type": "object",
    "properties": {
        "versions": {"type": "array", "items": {"type": "object", "properties": {
            "ru": {"type": "string"}, "context": {"type": "string"}, "en": {"type": "string"},
            "note": {"type": "string"}, "confidence": {"type": "string"}},
            "required": ["ru", "context", "en", "note", "confidence"], "additionalProperties": False}},
        "check": {"type": "object", "properties": {
            "verdict": {"type": "string"}, "comment": {"type": "string"}},
            "required": ["verdict", "comment"], "additionalProperties": False},
    },
    "required": ["versions", "check"],
    "additionalProperties": False,
}

REVIEW_SYSTEM = """You are a native Russian speaker. A tutor suggested these phrases to a learner who wants to sound like a native. Judge each one only by how real people talk today, in the given context.

For each phrase return:
- i: its number;
- verdict: "natural" (natives really say this), "slightly off" (understandable, but a native would usually put it differently) or "unnatural";
- better: how a native would actually say it, when the verdict isn't "natural" (else "");
- note: a short reason in plain English, no grammar terms (else "").
Be strict: textbook-correct but stiff wording is "slightly off"."""

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "reviews": {"type": "array", "items": {"type": "object", "properties": {
            "i": {"type": "integer"}, "verdict": {"type": "string"},
            "better": {"type": "string"}, "note": {"type": "string"}},
            "required": ["i", "verdict", "better", "note"], "additionalProperties": False}},
    },
    "required": ["reviews"],
    "additionalProperties": False,
}


def ask(client, system, content, schema):
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": schema}},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason != "end_turn":
        raise RuntimeError(f"Claude stopped early ({response.stop_reason})")
    return json.loads(next(b.text for b in response.content if b.type == "text"))


def words(text):
    t = unicodedata.normalize("NFD", text or "").replace("́", "")
    t = unicodedata.normalize("NFC", t).lower().replace("ё", "е")
    return re.findall(r"[а-яa-z0-9-]+", t)


def library_matches(ru, library, limit=3):
    """Real sentences (from lessons) that contain this phrase, best first."""
    want = words(ru)
    if not want:
        return []
    phrase = " ".join(want)
    found = []
    for lesson_id, title, i, s in library:
        have = words(s["ru"])
        text = " ".join(have)
        if f" {phrase} " in f" {text} ":
            score = 2.0
        else:
            score = len(set(want) & set(have)) / len(set(want))
            if len(want) < 3 or score < 0.8:
                continue
        found.append((score, -len(have), {"lesson": lesson_id, "title": title, "i": i, "ru": s["ru"],
                                          "start": s.get("start"), "en": s.get("en", "")}))
    found.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [f[2] for f in found[:limit]]


def load_library():
    library = []
    for path in glob.glob(os.path.join(OUT, "library", "*.json")):
        try:
            data = json.load(open(path, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("kind") == "phrases":
            continue
        lid = os.path.basename(path)[:-5]
        for i, s in enumerate(data.get("sentences", [])):
            library.append((lid, data.get("title", ""), i, s))
    return library


def prepare():
    import anthropic

    text = " ".join((os.environ.get("PHRASE") or "").split())
    if not text:
        sys.exit("no PHRASE")
    client = anthropic.Anthropic(max_retries=4)
    gen = ask(client, GEN_SYSTEM, f"The learner wants to say:\n{text}", GEN_SCHEMA)
    versions = [v for v in gen["versions"] if v["ru"].strip()][:3]
    if not versions:
        sys.exit("no versions returned")

    listing = "\n".join(f"{i}. [{v['context']}] {v['ru']}  (meaning: {v['en']})" for i, v in enumerate(versions))
    rev = ask(client, REVIEW_SYSTEM, f"The learner wanted to say: {text}\n\nSuggested phrases:\n{listing}", REVIEW_SCHEMA)
    reviews = {r["i"]: r for r in rev["reviews"]}

    library = load_library()
    print(f"Searching {len(library)} real sentences from lessons", flush=True)
    meta = []
    for i, v in enumerate(versions):
        r = reviews.get(i, {})
        flag = ""
        verdict = r.get("verdict", "")
        if verdict == "unnatural" and r.get("better", "").strip():
            v["ru"] = r["better"].strip()
            flag = f"Reworded after a native-ear review: {r.get('note', '')}".strip()
            verdict = "reworded"
        elif verdict == "slightly off":
            flag = f"A second review thinks natives might say: {r.get('better', '')}. {r.get('note', '')}".strip()
        elif v["confidence"] == "low":
            flag = "Not fully confirmed: there may be a more common way to say this."
        meta.append({"context": v["context"], "note": v["note"], "confidence": v["confidence"],
                     "review": verdict, "flag": flag, "matches": library_matches(v["ru"], library)})

    with open(os.path.join(OUT, "phrase.json"), "w", encoding="utf-8") as f:
        json.dump({"input": text, "check": gen["check"], "versions": meta}, f, ensure_ascii=False)
    with open(os.path.join(OUT, "sentences.json"), "w", encoding="utf-8") as f:
        json.dump({"source": "phrase", "sentences": [{"start": 0, "end": 0, "text": v["ru"]} for v in versions]},
                  f, ensure_ascii=False)
    with open(os.path.join(OUT, "media.info.json"), "w", encoding="utf-8") as f:
        json.dump({"title": text}, f, ensure_ascii=False)
    for v, m in zip(versions, meta):
        print(f"  [{m['context']}] {v['ru']}  review={m['review'] or '-'}  matches={len(m['matches'])}")


def finish():
    meta = json.load(open(os.path.join(OUT, "phrase.json"), encoding="utf-8"))
    lesson = json.load(open(os.path.join(OUT, "lesson.json"), encoding="utf-8"))
    lesson.update({"kind": "phrases", "input": meta["input"], "check": meta["check"], "video": False, "url": ""})
    for s, m in zip(lesson["sentences"], meta["versions"]):
        s.update(m)
    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Phrase lesson: {len(lesson['sentences'])} versions for “{meta['input']}”")


if __name__ == "__main__":
    {"prepare": prepare, "finish": finish}[sys.argv[1]]()
