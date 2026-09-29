# Grab (video downloader + Russian study app)

**Before doing anything, read `HANDOFF.md`.** It explains the whole app (architecture, workflows,
the Study pipeline and its accuracy rules, every control and data format), the owner's preferences,
and exactly where work was left off.

Quick rules:
- Work on branch `claude/iphone-video-downloader-pwqipq` (it's the repo's default branch; workflows run from it).
- The owner uses an **iPhone only**. Give tap-by-tap instructions. Never ask them to paste secrets or tokens into chat.
- After changing anything in `app/`, bump `CACHE` in `app/sw.js`. Pushing `app/**` redeploys Pages in about a minute; tell the owner to reload with Safari's address-bar ↻.
- Study lessons: no grammar labels, ever. Accuracy comes first; flag uncertainty instead of guessing.
- Test UI changes with Playwright (Chromium at `/opt/pw-browsers`) against a local copy of `app/`, with GitHub/YouTube APIs mocked (see HANDOFF.md §10).
