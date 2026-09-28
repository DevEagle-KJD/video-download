"""Free alternative to enrich.py: no paid AI, only open-source tools.

  - stress marks:      RUAccent (neural stress placement, understands context)
  - dictionary form:   pymorphy3
  - word meanings:     OpenRussian dictionary (CC BY-SA, github.com/Badestrand/russian-dictionary)
                       + a hand-made list of the most common short words
  - English sentence:  Argos Translate (offline machine translation, ru → en)

The literal meaning of each word comes from a dictionary, so it can miss the
meaning a word has in one particular sentence; that's the trade-off for $0.
Every tool is optional: if one fails to install or load, the lesson is still
written without that part.
"""
import csv
import io
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from enrich import add_timings, norm, plain_tokens  # noqa: E402

OUT = "out"
VOWELS = set("аеёиоуыэюя")
DICT_URL = "https://raw.githubusercontent.com/Badestrand/russian-dictionary/master/{}.csv"

# Literal meanings of very common words, whose dictionary entries are too
# general to help (pronoun forms, prepositions, particles).
COMMON = {
    "я": "I", "меня": "me", "мне": "to-me", "мной": "with-me", "мы": "we", "нас": "us", "нам": "to-us",
    "ты": "you", "тебя": "you", "тебе": "to-you", "тобой": "with-you", "вы": "you", "вас": "you", "вам": "to-you",
    "он": "he", "его": "him/his", "ему": "to-him", "им": "(by)-him/to-them", "нём": "him", "нем": "him",
    "она": "she", "её": "her", "ее": "her", "ей": "to-her", "ней": "her",
    "оно": "it", "они": "they", "их": "them/their", "них": "them", "ними": "with-them",
    "это": "this/it", "этот": "this", "эта": "this", "эти": "these", "то": "that", "тот": "that", "там": "there", "тут": "here", "здесь": "here",
    "мой": "my", "моя": "my", "моё": "my", "мое": "my", "мои": "my", "твой": "your", "твоя": "your", "наш": "our", "наша": "our", "ваш": "your", "свой": "(one's)-own", "своя": "(one's)-own",
    "у": "at/by", "в": "in", "во": "in", "на": "on", "с": "with", "со": "with", "к": "to", "ко": "to", "от": "from", "из": "from/out-of",
    "за": "behind/for", "под": "under", "над": "above", "о": "about", "об": "about", "про": "about", "по": "along/by", "для": "for", "без": "without", "до": "until/to",
    "и": "and", "а": "and/but", "но": "but", "или": "or", "что": "what/that", "чтобы": "in-order-to", "если": "if", "когда": "when", "как": "how/like", "потому": "because",
    "не": "not", "нет": "no/there's-no", "да": "yes", "ни": "not-even", "же": "(emphasis)", "ли": "(question)", "бы": "would", "вот": "here's", "ну": "well",
    "уже": "already", "ещё": "still/more", "еще": "still/more", "тоже": "too", "также": "also", "очень": "very", "только": "only", "так": "so", "вообще": "in-general",
    "есть": "there-is/eat", "был": "was", "была": "was", "было": "was", "были": "were", "будет": "will-be", "можно": "(one)-can", "нужно": "(one)-needs", "надо": "(one)-must",
    "кто": "who", "где": "where", "куда": "where-to", "почему": "why", "зачем": "what-for", "сколько": "how-much", "какой": "which", "какая": "which", "сейчас": "now", "потом": "then/later",
    "сначала": "first", "всё": "all/everything", "все": "all/everyone", "весь": "all", "вся": "all", "себя": "oneself", "себе": "to-oneself", "сам": "(my)self", "сама": "(her)self",
    "привет": "hi", "пока": "bye/while", "спасибо": "thanks", "пожалуйста": "please", "давай": "let's", "давайте": "let's",
}


def load_dictionary():
    """{bare word: (accented, [english meanings])} from OpenRussian's word lists."""
    words = {}
    for part in ("nouns", "verbs", "adjectives", "others"):
        try:
            raw = urllib.request.urlopen(DICT_URL.format(part), timeout=60).read().decode("utf-8")
        except Exception as e:  # noqa: BLE001
            print(f"::warning::dictionary {part} unavailable: {e}")
            continue
        delim = "\t" if raw.split("\n", 1)[0].count("\t") > raw.split("\n", 1)[0].count(",") else ","
        for row in csv.DictReader(io.StringIO(raw), delimiter=delim):
            bare = norm(row.get("bare") or "")
            meanings = [m.strip() for m in (row.get("translations_en") or "").replace(";", ",").split(",") if m.strip()]
            if bare and meanings and bare not in words:
                words[bare] = (row.get("accented") or row.get("bare") or "", meanings)
    print(f"Dictionary: {len(words)} words")
    return words


