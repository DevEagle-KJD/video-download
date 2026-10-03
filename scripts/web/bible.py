"""One Bible verse (НРП, Новый русский перевод) as a Nativnik lesson, for the
Bible section in Practice (the owner and their daughter; one verse at a time).

  python3 scripts/web/bible.py prepare MAT.1.18   # → out/sentences.json, out/media.info.json, out/deck.json
  (then enrich.py, deck.py finish, voices.py, publish.py --bible, as for a deck)

The verse text is always read from the published НРП on bible.com (version 143),
never typed from memory. The JSON also tells us which verse comes next, so the
app can unlock the verses in order. If the verse is one of the owner's Anki Bible
cards (web/decks/bible.tsv), their stress marks are applied too.
"""
import html
import json
import os
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser

OUT = "out"
VERSION = 143   # НРП on bible.com
API = "https://nodejs.bible.com/api/bible/chapter/3.1?id={v}&reference={ref}"

BOOKS = {
    "GEN": "Genesis", "EXO": "Exodus", "LEV": "Leviticus", "NUM": "Numbers", "DEU": "Deuteronomy",
    "JOS": "Joshua", "JDG": "Judges", "RUT": "Ruth", "1SA": "1 Samuel", "2SA": "2 Samuel",
    "1KI": "1 Kings", "2KI": "2 Kings", "1CH": "1 Chronicles", "2CH": "2 Chronicles", "EZR": "Ezra",
    "NEH": "Nehemiah", "EST": "Esther", "JOB": "Job", "PSA": "Psalm", "PRO": "Proverbs",
    "ECC": "Ecclesiastes", "SNG": "Song of Songs", "ISA": "Isaiah", "JER": "Jeremiah",
    "LAM": "Lamentations", "EZK": "Ezekiel", "DAN": "Daniel", "HOS": "Hosea", "JOL": "Joel",
    "AMO": "Amos", "OBA": "Obadiah", "JON": "Jonah", "MIC": "Micah", "NAM": "Nahum", "HAB": "Habakkuk",
    "ZEP": "Zephaniah", "HAG": "Haggai", "ZEC": "Zechariah", "MAL": "Malachi",
    "MAT": "Matthew", "MRK": "Mark", "LUK": "Luke", "JHN": "John", "ACT": "Acts", "ROM": "Romans",
    "1CO": "1 Corinthians", "2CO": "2 Corinthians", "GAL": "Galatians", "EPH": "Ephesians",
    "PHP": "Philippians", "COL": "Colossians", "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
    "1TI": "1 Timothy", "2TI": "2 Timothy", "TIT": "Titus", "PHM": "Philemon", "HEB": "Hebrews",
    "JAS": "James", "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John", "2JN": "2 John",
    "3JN": "3 John", "JUD": "Jude", "REV": "Revelation",
}


def english(ref):
    """'MAT.1.18' → 'Matthew 1:18'"""
    book, ch, v = ref.split(".")
    return f"{BOOKS.get(book, book)} {ch}:{v}"


def chapter(usfm):
    url = API.format(v=VERSION, ref=usfm)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise SystemExit(f"Couldn't read {usfm} from bible.com: {e}")
            time.sleep(2 ** attempt)


class Verses(HTMLParser):
    """Collects the text of every verse in a chapter's HTML (footnotes, verse
    numbers and section headings left out). A verse split over two paragraphs is
    joined; combined verses ("MAT.1.18+MAT.1.19") are kept together."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.order, self.text = [], {}
        self.stack = []        # (tag, kind) for every open element
        self.verse = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        kind = ""
        if "verse" in cls and a.get("data-usfm"):
            kind = "verse"
            self.verse = a["data-usfm"]
            if self.verse not in self.text:
                self.order.append(self.verse)
                self.text[self.verse] = ""
        elif "note" in cls or "label" in cls or "heading" in cls:
            kind = "skip"
        elif "content" in cls:
            kind = "content"
        self.stack.append((tag, kind))

    def handle_endtag(self, tag):
        while self.stack:
            t, kind = self.stack.pop()
            if kind == "verse":
                self.verse = None
            if t == tag:
                break

    def handle_data(self, data):
        kinds = [k for _, k in self.stack]
        if self.verse and "content" in kinds and "skip" not in kinds:
            self.text[self.verse] += data


def verses_of(usfm):
    """[(refs in this verse, text)] for a chapter, in order, and the chapter JSON."""
    d = chapter(usfm)
    p = Verses()
    p.feed(d.get("content", ""))
    out = []
    for key in p.order:
        text = re.sub(r"\s+", " ", html.unescape(p.text[key])).strip()
        if text:
            out.append((key.split("+"), text))
    return out, d


def next_chapter(d):
    """The next real chapter after this one (skipping book introductions)."""
    for _ in range(4):
        nxt = d.get("next") or {}
        usfm = (nxt.get("usfm") or [None])[0]
        if not usfm:
            return None, None
        verses, d2 = verses_of(usfm)
        if nxt.get("canonical", True) and verses:
            return usfm, verses
        d = d2
    return None, None


def find(ref):
    """The verse's text and the reference of the verse that comes after it."""
    book, ch, _ = ref.split(".")
    verses, d = verses_of(f"{book}.{ch}")
    for k, (refs, text) in enumerate(verses):
        if ref in refs:
            if k + 1 < len(verses):
                nxt = verses[k + 1][0][0]
            else:
                _, nv = next_chapter(d)
                nxt = nv[0][0][0] if nv else None
            return text, nxt, d
    raise SystemExit(f"{ref} isn't in the НРП text on bible.com")


def owner_syllables(ref):
    """The owner's Anki syllables for this verse, if it's one of their cards."""
    path = os.path.join("web", "decks", "bible.tsv")
    label = english(ref)
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            cols = line.rstrip("\n").split("\t")
            if cols and cols[0].strip() == label and len(cols) > 4:
                return cols[4]
    return ""


def prepare(ref):
    if not re.fullmatch(r"[1-4A-Z]{3}\.\d{1,3}\.\d{1,3}", ref) or ref.split(".")[0] not in BOOKS:
        sys.exit(f"bad verse reference {ref!r}")
    text, nxt, d = find(ref)
    label = english(ref)
    print(f"{label}: {text}\nNext: {nxt}")
    os.makedirs(OUT, exist_ok=True)
    item = {"ref": label, "en": "", "ru": text, "who": "", "syl": owner_syllables(ref)}
    json.dump({"source": "deck", "sentences": [{"start": 0, "end": 0, "text": text}]},
              open(os.path.join(OUT, "sentences.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"title": label}, open(os.path.join(OUT, "media.info.json"), "w", encoding="utf-8"), ensure_ascii=False)
    copyright_text = re.sub(r"\s+", " ", (d.get("copyright") or {}).get("text", "")).strip()
    extra = {"kind": "bible", "bible": {"ref": ref, "next": nxt, "label": label,
                                        "copyright": copyright_text or "НРП © Biblica, Inc. Used with permission."}}
    json.dump({"source": "bible", "title": label, "items": [item], "extra": extra},
              open(os.path.join(OUT, "deck.json"), "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    {"prepare": lambda: prepare(sys.argv[2])}[sys.argv[1]]()
