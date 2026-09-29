# Grab: Project Handoff

Read this first in any new session. It describes what the app is, how every part works, the
rules and decisions behind it, and exactly where things were left off.

_Last updated: 2026-09-29, late evening (Captions test run and verdict, Caption check, Stop & Remove, YouTube play fixes, reload fix)._

---

## 1. What this is, in one paragraph

**Grab** is a private, iPhone-style web app hosted on GitHub. It started as a **video
downloader**: paste any link, and it downloads the video (Best / 1080p / 720p / MP3) and saves it
to Photos. It grew a **Study** tab that turns any Russian video into an **interactive
language lesson** built around **sentence mining** (the owner explicitly does **not** want grammar
lessons). Every sentence is shown three ways: **Russian with stress marks**, a **literal
word-by-word meaning** under each word, and **plain English**. You can tap any sentence to replay
that moment of the video, tap any word to hear it (natural neural voice, normal then slow) and see
its meaning, and save sentences or words as **spaced-repetition flashcards**. All heavy work runs
on **GitHub Actions**. The app is a static site on **GitHub Pages**.

The owner (GitHub user **DevEagle-KJD**) uses an **iPhone only** (no computer) and prefers plain,
step-by-step explanations. This GitHub version is a **trial run**. The long-term goal is a
**public multi-language learning service built on Vercel + Supabase** (see §12).

---

## 2. Where everything lives

| Thing | Value |
|---|---|
| Repo | `DevEagle-KJD/video-download` (**public**, and must stay public for free Pages) |
| Working branch | `claude/iphone-video-downloader-pwqipq`, which is also the repo's **default branch** (it was the first branch pushed). All workflows run from it. |
| Live app | **https://deveagle-kjd.github.io/video-download/** |
| Pages source | Settings → Pages → Source: **GitHub Actions** (set by the owner) |
| Related repo | `DevEagle-KJD/russian-study` (private). The owner's Anki-deck builder; its voice setup (`anki/tts.py`, edge-tts Svetlana/Dmitry at -25%/-40%) was copied for Grab's word audio. |
| Owner's device | iPhone, Safari. The app is used in Safari (tab) and/or added to the Home Screen. **Safari and Home-Screen copies have separate storage**, so the token must be entered in the one they use. **Clearing Safari history or closing a Private tab wipes the token and local lists** (it happened twice on 2026-09-29); everything real is on GitHub and comes back once the token is re-entered. Recommended: use the Home-Screen copy. |

### Secrets and variables (repo Settings → Secrets and variables → Actions)
| Name | Kind | Status | Used for |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret | **Set** (2026-09-28) | Study "AI" engine: proofread, translate, final review |
| `YTDLP_COOKIES` | secret | not set | Optional Netscape cookies.txt for login-only videos / YouTube bot checks |
| `STUDY_MODEL` | variable | not set | Override the Claude model (default `claude-sonnet-5`) |
| `WHISPER_MODEL` | variable | not set | Override Whisper (default `large-v3`; e.g. `large-v3-turbo` for speed) |
| `STUDY_VOICE` | env in voices.py | default | Neural voice (default `ru-RU-SvetlanaNeural`) |