def accent_from_dict(accented):
    """OpenRussian marks stress with an apostrophe after the vowel: молоко' → молоко́."""
    return accented.replace("'", "́")


def load_stress():
    try:
        from ruaccent import RUAccent

        acc = RUAccent()
        acc.load(omograph_model_size="turbo", use_dictionary=True)
        print("RUAccent loaded")
        return acc
    except Exception as e:  # noqa: BLE001
        print(f"::warning::RUAccent unavailable, no stress marks: {e}")
        return None


def plus_to_acute(text):
    """RUAccent marks stress with '+' before the vowel: мол+око → моло́ко."""
    out, i = [], 0
    while i < len(text):
        if text[i] == "+" and i + 1 < len(text):
            out.append(text[i + 1] + "́")
            i += 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def strip_one_syllable(word):
    """Remove the stress mark from one-syllable words (it adds nothing)."""
    if sum(ch in VOWELS for ch in word.lower()) <= 1:
        return word.replace("́", "")
    return word


def load_translator():
    try:
        import argostranslate.package
        import argostranslate.translate

        installed = argostranslate.translate.get_installed_languages()
        if not any(l.code == "ru" for l in installed):
            argostranslate.package.update_package_index()
            pkg = next(p for p in argostranslate.package.get_available_packages()
                       if p.from_code == "ru" and p.to_code == "en")
            argostranslate.package.install_from_path(pkg.download())
        print("Argos Translate ru→en ready")
        return lambda text: argostranslate.translate.translate(text, "ru", "en")
    except Exception as e:  # noqa: BLE001
        print(f"::warning::Argos Translate unavailable, no English lines: {e}")
        return None


def main():
    with open(os.path.join(OUT, "sentences.json"), encoding="utf-8") as f:
        data = json.load(f)
    sentences = data["sentences"]
    info = {}
    if os.path.exists(os.path.join(OUT, "media.info.json")):
        with open(os.path.join(OUT, "media.info.json"), encoding="utf-8") as f:
            info = json.load(f)

    try:
        import pymorphy3
        morph = pymorphy3.MorphAnalyzer()
    except Exception as e:  # noqa: BLE001
        print(f"::warning::pymorphy3 unavailable: {e}")
        morph = None
    dictionary = load_dictionary()
    stress = load_stress()
    translate = load_translator()

    lesson_sentences, translated = [], 0
    for n, s in enumerate(sentences):
        tokens = plain_tokens(s["text"])

        if stress:
            try:
                marked = plus_to_acute(stress.process_all(s["text"])).split()
                if len(marked) == len(tokens):
                    for tok, m in zip(tokens, marked):
                        tok["w"] = strip_one_syllable(m)
            except Exception as e:  # noqa: BLE001
                print(f"  stress failed on sentence {n}: {e}")

        for tok in tokens:
            key = norm(tok["w"])
            lemma = key
            if morph and key:
                lemma = norm(morph.parse(key)[0].normal_form)
            entry = dictionary.get(lemma) or dictionary.get(key)
            if lemma != key:
                tok["b"] = strip_one_syllable(accent_from_dict(entry[0])) if entry else lemma
            if entry:
                tok["m"] = ", ".join(entry[1][:3])
            tok["g"] = COMMON.get(key) or (entry[1][0].replace(" ", "-") if entry else "")

        en = ""
        if translate:
            try:
                en = translate(s["text"]).strip()
                translated += bool(en)
            except Exception as e:  # noqa: BLE001
                print(f"  translation failed on sentence {n}: {e}")

        lesson_sentences.append({
            "start": s["start"], "end": s["end"], "ru": s["text"],
            "tokens": add_timings(tokens, s), "en": en,
        })
        if n % 50 == 0:
            print(f"  {n}/{len(sentences)} sentences", flush=True)

    lesson = {
        "title": info.get("title") or "Russian video",
        "url": os.environ.get("URL", ""),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "source": data.get("source"),
        "engine": "free",
        "model": "Free tools: RUAccent, pymorphy3, OpenRussian, Argos Translate",
        "enriched": len(sentences) if (dictionary or translate) else 0,
        "sentences": lesson_sentences,
    }
    with open(os.path.join(OUT, "lesson.json"), "w", encoding="utf-8") as f:
        json.dump(lesson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"lesson.json: {len(sentences)} sentences, {translated} translated (free tools)")


if __name__ == "__main__":
    main()
