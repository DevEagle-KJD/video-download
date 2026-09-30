# Nativski — the public web app

Learn languages from real YouTube videos: the exact transcript with stress
marks, a literal word-by-word line, plain English, a natural voice for every
word and sentence, and Anki-style flashcards. Videos play **live through
YouTube's player** (creators keep their views and ads). Each video's lesson is
made **once** and shared by everyone.

```
web/
  public/            the app (static; installable on the iPhone Home Screen)
    index.html       screens: Sign in, Learn, Explore, Account, Lesson, Saved, Review
    core.js          helpers, sign-in (6-digit email code), Supabase REST client
    study.js         lessons, YouTube player, transcript, word card, voices, review, card sync
    style.css        shared with Grab (app/style.css); web.css has the additions
  api/               Vercel server functions
    config.js        public settings for the app (Supabase URL + anon key)
    lessons.js       POST: add a video (approved channel? free-plan limit?), start the lesson maker
  supabase/schema.sql  database tables, security rules, storage bucket
../.github/workflows/web-lesson.yml   the lesson maker (Whisper + GigaAM + Claude + voices → Supabase)
../scripts/web/      Supabase helpers for the lesson maker
```

## Setup (one time)

1. **Supabase** (supabase.com → New project)
   - SQL Editor → New query → paste all of `supabase/schema.sql` → Run.
   - Authentication → Emails (Email Templates) → **Magic Link**: make the message
     include the code, e.g. `Your sign-in code: {{ .Token }}`. (The app signs in
     with the 6-digit code, which works inside the Home Screen app.)
   - Project Settings → API: note the **Project URL**, the **anon public** key and
     the **service_role** key (secret!).
   - Table Editor → `channels` → add each approved channel:
     `author_url` = `https://www.youtube.com/@channelhandle` (lowercase), `approved` = true.
2. **GitHub** (this repo → Settings → Secrets and variables → Actions → New secret):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`ANTHROPIC_API_KEY` is already there).
3. **GitHub token for the server**: github.com/settings/personal-access-tokens/new
   (fine-grained) → only this repo → Permissions: **Actions: Read and write**.
4. **Vercel** (vercel.com → Add New → Project → import this repo)
   - Root Directory: `web` · Framework: Other.
   - Environment Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN` (step 3),
     `GITHUB_REPO` = `DevEagle-KJD/video-download`,
     `GITHUB_REF` = `claude/iphone-video-downloader-pwqipq`,
     `ADMIN_EMAILS` = your email (admins can add any video),
     optional `APP_NAME`, `FREE_LESSONS_PER_WEEK` (default 3).
   - Deploy.

## How a lesson is made

Add video → `api/lessons.js` checks the channel is approved (or the user is an
admin) and the free-plan limit, then either links the existing lesson or
inserts a `lessons` row and starts `web-lesson.yml`. The workflow updates
`lessons.stage` as it goes, uploads `lesson.json` and the voice clips to the
public `lessons` bucket (`<video_id>/…`) and marks the row `ready`.

Plans: `profiles.plan` = `free` (3 new lessons/week; studying and review
unlimited) or `pro` (set by hand until Stripe is added).
