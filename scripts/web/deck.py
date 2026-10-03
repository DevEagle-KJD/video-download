"""Turns one of the owner's Anki decks (web/decks/<source>.tsv, copied from the
russian-study repo) into a Nativnik deck: the same lesson.json format as lessons and
phrases, so it plays, taps and saves the same way.

  python3 scripts/web/deck.py prepare <source>   # → out/sentences.json, out/media.info.json, out/deck.json
  (then enrich.py adds stress marks, literal meanings and English; voices.py the voices)
  python3 scripts/web/deck.py finish             # merges out/deck.json into out/lesson.json

conversation.tsv: English[ — who] · "Russian | romanization" · tags · syllables · literal · chunks
bible.tsv:        reference · English · Russian · tags · syllables · literal · chunks
The owner's own English is kept (it's what they learned in Anki); "— speaking to a girl/woman"
style notes become the man/woman label."""
import json
import os
import re
import sys

OUT = "out"
TITLES = {"conversation": "Russian Conversation", "vocab": "Russian Vocabulary",
          "bible": "Russian Bible (НРП)"}
VOCAB = {"vocab"}
WHO = [
    (r"speaking to a (boy|man)", "to a man"), (r"speaking to a (girl|woman)", "to a woman"),
    (r"speaking to (a group|several people|people|you all)", "to a group"),
    (r"\bfemale speaker|\ba (girl|woman) speaking", "if you're a woman"),
    (r"\bmale speaker|\ba (boy|man) speaking", "if you're a man"),
]


def rows(source):
    path = os.path.join("web", "decks", f"{source}.tsv")
    for line in open(path, encoding="utf-8"):
        cols = line.rstrip("\n").split("\t")
        if len(cols) < 3 or not cols[0].strip():
            continue
        if source == "bible":
            yield {"ref": cols[0].strip(), "en": cols[1].strip(), "ru": cols[2].split(" | ")[0].strip(), "who": "",
                   "syl": cols[4] if len(cols) > 4 else ""}
        elif source in VOCAB:          # English · "Russian | romanization" · note · tags · syllables
            en, _, extra = cols[0].rpartition(" — ")
            who = next((label for pat, label in WHO if re.search(pat, extra, re.I)), "") if en else ""
            yield {"ref": "", "en": en.strip() if who else cols[0].strip(), "ru": cols[1].split(" | ")[0].strip(),
                   "who": who, "note": cols[2].strip() if len(cols) > 2 else "", "syl": cols[4] if len(cols) > 4 else ""}
        else:
            en, _, note = cols[0].rpartition(" — ")
            who = next((label for pat, label in WHO if re.search(pat, note, re.I)), "") if en else ""
            yield {"ref": "", "en": en.strip() if who else cols[0].strip(),
                   "ru": cols[1].split(" | ")[0].strip(), "who": who, "syl": cols[3] if len(cols) > 3 else ""}


VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
ACUTE = "\u0301"


def plain(w):
    return re.sub(r"[^а-яё]", "", w.replace(ACUTE, "").lower())


def stressed_words(syl):
    """The owner's syllables ("Как ты се-ГОД-ня спал?") → {"сегодня": "сего́дня", …}.
    The CAPITAL syllable is the stressed one. A word's first letter can be a capital just
    because the word starts with one (И-и-СУ-са), so a longer capital syllable wins; a
    one-letter capital counts only when it's the only one (О-чень, Э-том).
    One-syllable words and ё need no mark."""
    out = {}
    for word in syl.split():
        parts = [p for p in re.sub(r"[^А-Яа-яЁё-]", "", word).split("-") if p]
        if len(parts) < 2:
            continue
        caps = [i for i, p in enumerate(parts) if p.isupper()]
        long_caps = [i for i in caps if len(parts[i]) > 1]
        k = long_caps[0] if long_caps else (caps[-1] if caps else None)
        if k is None:
            continue
        low = [p.lower() for p in parts]
        if "ё" not in low[k]:
            v = next((i for i, ch in enumerate(low[k]) if ch in VOWELS), None)
            if v is not None:
                low[k] = low[k][:v + 1] + ACUTE + low[k][v + 1:]
        built = "".join(low)
        if ACUTE in built:
            out[plain(built)] = built
    return out


def apply_owner_stress(s, syl):
    """Puts the owner's stress on each matching token (keeping its capital letter and
    punctuation). Returns how many tokens changed."""
    marks, changed = stressed_words(syl), 0
    for t in s.get("tokens", []):
        m = re.match(r"^([^А-Яа-яЁё]*)([А-Яа-яЁё\u0301-]+)(.*)$", t["w"])
        if not m:
            continue
        lead, word, tail = m.groups()
        want = marks.get(plain(word))
        if not want or want == word.lower():
            continue
        if word[:1].isupper():
            want = want[:1].upper() + want[1:]
        if want != word:
            t["w"], changed = lead + want + tail, changed + 1
    return changed


def prepare(source):
    if source not in TITLES:
        sys.exit(f"unknown deck source {source!r}")
    items = list(rows(source))
    os.makedirs(OUT, exist_ok=True)
    json.dump({"source": "deck", "sentences": [{"start": 0, "end": 0, "text": it["ru"]} for it in items]},
              open(os.path.join(OUT, "sentences.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"title": TITLES[source]}, open(os.path.join(OUT, "media.info.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"source": source, "title": TITLES[source], "items": items},
              open(os.path.join(OUT, "deck.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{TITLES[source]}: {len(items)} sentences")


def finish():
    meta = json.load(open(os.path.join(OUT, "deck.json"), encoding="utf-8"))
    lesson = json.load(open(os.path.join(OUT, "lesson.json"), encoding="utf-8"))
    lesson.update({"kind": "deck", "input": meta["title"], "title": meta["title"], "video": False, "url": ""})
    lesson["vocab"] = meta["source"] in VOCAB
    lesson.update(meta.get("extra", {}))           # bible.py: the verse reference and the next verse
    fixed = 0
    for s, it in zip(lesson["sentences"], meta["items"]):
        if it.get("syl"):
            fixed += apply_owner_stress(s, it["syl"])
        if it["en"]:
            s["en"] = it["en"]                     # the owner's own English from Anki
        s["who"] = it["who"]
        s["context"] = it["ref"]                   # e.g. "Matthew 1:18"
        s["note"] = it.get("note", "")
        s["matches"] = []
    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Deck: {len(lesson['sentences'])} items; owner's stress applied to {fixed} words")


if __name__ == "__main__":
    {"prepare": lambda: prepare(sys.argv[2]), "finish": finish}[sys.argv[1]]()
