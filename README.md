# Grab

A private video downloader that looks and feels like a native iPhone app. You add it to
your Home Screen, and it runs entirely on GitHub, with no server to pay for.

- **Paste any link.** Grab uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), which supports
  YouTube, TikTok, Instagram, X/Twitter, Facebook, Reddit, Vimeo, Twitch, SoundCloud and
  [~1,800 other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). It
  also detects videos embedded in ordinary web pages and handles direct `.mp4`/`.m3u8` links.
- **Pick a quality:** **Best** (up to 4K/8K), **1080p**, **720p**, or **MP3** (audio only).
- **Save to Photos.** Files are converted to iPhone-friendly MP4 (H.264/HEVC + AAC) when
  needed. Tap **Save Video** in the share sheet to put the file in Photos, or **Save to Files**
  for an MP3.
- **Share Sheet shortcut.** Tap *Share → Grab* in any app to start a download in the background.

```
iPhone (Grab app on GitHub Pages)
   │  1. "download this URL at 1080p"  ──►  GitHub API (workflow_dispatch)
   │                                          │
   │                                   2. GitHub Actions runner:
   │                                      yt-dlp + ffmpeg → media.mp4
   │                                      → temporary release "dl-<id>"
   │  3. pull the file, open share sheet ◄────┘
   ▼
 Photos / Files        (release is deleted after saving, or after 24 h)
```

## Why MP3 for audio?

MP3 plays everywhere: iPhone, cars, old players, and every editing app. Grab encodes it at
LAME **VBR V0** (about 245 kbps), which sounds the same as the source to human ears, and
embeds the title and cover art. AAC/M4A is slightly more efficient at the same size, but it
doesn't sound noticeably better at this bitrate and isn't supported as widely. MP3 is the better default.

## Setup (about 5 minutes)

1. **Put this code on the default branch** (usually `main`). GitHub only runs
   `workflow_dispatch` workflows from the default branch.
2. **Turn on GitHub Pages:** repo **Settings → Pages → Build and deployment → Source:
   GitHub Actions**. Then run the **Deploy app** workflow once (Actions tab → Deploy app →
   Run workflow). Your app is served at `https://<you>.github.io/<repo>/`.
3. **Create a token:** go to
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   and create a fine-grained token with these settings:
   - Repository access: **Only select repositories →** this repo
   - Permissions: **Actions: Read and write**, **Contents: Read and write**
     (Metadata: Read-only is added automatically)
   - Give it a long expiration so you don't have to recreate it often.
4. **On your iPhone:** open the Pages URL in **Safari**, tap **Share → Add to Home
   Screen**, then open **Grab** from the Home Screen. Go to **Settings**, paste the token,
   and tap **Save & Test Connection**.
5. *(Optional)* In **Settings → Download from any app**, follow the steps to build the
   Share Sheet shortcut.

### Who can use it

- Only accounts with **write access to this repo** can start a download. That's you. GitHub
  enforces this. Anyone else who opens the page just sees an app that can't do anything.
- Your token is stored only in the app on your phone. It's never committed or sent anywhere
  except `api.github.com`.
- **Public vs. private repo:** a free GitHub account can only serve Pages from a **public**
  repo. That's safe (the code contains no secrets), but while a finished download is waiting
  for you, it's visible on the repo's *Releases* page. Grab deletes the release as soon as
  you save the file, and the **Cleanup** workflow deletes anything left over after 24 hours.
  With GitHub Pro you can make the repo private so nothing is ever visible.

## Sites that need you to be logged in (and YouTube's "not a bot" check)

GitHub's servers are in data centers. YouTube sometimes answers them with *"Sign in to
confirm you're not a bot"*. Private or age-restricted videos and members-only content on
any site also need a logged-in session. To handle both:

1. On a computer, sign in to the site in Chrome or Firefox and install a "cookies.txt"
   export extension (for example, *Get cookies.txt LOCALLY*).
2. Export the cookies in **Netscape format**.
3. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
   Name it `YTDLP_COOKIES` and paste the whole file as the value.

Use a spare account for this if you can. Cookies expire, so export them again if the errors
come back.

## What can't be downloaded

DRM-protected streams (Netflix, Disney+, Prime Video, Hulu, Max, Apple TV+, Spotify and
similar) are encrypted, so no downloader can save them. Grab tells you when it hits one. Only
download content you have the right to save.

## Limits

- GitHub Actions is free for public repos. Private repos get 2,000 minutes a month on the free plan.
  A typical download takes 1–3 minutes, including about 20–40 s for the runner to start.
- Each file can be at most 2 GB (GitHub's release limit). A single run can take at most 2 hours.
- 4K from YouTube arrives as VP9/AV1, which Photos can't play well, so Grab re-encodes it to
  H.264. That can take a few minutes for long videos. 1080p and 720p usually need no re-encoding.
- Files larger than about 1.5 GB may be too big for Safari to hold in memory. For those, use
  **Open Link** instead of **Save to iPhone**.

## Deep link

`https://<you>.github.io/<repo>/?url=<link>&q=best|1080|720|audio&go=1` opens Grab with
the link filled in. `go=1` starts the download right away. Note: iOS gives Home Screen
apps separate storage from Safari, so a link opened in Safari needs the token entered there too.
The Share Sheet shortcut above doesn't have this problem.

## Project layout

| Path | What it is |
| --- | --- |
| `app/` | The iPhone web app (HTML/CSS/JS, service worker, manifest, icons) |
| `.github/workflows/download.yml` | Runs yt-dlp + ffmpeg and publishes the file |
| `.github/workflows/cleanup.yml` | Deletes downloads older than 24 h (every 6 h) |
| `.github/workflows/pages.yml` | Deploys `app/` to GitHub Pages |
| `scripts/` | The shell scripts the Download workflow runs, plus the icon generator |
