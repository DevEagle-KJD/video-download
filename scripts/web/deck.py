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
TITLES = {"conversation": "Russian Conversation", "bible": "Russian Bible (НРП)"}
WHO = [
    (r"speaking to a (boy|man)", "to a man"), (r"speaking to a (girl|woman)", "to a woman"),
    (r"speaking to (a group|several people|people|you all)", "to a group"),
    (r"\bfemale speaker", "if you're a woman"), (r"\bmale speaker", "if you're a man"),
]


def rows(source):
    path = os.path.join("web", "decks", f"{source}.tsv")
    for line in open(path, encoding="utf-8"):
        cols = line.rstrip("\n").split("\t")
        if len(cols) < 3 or not cols[0].strip():
            continue
        if source == "bible":
            yield {"ref": cols[0].strip(), "en": cols[1].strip(), "ru": cols[2].split(" | ")[0].strip(), "who": ""}
        else:
            en, _, note = cols[0].rpartition(" — ")
            who = next((label for pat, label in WHO if re.search(pat, note, re.I)), "") if en else ""
            yield {"ref": "", "en": en.strip() if who else cols[0].strip(),
                   "ru": cols[1].split(" | ")[0].strip(), "who": who}


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
    for s, it in zip(lesson["sentences"], meta["items"]):
        if it["en"]:
            s["en"] = it["en"]                     # the owner's own English from Anki
        s["who"] = it["who"]
        s["context"] = it["ref"]                   # e.g. "Matthew 1:18"
        s["note"] = it.get("note", "")
        s["matches"] = []
    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Deck: {len(lesson['sentences'])} sentences")


if __name__ == "__main__":
    {"prepare": lambda: prepare(sys.argv[2]), "finish": finish}[sys.argv[1]]()