The app itself authenticates to the GitHub API with a **personal access token** the owner pastes
into Settings (stored only in the browser's localStorage). They're using a **classic token with
`repo` + `workflow` scopes**, created via
`https://github.com/settings/tokens/new?scopes=repo,workflow&description=Grab`.
⚠️ The owner once pasted a token into the chat. They were advised to delete it and make a new one;
remind them if it's unclear whether they did.

The owner has an Anthropic Console account (platform.claude.com) with ~$5 credit on a company
card (auto-reload off). The key is named for Grab and was set to a long expiry.

---

## 3. Architecture

```
 iPhone (Safari / Home Screen)                      GitHub
 ┌──────────────────────────────┐   REST API    ┌───────────────────────────────────────┐
 │ app/ (static PWA on Pages)   │──────────────▶│ workflow_dispatch:                    │
 │  • Download tab (app.js)     │  token in     │   download.yml   (Grab)               │
 │  • Study tab   (study.js)    │  localStorage │   study.yml      (lessons)            │
 │  • Library, Settings         │               │   voices.yml     (add audio to lesson)│
 │                              │◀──────────────│ results → Releases (dl-*, study-*)    │
 │ fetches files same-origin:   │   polls runs  │ pages.yml rebuilds the Pages site:    │
 │  files/<id>/media.mp4 …      │   & releases  │   app/ + every release's files        │
 └──────────────────────────────┘               │   → site/files/<id>/…                 │
                                                 │ cleanup.yml deletes dl-* after 24 h   │
                                                 └───────────────────────────────────────┘
```

**Key trick (why files are republished to Pages):** GitHub's release-asset host
(`release-assets.githubusercontent.com`) sends **no CORS headers**, so the browser can't `fetch()`
a release file from another origin. So every download and lesson is also **copied onto the Pages
site** (`files/<id>/…`), and the app loads it **same-origin**. `scripts/build-site.sh` does this;
`pages.yml` is a reusable workflow called at the end of `download.yml`, `study.yml`, `voices.yml` and
`cleanup.yml`, and it runs on pushes to `app/**`. Pages has a **1 GB** limit: `build-site.sh` adds
lessons first (newest first), then downloads, and skips videos over a ~900 MB budget.
`lesson.json` is always included.

**Deploy note:** pushing anything under `app/` redeploys the site within about a minute. **Bump
`CACHE` in `app/sw.js`** (currently `grab-v23`) whenever app files change. The service worker is
network-first, but the bump guarantees clean updates. Users must reload with **Safari's address-bar
↻**; the in-app ↻ only refreshes the lesson list.

---

## 4. The Grab downloader (Download / Library / Settings tabs)

### Flow
1. The app dispatches `download.yml` with `url`, `quality` (`best|1080|720|audio`) and `job_id`
   (random 12-char `[a-z0-9]`). The run name is `dl <job_id>`, which is how the app finds its run.
2. The workflow runs `scripts/download.sh` (yt-dlp), then `iphone-compat.sh` (ffmpeg → MP4
   H.264/HEVC + AAC; re-encodes only if needed, adds the `hvc1` tag for HEVC), then `publish.sh`,
   which creates release **`dl-<id>`** with `media.<ext>` and a JSON release body (title, site,
   duration, height, size…). On failure, `report-failure.sh` creates a release whose body is
   `{ok:false,error,run}`, so the app can show the error.
3. `pages.yml` copies the file to `files/<id>/`.
4. The app polls the run (the step name maps to "Preparing / Downloading / Converting / Uploading"),
   then reads the release. **Save to iPhone** fetches `files/<id>/<name>` (same-origin, with the
   GitHub API asset endpoint as fallback) into a `File`, then **Save Video / Save Audio** opens
   the iOS share sheet (`navigator.share`). After a successful share, the release is deleted
   ("Saved"). **Open Link** is a fallback.
5. `cleanup.yml` (every 6 h) deletes `dl-*` releases older than 24 h and rebuilds the site.
   **`study-*` releases are never auto-deleted.**

### Getting past blocks (`download.sh`)
- yt-dlp nightly with `curl-cffi` (browser impersonation) and `--extractor-args generic:impersonate`.
- A **bgutil PO-token provider** service container (port 4416) and its yt-dlp plugin.
- Deno is installed (YouTube player challenges).
- If blocked ("not a bot", 403, 429…), the script connects **Cloudflare WARP** and retries, then
  retries again with alternate YouTube player clients (`tv_simply,web_safari`, `mweb,web_embedded`,
  `tv,ios`). **YouTube blocks GitHub's IPs outright; WARP is what makes YouTube work.**
  - ⚠️ The WARP fallback was initially **blocked by the auto-mode safety classifier** as evading
    site protections. The **owner explicitly chose to proceed**: they switched the session to
    "Accept edits" mode and said "Go ahead with the VPN". It works (confirmed). Mention that it breaks
    YouTube's ToS if it ever comes up again, and that cookies (`YTDLP_COOKIES`) are the sanctioned route.
- Quality sorting uses `-S res:<n>` (the shorter side, so vertical videos work) and prefers H.265/H.264
  + AAC. The `study` quality is 480p and also fetches **human-made Russian subtitles**
  (`--write-subs --sub-langs "ru.*,ru"`; auto-captions are deliberately never used).
- `--playlist-items 1`: a playlist or carousel link gets its first item.

### App features (app.js)
- iOS look: large collapsing titles, grouped lists, segmented control, tab bar, bottom sheets,
  toasts, dark mode, safe areas, installable PWA (`manifest.webmanifest`, icons made by
  `scripts/make-icons.py`).
- Deep link `?url=…&q=best|1080|720|audio&go=1`.
- Library syncs recent runs, so downloads started elsewhere (e.g. an iOS Shortcut) show up.
- Settings: owner, repo, token (with **Show** / **Copy Token**), **Save & Test Connection**, a
  Share-Sheet Shortcut guide (Shortcut → "Get Contents of URL" POST to the dispatch API), Sign Out.
- A failed job puts its link back in the URL box. **Try Again** re-dispatches.
- Every finished (ready/saved/removed/expired, non-audio) download shows a purple
  **📖 Use for Russian Study** button, which starts a lesson from that URL with the Study tab's
  selected engine.

---

## 5. The Study pipeline (`study.yml`)

Inputs: `url`, `job_id`, `engine` (`free` | `ai`; the app sends the Study tab's choice).
Run name `study <job_id>`. Release **`study-<id>`** holds `media.mp4`, `lesson.json` and `audio.zip`.

| # | Step | Script | What it does |
|---|---|---|---|
| 1 | Download | `download.sh` (QUALITY=study) | 480p MP4 plus human Russian subtitles if any (WARP fallback as above) |
| 2 | Convert for iPhone | `iphone-compat.sh` | Ensures H.264/AAC MP4 → `out/media.mp4` |
| 3 | Transcribe | `study/transcribe.py` | **Human subtitles first** (VTT → cues merged into sentences). Otherwise **Whisper large-v3** (faster-whisper, CPU int8, beam 5, VAD, `word_timestamps`) → sentences split at `. ! ? …`, gaps >1.2 s, or 30 words. Keeps **per-word timings + confidence** `words: [[word, start, end, prob]]`. Writes `out/sentences.json`, `out/audio.wav` (16 kHz). |
| 4 | Second opinion | `study/second_asr.py` | **Check 1.** An independent transcriber (**GigaAM v3 `v3_e2e_rnnt`** for Russian, run per sentence on ≤22 s clips) is diffed word-by-word against Whisper (difflib). Words that differ, or have Whisper prob < 0.25, become `doubts` `{i, heard, why}`. Skipped for human subtitles. The map `SECOND = {"ru": …}` is where other languages go. |
| 5 | Proofread | `study/proofread.py` | **Check 2 (AI engine only).** Claude sees Whisper's sentence with doubtful words marked `⟦…⟧`, GigaAM's version, the neighbouring sentences and the video title/description, and returns the corrected sentence plus `unsure` words. **Guard rail:** if anything except a doubtful word (or an insertion next to one) changed, the correction is **rejected**. Leftovers become `flags` `{w, alt, why}`. Free engine / no key: every doubt becomes a flag. |
| 6 | Translate | `study/enrich.py` (AI) or `study/enrich_free.py` (free) | See below. |
| 7 | Voices | `study/voices.py` (`continue-on-error`) | Records every distinct word/phrase and dictionary form with **edge-tts `ru-RU-SvetlanaNeural`** at **`-25%` then `-40%`** (8 concurrent requests). Clips go to `out/audio/<sha1(voice\|rate\|text)[:12]>.mp3`, and `lesson.audio = {voice, rates, clips:{text:[normal, slow]}}` is added. |
| 8 | Publish | `study/publish.sh` | Zips `out/audio` → `audio.zip`; creates the release with a JSON body `{ok, kind:"study", title, url, duration, thumbnail, source, engine, enriched, count}` |
| — | publish-site | `pages.yml` | Copies the lesson to `files/<id>/` and **unzips `audio.zip`** into `files/<id>/audio/` |

The cache key `study-models-<engine>-large-v3-gigaam` stores the Whisper, GigaAM, HF and Argos models.

### AI engine: `enrich.py` (default model **`claude-sonnet-5`**)
- The Anthropic Python SDK uses `client.beta.messages.create` with
  `betas=["server-side-fallback-2026-07-01"]` and `extra_body={"fallbacks":"default"}` (refusal
  fallback), `output_config={"effort":"medium","format":{json_schema…}}` (structured output), batches
  of 25 sentences (4 in parallel), plus the 3 previous sentences as context. On `max_tokens`/refusal
  it splits the batch in half and retries.
- **Per sentence it returns** `tokens: [{w, g, b, m}]` and `en`:
  - `w`: the word exactly as transcribed plus a **stress mark** (U+0301 after the stressed vowel;
    none on ё or one-syllable words; punctuation stays attached). **Fixed phrases stay one token**
    (да ладно, ну и что, как раз, всё равно) and get a literal gloss.
  - `g`: **literal meaning in this sentence**, hyphenated ("to-me", "it-seems", "(they)-call").
    It mirrors Russian word order and **never uses grammar terms**.
  - `b`: dictionary form with stress (книгу → кни́га), or "" if the word is already in it.
  - `m`: a short general meaning (1–4 words).
  - `en`: a natural, idiomatic English translation.
  - **Rule:** never add, drop or correct words; only add stress marks.
- **Check 3, the final review:** RUAccent's stress for each sentence is compared with Claude's;
  disagreements are sent as hints. A second Claude pass ("meticulous Russian teacher") returns
  **only fixes** (`fixes`, `en`, `flags`). A fix may change a word's **stress mark only, never its
  letters** (enforced). Review flags are added to the tokens.
- Each token gets timings `t:[start,end]` (Whisper words aligned to tokens, gaps interpolated by
  word length) and `u:{alt, note}` if it is flagged.
- `lesson.checks` records agreement, proofread counts, review counts and `flagged_words`.

### Free engine: `enrich_free.py` ($0, lower quality)
RUAccent (stress) + pymorphy3 (dictionary form) + the **OpenRussian dictionary**
(`raw.githubusercontent.com/Badestrand/russian-dictionary/master/{nouns,verbs,adjectives,others}.csv`,
tab-separated, `accented` uses `'` after the stressed vowel) + a hand-made `COMMON` list of short-word
literal glosses + **Argos Translate** ru→en (needs CPU torch). Every tool is optional. Known
weaknesses: literal glosses are dictionary senses, not in-context (до́ма → "house"), and Argos
mistranslates things like сушки/баранки.

### Captions-only test engine (`engine=captions`)
Built to test whether a **public** version could work for any YouTube video **without downloading
video or audio** (YouTube's terms forbid downloading; see §12). The Study tab's engine switch
has a third option, **Captions (test)**.
- `download.sh` QUALITY=captions: `--skip-download --write-subs --write-auto-subs --sub-langs ru,ru-orig
  --sub-format json3`. That's the video details plus YouTube's captions only. (It still goes through
  the WARP fallback on GitHub.)
- `transcribe.py` (`ENGINE=captions`): **creator captions** (the language is in info.json `subtitles`)
  → cues merged into sentences, used as-is. **Automatic captions** → per-word start times (the
  word length is estimated so pauses show), sentences split at 0.8 s pauses / 20 words; there's
  no punctuation. `source` = `creator-captions` | `auto-captions`.
- `clean_captions.py` (automatic captions only, needs the key): the caption words are sent as one
  numbered stream (chunks of ~150 words cut at pauses > 1 s, 4 in parallel) and Claude **re-splits
  them into real sentences** (`from`/`to` word numbers, must cover every word once, else that chunk
  falls back to the pause-based split uncleaned), aiming for ≤ ~12 words. Timings come from the
  caption words. It also restores punctuation and
  capitals and fixes **clearly** misrecognised words from text + context (no audio). It returns
  `changed` + `unsure` words, which **all become flags** (a changed word shows the original caption
  word). Guard rail: a cleanup that rewrites more than ~40% of a sentence is rejected.
- Whisper, GigaAM and proofread are skipped. Translate/review/voices run as normal (AI if a key
  is set, else free). There's no `media.mp4`: `lesson.video=false`, and the release body has
  `video:false, engine:"captions"`.
- App: captions lessons **always play through the YouTube player** (even if "Downloaded" is
  selected). Review has no video clips for them (the voice still works). The list shows
  "Captions · …", and the ••• menu explains the source and the number of corrected words.
- **First real run (study-o1qa70gkuyaq, breakfast video, automatic captions, ~25 min):** 218
  sentences (median 12 words vs 5 in the AI lesson), 64 words corrected, 22 sentences rejected by
  the guard rail, 77 flags. **~93% of words match the AI lesson** (ignoring е/ё). Problems seen:
  words stuck in the wrong sentence ("…пахнет" / "Вкусно, сначала…" instead of "Пахнет вкусно."),
  over-eager fixes (Шишки → Сушки), wrong endings, misheard short words. Fixed afterwards: Claude
  now re-splits sentences (above) and is told to leave words that make sense; empty literal
  meanings on common words ("это") get a fallback from `enrich_free.COMMON`. Not yet re-run.
- **Owner's verdict after comparing on the phone:** "too far off": the words don't match the
  creator's captions burned into the video picture, and some words are there that shouldn't be.
  Conclusion: **YouTube's automatic captions are not accurate enough** for the owner's standard, even
  after Claude's cleanup (Claude can't hear the audio). Burned-in subtitles are exact but are pixels
  (only reachable by downloading the video); they're also lightly edited (fillers dropped), so a
  few "extra" words are really spoken. Captions lessons are only promising for videos with a
  **creator-uploaded CC track**. Accurate lessons otherwise need the audio (AI engine).
- **Caption check** (`captions-check.yml`, "Check Captions First" button, shown when Captions (test)
  is selected): `download.sh` QUALITY=check (`--skip-download`, info.json only, WARP fallback),
  then `scripts/study/check_captions.py` summarises it into release `check-<id>`:
  `{ok, kind:"check", creator:[ru tracks from info.subtitles], auto: bool, language, title}`.
  `auto` is only true when the *original* language is Russian (the `-orig` auto track, or
  info.language), because `automatic_captions` also lists machine translations into every
  language. The app polls `releases/tags/check-<id>` every 5 s (up to 6 min), shows ✓ creator
  captions / ⚠ automatic only (~93%) / ✗ none, then deletes the release and tag; `cleanup.yml`
  also deletes leftover `check-*` after 24 h. Make Lesson (Captions engine) then refuses a video
  with no Russian captions and asks for confirmation when only automatic ones exist
  (`checkResults` map, per video id, this session only). Tested with mocked API; **not yet run
  for real** (the owner should try it on a video they think has CC).
- YouTube playback on iPhone: `playVideo()` right after `seekTo()` is often dropped (YouTube's
  big ▶ stays). `player.play()` retries until state 1, a pause event within 1.5 s of a play request
  is ignored, and `playSentence` skips the seek when already within 0.6 s before the sentence.

### `lesson.json` shape
```json
{
  "title": "...", "url": "https://youtu.be/...", "duration": 1685, "thumbnail": "...",
  "source": "whisper|subtitles|creator-captions|auto-captions", "engine": "ai|free|captions", "video": true, "model": "claude-sonnet-5", "enriched": 423,
  "checks": {"second": "GigaAM v3", "agreement": 0.891, "doubtful_sentences": 186,
             "proofread_fixed": 43, "proofread_confirmed": 143, "proofread_rejected": 0,
             "review_word_fixes": 48, "review_translation_fixes": 0, "review_flags": 11,
             "flagged_words": 45},
  "audio": {"voice": "ru-RU-SvetlanaNeural", "rates": ["-25%", "-40%"],
            "clips": {"люблю": ["defd9f4ebb4e.mp3", "2b94b4db21ff.mp3"]}},
  "sentences": [{
    "start": 3.4, "end": 7.5, "ru": "Я очень люблю завтракать дома.",
    "en": "I really love having breakfast at home.",
    "tokens": [{"w": "люблю́", "g": "love", "b": "люби́ть", "m": "to love, like",
                "t": [4.1, 4.7], "u": {"alt": "...", "note": "..."}}]
  }]
}
```

### `voices.yml` ("Add voices")
For lessons made without audio: downloads `lesson.json` from `study-<id>`, runs `voices.py`, uploads
`audio.zip` + `lesson.json` (`--clobber`), and rebuilds the site. Triggered from a lesson's •••
menu → **🎙️ Add Natural Voice** (shown only when `lesson.audio` is missing).

---

## 6. The Study tab (study.js) — screens and controls

### Study home
- **Review card** (gradient): "N cards to review · X sentences mined · Y words saved"; the
  **Review** button is disabled when nothing is due. The tab badge shows the due count.
  **See All** opens the **Saved** page (`#screen-saved`, `openSaved`/`renderSaved`): Words /
  Sentences switch, search (Russian ignoring stress marks, or English), each row shows when it's
  due; tapping one opens a sheet (word: syllables, 🔊 Normal/🐢 Slowly, dictionary form, the
  sentence; sentence: interlinear + English) with **Open in Lesson** (jumps to that sentence),
  **Review It Now** (reviews that one card immediately, then back to Saved) and **Remove**. **Review All N** reviews every saved word (or
  sentence) regardless of due date; back from that review returns to Saved. Added because the owner
  saw "1 of 2" in review with no way to see all saved words (review shows one card at a time).
- **New lesson:** URL box, **Free / AI (best) / Captions (test)** switch (saved as `prefs.engine`,
  default `free`; **the owner uses AI**; note that clearing storage resets it to Free, which once
  started a Free lesson by mistake), **Check Captions First** (Captions only, see §5), **Make Lesson**.
- **Play lessons from:** **Downloaded** (our `media.mp4`) or **YouTube (test)** (the YouTube IFrame
  player; see §7). Saved as `prefs.player`.
- **Lessons list**, built from `study-*` releases plus in-progress `study.yml` runs. It shows the
  stage ("Downloading video / Transcribing speech / Double-checking with a 2nd transcriber /
  Proofreading doubtful words / Adding meanings, translations & final check / Publishing lesson"),
  "AI · 423 sentences · 28:05", or Failed (a sheet with Try Again / View Log / Remove). Rows in
  progress are prefixed with the engine ("Free · Transcribing speech…", "Captions · Reading
  captions…"); tapping one opens a sheet with View Progress on GitHub and **Stop & Remove**
  (`stStopLesson`: cancels the run via the API, then adds the id to `deletedLessons`).
  **Deleted lesson ids are remembered** (`deletedLessons`), and finished runs older than 10 min with
  no release are ignored, which fixed a "ghost Publishing lesson" bug.

### Lesson page
- The video sits at the top (sticky). Below it:
  - a **scrub bar** (time, drag, length);
  - controls: **⏮ ▶ ⏭**, **speed 1× / 0.75× / 0.5×**, **Loop**, **Pause each**;
  - toggles: **Literal**, **English**, **Follow** (auto-scroll).
  - Literal/English are faded and show an explanation toast on lessons without meanings.
- **Transcript:** each sentence shows words in columns (the stressed Russian word above its
  literal meaning), the English line below, and on the right **▶** (replay the sentence) and
  **☆** (save the sentence).
- **Highlighting: only the sentence**, never individual words (the owner found word-by-word
  highlighting hard to follow). **Auto-scroll** keeps the current sentence just under the video
  and pauses for 4 s after a manual scroll.
- **Tapping a sentence** (or ▶ or its English line) replays exactly that sentence, using
  `sentenceBounds(i)`: it starts up to 0.15 s early but never before the previous sentence ends,
  and stops up to 0.25 s late but never later than 0.08 s before the next sentence starts. In
  YouTube mode it stops a further 0.1 s early, because YouTube reports its position late. This
  prevents bleed into the next sentence. While replaying one sentence, the **highlight is locked** to it, so the
  next sentence can't steal it during the padding. The lock is released for continuous play or
  after a scrub.
- **Pause each is ON by default every time a lesson opens** (both Downloaded and YouTube modes), so
  the first play stops at the end of the first sentence. If playback starts some other way (e.g.
  YouTube's own play button) while Pause each/Loop is on, `tick()` arms the stop at the end of the
  sentence being spoken.
- **Loop** repeats the sentence until ▶ is tapped. **Pause each** stops after every sentence, and ▶
  plays the next one. Switching either **on while the video is playing takes effect immediately**
  (`armCurrentSentence()` arms a stop at the end of the sentence being spoken). Switching both off
  returns to plain playback.
- **Whenever playback starts, however it's started** (our ▶ in Pause each or continuous mode, a
  sentence tap, ⏮ ⏭, or YouTube's own play button), the transcript **jumps instantly** back to the
  sentence being played, highlighted at the top just under the video, no matter where the learner
  scrolled. Auto-follow resumes immediately (the 4 s manual-scroll pause is cleared). See
  `returnToSentence(i)`; `startTick()` always sets `justStarted`. Setting `scrollTop` directly also
  stops leftover iOS flick momentum. This happens **even with Follow off** (Follow only controls
  scrolling along during playback).
- Toggling **Literal/English** changes every sentence's height. `keepPlace()` then re-pins the
  current sentence just under the video (or keeps the top visible sentence in place).
- The **scrub bar** only shows with the downloaded copy. It is **hidden in YouTube mode**, where
  YouTube's own bar is used; ours couldn't drive the YouTube player reliably.
- **Tapping a word** opens the word card and **immediately speaks the word, normal then slow**:
  - the word split into **syllables** (the stressed one in orange), each lit up in time with the
    audio;
  - **🔊 Normal**, **🐢 Slowly**, **🎬 From the video** (plays just that word's clip);
  - the literal meaning here, **dictionary form** (with its own 🔊) and **general meaning**;
  - the sentence with the word underlined, plus English;
  - **☆ Save Word** and **🚩 Report a Mistake**.
- **Voice:** it plays the lesson's recorded Svetlana clips (`files/<id>/audio/…`). Only if a word
  has no recording does it fall back to the phone's speechSynthesis (the owner found the phone
  voice "horrible", so the fallback should stay rare). The recordings map comes from each
  lesson's `lesson.json` (`ensureAudio`, preloaded in `studyShow` for every lesson with saved
  cards). If `speak()` is called before the map has loaded (it happened on the first review
  card), it plays a generated silent WAV inside the tap to unlock the voice player, waits for the
  map (up to 4 s), then plays the recording, instead of falling back to the phone voice.
- **Flagged words** (`u`) get a **dotted orange underline**. Their card shows "⚠️ This word may not
  be accurate", the reason, and what the second transcriber heard.
- **🚩 Report a Mistake** creates a **GitHub issue** in the repo (title "Lesson mistake: <word>",
  body with lesson, sentence, time, word, meanings, flag and the user's note). In the public version
  this becomes a DB table that fixes the shared lesson.
- **••• menu:** title; transcript source; **accuracy checks** summary; "Meanings made with";
  Open Original Video; 🎙️ Add Natural Voice (if missing); How to use this page; **Delete Lesson**
  (deletes the release and tag, dispatches `pages.yml`, remembers the id).
- **Saved words** get a gold dotted underline. Saved sentences get a gold star.

### Review (spaced repetition)
- Up to 50 due cards. **Sentence cards** rotate modes by `seen % 3`:
  - **read**: the Russian is shown;
  - **listen**: the clip plays and no text is shown;
  - **say**: the English is shown and you say it in Russian.
- **Word cards** alternate read / listen (the voice speaks the word).
- **Show** reveals all three lines (words get syllables and a timed highlight) and replays the
  clip or voice. Tools: ▶ Replay, 🐢 Slow; for words, 🔊 Normal / 🐢 Slowly / 🎬 Word / ▶ Sentence.
- **Grades (Anki-style, owner asked to match their Anki decks):** **Again / Hard / Good / Easy**
  with the wait shown above each label like Anki ("<1m", "<6m", "<10m", "3d"). Card fields
  `state` (`learn` | `review` | `relearn`), `step`, `ivl` (days), `ease`, `due`. New cards go
  through learning steps **1 min → 10 min** (Hard on the first step = 6 min), then graduate to
  **1 d**; Easy graduates straight to **3 d**. Review cards: Hard = ivl×1.2 (ease −0.15), Good =
  ivl×ease, Easy = ivl×ease×1.3 (ease +0.15), always Hard < Good < Easy and at least +1 d; Again
  = lapse (ease −0.2) → relearn 10 min → back at 1 d. Any card due again within 20 min is
  re-queued in the same session (Anki's learn-ahead). Cards saved before this change have no
  `state`: `cardState()` treats reps 0 as learning.
- **Card sync:** cards live in localStorage (`cards`) **and** are synced to the repo, in branch
  **`study-data`**, file **`cards.json`** `{version:1, cards:{id: card}}`, via the Contents API.
  Saves are debounced (4 s) and flushed when the app is hidden. Merges are last-write-wins per
  card by `updated`. Deletions are tombstones (`deleted:true`). The branch is created from the
  default branch on first save. This protects against iOS clearing web storage and allows
  multiple devices.
- **Card ids:** sentence `"<lesson>:<i>"`; word `"<lesson>:<i>:<k>"` (`kind:"word"` with
  w, g, b, m, t and the sentence context).

### Browser storage keys (localStorage, prefix `grab.`)
`cfg` (owner, repo, token, branch), `jobs`, `current`, `quality`, `tab`, `lessons`,
`deletedLessons`, `cards`, `studyPrefs` (engine, player, literal, english, follow, loop,
autopause (reset to on per lesson), speed), `pos.<lessonId>` (last sentence).

---

## 7. YouTube playback test mode

`player` in study.js abstracts playback (`time`, `duration`, `seek`, `play`, `pause`, `setRate`)
over either the `<video>` element or the **YouTube IFrame API** (`playsinline`, `controls:1`,
`rel:0`). Because YouTube reports state changes late, `player.want` tracks intent. The video ID
comes from the lesson URL (youtu.be, watch?v=, shorts, embed, live). Non-YouTube links or
embedding-disabled videos fall back to the downloaded copy. On iPhone the user must **tap play on
the YouTube player once** before the app can control it. Word clips get +0.3 s padding in YouTube
mode. **Status: built and tested with a fake player; the owner still needs to evaluate it on the
phone** (timing precision, ads, feel). Review mode still uses the downloaded copy.

---

## 8. Measured results (first full AI lesson, 2026-09-28)

Video: Easy Russian "Having Breakfast in Slow Russian | Super Easy Russian 42" (`youtu.be/AlUMYm5YExA`,
28:05). Lesson id **`4g592n9bv0ta`**. It has **no separate Russian CC track** (subtitles are burned
into the picture), so Whisper was used. YouTube blocked GitHub, and the WARP fallback got through.

| Step | Time | Result |
|---|---|---|
| Whisper large-v3 (CPU) | 20½ min | 423 sentences |
| GigaAM v3 | 2 min | 89.1% agreement; 186 sentences with doubts |
| Proofread (Sonnet 5) | 1 min | 43 corrected, 143 confirmed, 0 rejected; 36 still flagged |
| Translate + review | 10 min | 423/423 translated; 76 RUAccent stress disagreements → 48 fixes; 11 review flags |
| Voices | 4½ min | 1,178 words × 2 speeds = 2,356 clips |
| **Total** | **~42 min** | **45 words flagged** (~1 in 50) |

For comparison, the earlier turbo-model run took ~6½ min to transcribe. **API cost was not logged.**
The owner was asked to check platform.claude.com → Usage. Rough estimate: a few dollars for a
28-min video (translation dominates). Logging `usage` per lesson is a pending idea.

---

## 9. Rules and preferences the owner set (keep honouring these)

- **No grammar teaching.** No case or aspect labels anywhere. Sentence mining only: real sentences,
  literal gloss + plain English.
- **Accuracy matters more than anything.** They want "nearly 100%". Hence the triple check, the
  never-invent rule, the guard rails, and **flagging uncertainty to the user instead of guessing**.
- Use **two transcribers** (and, for more languages, a per-language second engine) and let Claude
  **double/triple check**. Flag doubtful words visibly.
- **Sentence highlight only**, with **auto-scroll**. Tap a word for the voice. Normal **and** slow
  speeds. Syllables highlighted.
- **Voice must sound natural**: the russian-study neural voice, not the phone's robotic one.
- They care about **cost** (they don't want to pay per video in the public product, or make users
  pay), and about **speed** (users shouldn't wait long). See §12.
- They use an **iPhone only**: give tap-by-tap instructions, never ask them to use a terminal,
  and never ask them to paste secrets into chat.

---

## 10. Known limitations and gotchas

- **GitHub Actions/Pages are for this personal trial only.** GitHub's terms don't fit a public
  service. Pages is limited to 1 GB (~10–15 lesson videos at 480p plus audio).
- **Re-hosting other people's videos** is fine as a personal grey area but not for a public
  service. That's why YouTube-embed playback is being tested.
- **Claude can't hear audio.** Proofreading is text/context-based, so unresolved doubts stay flagged.
- **edge-tts** uses an unofficial Microsoft endpoint (fine personally). The public version should
  use **Azure Speech** (same voices, official).
- Lessons made **before** a feature existed don't get it retroactively (except voices via
  **Add Natural Voice**). Remake the lesson to get meanings, word timings and checks.
- Syllable splitting is rule-based (`syllables()` in study.js; one vowel per syllable, sonorant/й
  cluster rule, soft/hard sign stays with its consonant). Tested on common words.
- The in-app ↻ refreshes the lesson list only. App updates need **Safari's ↻**. GitHub Pages sends
  `cache-control: max-age=600`, and the service worker used to fetch through that HTTP cache, so
  reloads showed the old app for up to 10 min. Since `grab-v26` it fetches with
  `cache: 'no-cache'` (and installs with `cache: 'reload'`), so one reload is enough.
- **Pressing play always returns the transcript to the sentence being played**, by any play button
  (ours, a sentence tap, or YouTube's own), even with **Follow** off; Follow only controls
  scrolling along during playback. The owner cares a lot about this.
- Library/download history is **local only** (`grab.jobs`); after storage loss, only downloads
  from the last 24 h come back (`syncRemote` lists `download.yml` runs). Lessons always come back
  (they're rebuilt from releases).
- iOS needs a user tap before audio or video can play (all speak/play calls happen inside taps).
- **Testing locally:** Playwright + the pre-installed Chromium at
  `/opt/pw-browsers/chromium-*/chrome-linux*/chrome` (pass `executablePath`). Serve a copy of
  `app/` with a fake `files/<id>/lesson.json`, mock `api.github.com` (and
  `youtube.com/iframe_api`) with `page.route`. The sandbox proxy blocks the browser from opening
  github.io directly. Don't `pkill -f` a pattern that matches your own shell command.
- The GitHub MCP token **cannot dispatch, re-run or cancel workflows** (403). Pushing to `app/**`
  triggers `pages.yml`; otherwise ask the owner to tap buttons in the app (Stop & Remove cancels a
  lesson), or to use github.com → Actions → run → ••• → Cancel workflow. Warn them **not to
  re-run old "Deploy app" runs**: that redeploys an older commit (it happened once; fixed by
  pushing a new app change).
- Public release/asset info can be read without auth via `curl https://api.github.com/repos/...`
  and `https://github.com/<repo>/releases/download/<tag>/lesson.json` from the sandbox (useful to
  inspect lessons).

---

## 11. Timeline (what was done, in order)

1. Built Grab: PWA + download/cleanup/pages workflows; the repo was made public, Pages enabled,
   and the token set up.
2. Solved token confusion (Safari vs Home Screen storage) with Show/Copy Token.
3. YouTube "not a bot" block: added a PO-token provider and client retries (not enough), then the
   **WARP fallback** (owner-approved; works).
4. "Save to iPhone" failed (release host has no CORS), so files are republished on Pages and
   fetched same-origin. Saving to Photos works.
5. Added the Study tab: transcript, three-line sentences, tap-to-replay, loop, pause each, speeds,
   ☆ mining, SRS review, card sync.
6. Added "Use for Russian Study" on every finished download.
7. Tap-a-word card, word flashcards, dictionary forms; later removed the word-by-word playback
   highlight; auto-scroll, syllables, normal + slow.
8. Free engine (open-source tools) alongside the Claude engine.
9. YouTube embed playback test mode.
10. Whisper **large-v3** + per-word confidence.
11. **Triple accuracy check** (GigaAM second transcriber, Claude proofread with a guard rail,
    Claude final review + RUAccent), flags, Report a Mistake. AI engine → Sonnet 5.
12. **Natural voice** (edge-tts Svetlana, -25%/-40%) and the Add voices workflow.
13. The first full AI lesson ran successfully (see §8). The old keyless lesson was deleted.
14. Fixed the ghost "Publishing lesson…" row, the loop highlight jumping to the next sentence,
    and added the scrub bar.
15. Playback polish: Pause each on by default and immediate, no bleed into the next sentence,
    place kept on Literal/English toggles, scrub bar hidden in YouTube mode, play jumps back to the
    spoken sentence.
16. **Captions (test)** engine built (no download). First real run on the breakfast video
    (`study-o1qa70gkuyaq`): ~93% word match with the AI lesson; the owner judged it too inaccurate.
    Afterwards: Claude re-splits caption words into real sentences, fewer over-eager fixes,
    fallback glosses for common words (not yet re-run).
17. Engine label on in-progress lessons; **Stop & Remove** for lessons being made; the reload
    (HTTP cache) fix; YouTube first-tap play fix; play returns to the sentence even with Follow
    off; **Caption check**.

---

## 12. Where things were left off and what's next

### Immediately pending (owner's side)
1. Study with lesson `4g592n9bv0ta` (AI). Check **whether the 45 flagged words were really wrong**.
2. **Check the real cost** in platform.claude.com → Usage (still unknown; needed for pricing).
3. Keep reporting YouTube-mode bugs from the Captions lesson (`o1qa70gkuyaq`). Fixed so far: first
   tap of ▶ not playing; play not returning to the sentence with Follow off. Ask for screenshots.
4. Try **Check Captions First** on a video that has a creator CC track; if it has one, make a
   Captions lesson and compare accuracy. Optionally remake the breakfast Captions lesson to see
   the re-split sentences (it will still be ~93% on words).
5. Add Grab to the Home Screen so storage survives (••• → Share → Add to Home Screen).

### Suggested next engineering steps (discussed, not built)
- Log the Claude `usage` (tokens → $) per lesson and show it in the ••• menu.
- Show a lesson while it's still being made (process the first minutes first).
- Use creator-provided **English** subtitles when they exist (align to Russian sentences).
- "Download for offline" lessons.
- Speed: move Whisper/GigaAM to a **serverless GPU** (Modal / RunPod Serverless / Replicate). The
  owner will create the account and add the key as a secret. That cuts ~20 min to ~1 min.

### Monetization (discussed 2026-09-29; owner wants money without many hoops, but very accurate)
Recommendation given: a **subscription** (≈ $9.99/month or $59/year; Apple takes 15% on the small
business program; RevenueCat) with three lesson sources: (1) **"Import your own"** video/audio
(the user supplies content they have rights to; full accurate pipeline; monthly cap, e.g. 10),
(2) an **owned library** (paid native-speaker recordings + Creative Commons), made once and shared,
(3) **YouTube captions mode** as the free hook, but only where a creator CC track exists (see the
verdict in §5). Creator permission by email helps only if the creator **sends the files**
(YouTube's terms still forbid downloading from YouTube); playback stays on YouTube. A lawyer
should review the terms of use and any creator license. Pricing depends on the real per-lesson
cost (item 2 above).

### The public version (owner's stated goal: Vercel + Supabase, many languages)
- **Frontend** on Vercel. **Supabase:** auth, a **shared lesson library keyed by video ID** (each
  video processed once and shared by all users, which makes the cost per video, not per user),
  users' cards/progress, and mistake reports that fix the shared lesson.
- **Playback via the YouTube IFrame player** (don't host videos). Also creator partnerships, CC
  content, and user uploads. Get legal advice on transcripts of copyrighted videos.
- A **processing worker** off Vercel (Vercel functions can't run Whisper), on serverless GPU.
- **Per language:** Whisper plus a second ASR (specialist open model or a paid API such as
  Deepgram / AssemblyAI / Google / ElevenLabs Scribe), a stress/pronunciation tool where relevant,
  and **Azure Speech** voices.
- **Cost stance:** the owner does not want to pay per user. Options discussed: the shared library
  (pay once per video), free tools by default with AI upgrades for popular videos, cheaper models
  with batch processing, and a premium tier. Accuracy is non-negotiable for them, so the
  recommendation was **Claude Sonnet 5** + the triple check, with costs amortized across users.
- The lesson JSON format above is intended to carry straight over into Supabase.

---

## 13. File map

```
app/                       static PWA (deployed to Pages)
  index.html               all screens: Download, Study, Lesson, Review, Library, Settings, sheet, tab bar
  app.js                   Grab downloader, GitHub API helper gh(), navigation, settings, shared helpers
  study.js                 Study tab: lessons, player abstraction (local/YouTube), transcript, scrub,
                           loop/pause-each, word card + voice + syllables, SRS review, card sync, reports
  style.css                iOS design tokens + all component styles (light/dark)
  sw.js                    service worker (network-first; bump CACHE on every app change; /files/ not cached)
  manifest.webmanifest, icons/
scripts/
  download.sh              yt-dlp with impersonation, PO tokens, WARP + client fallbacks;
                           study=480p+subs, captions=json3 captions only, check=info.json only
  iphone-compat.sh         ffmpeg → iPhone-friendly MP4
  publish.sh               dl-<id> release;  report-failure.sh: error release (TAG_PREFIX aware)
  build-site.sh            app + all release files → site/ (unzips audio.zip), 1 GB budget
  make-icons.py            app icons
  study/transcribe.py      subtitles or Whisper large-v3 → sentences.json (+word timings/confidence)
  study/second_asr.py      Check 1: GigaAM second transcript + word diff → doubts
  study/proofread.py       Check 2: Claude settles doubts (guard rail) → flags
  study/enrich.py          AI meanings/translations (Sonnet 5) + Check 3 review + RUAccent; shared helpers
  study/enrich_free.py     free meanings/translations (RUAccent, pymorphy3, OpenRussian, Argos)
  study/voices.py          edge-tts neural word audio (normal + slow)
  study/clean_captions.py  Captions test: Claude re-splits + cleans automatic captions → flags
  study/check_captions.py  Caption check: info.json → {creator tracks, auto} summary
  study/publish.sh         study-<id> release (media.mp4, lesson.json, audio.zip)
.github/workflows/
  download.yml, study.yml, voices.yml, captions-check.yml, cleanup.yml (dl-*/check-* > 24 h),
  pages.yml (reusable + push-triggered)
README.md                  user-facing setup and feature docs
HANDOFF.md                 this file
CLAUDE.md                  points new sessions here
```
