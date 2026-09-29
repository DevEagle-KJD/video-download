'use strict';

/* Study tab: Russian lessons made from videos (sentence mining).
 *
 * A lesson is made by the "Study" workflow and published at
 * files/<id>/lesson.json + files/<id>/media.mp4 on this site. Each sentence
 * has start/end times, tokens [{w: stressed word, g: literal meaning}] and a
 * natural English translation (en).
 *
 * Starred sentences become flashcards, scheduled with a simple spaced-
 * repetition algorithm and synced to the repo (branch "study-data",
 * cards.json) so they survive Safari clearing storage and work on any device.
 *
 * Uses helpers from app.js: $, esc, gh, cfg, store, toast, configured,
 * randomId, defaultBranch, showScreen, openSheet, closeSheet, fmtDuration, fmtAgo. */

const ST_WORKFLOW = 'study.yml';
const ST_STAGES = [
  ['Download', 'Downloading video'],
  ['Convert for iPhone', 'Preparing video'],
  ['Transcribe', 'Transcribing speech'],
  ['Second opinion', 'Double-checking with a 2nd transcriber'],
  ['Proofread', 'Proofreading doubtful words'],
  ['Translate', 'Adding meanings, translations & final check'],
  ['Publish', 'Publishing lesson'],
];
const DAY = 864e5;
const PAD_BEFORE = 0.15, PAD_AFTER = 0.25;

let lessons = store.get('lessons', []);
const deletedLessons = new Set(store.get('deletedLessons', []));   // never show these again
let cards = store.get('cards', {});                 // id → card (deleted ones kept as tombstones)
const prefs = Object.assign({ player: 'local', engine: 'free', literal: true, english: true, follow: true, loop: false, autopause: true, speed: 1 },
  store.get('studyPrefs', {}));
const saveLessons = () => store.set('lessons', lessons);
const savePrefs = () => store.set('studyPrefs', prefs);

/* ───────── Lessons: create + track ───────── */
async function stStart(url) {
  if (!configured()) { toast('Add your GitHub token in Settings first'); showScreen('settings'); return; }
  const m = String(url || '').match(/https?:\/\/\S+/i);
  if (!m) { toast('Paste a video link first'); $('#st-url').focus(); return; }
  const lesson = { id: randomId(), url: m[0], created: Date.now(), state: 'starting', meta: { engine: prefs.engine } };
  lessons.unshift(lesson);
  saveLessons();
  stRender();
  try {
    await gh(`/actions/workflows/${ST_WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref: await defaultBranch(), inputs: { url: lesson.url, job_id: lesson.id, engine: prefs.engine } },
    });
    $('#st-url').value = '';
    toast('Making your lesson…');
  } catch (e) {
    lesson.state = 'failed';
    lesson.error = e.status === 404 ? 'The Study workflow wasn’t found on GitHub yet.' : e.message;
  }
  saveLessons();
  stRender();
  stSchedule(4000);
}
window.stStart = stStart;

function stageText(ghJobs) {
  const lessonJob = ghJobs.find(j => j.name === 'lesson');
  if (lessonJob && lessonJob.status !== 'completed') {
    const step = lessonJob.steps?.find(s => s.status === 'in_progress');
    const hit = step && ST_STAGES.find(([n]) => n === step.name);
    return hit ? hit[1] : 'Getting ready';
  }
  return 'Publishing lesson';
}

let stTimer = null, stBusy = false;
function stSchedule(ms = 15000) {
  clearTimeout(stTimer);
  stTimer = setTimeout(stRefresh, ms);
}

async function stRefresh() {
  if (stBusy || !configured() || document.hidden) return;
  stBusy = true;
  $('#st-refresh')?.classList.add('spin');
  try {
    const [runsRes, releases] = await Promise.all([
      gh(`/actions/workflows/${ST_WORKFLOW}/runs?per_page=30`).catch(e => (e.status === 404 ? { workflow_runs: [] } : Promise.reject(e))),
      gh('/releases?per_page=100'),
    ]);
    const runs = new Map();
    for (const r of runsRes.workflow_runs) {
      const m = /^study ([a-z0-9]{6,32})$/.exec(r.display_title);
      if (m && !runs.has(m[1])) runs.set(m[1], r);   // newest run per lesson
    }
    const byId = new Map(lessons.map(l => [l.id, l]));
    const next = [];

    for (const rel of releases.filter(r => r.tag_name.startsWith('study-'))) {
      const id = rel.tag_name.slice(6);
      if (deletedLessons.has(id)) continue;
      const l = byId.get(id) || { id, created: Date.parse(rel.created_at) };
      let meta = {};
      try { meta = JSON.parse(rel.body || '{}'); } catch { /* ignore */ }
      l.releaseId = rel.id;
      l.url = l.url || meta.url;
      if (meta.ok === false) {
        l.state = 'failed';
        l.error = meta.error;
        l.runUrl = meta.run;
      } else {
        l.meta = meta;
        const run = runs.get(id);
        l.state = run && run.status !== 'completed' ? 'processing' : 'ready';
        if (l.state === 'processing') l.stage = 'Publishing lesson';
      }
      next.push(l);
      byId.delete(id);
    }

    for (const [id, run] of runs) {
      if (next.some(l => l.id === id) || deletedLessons.has(id)) continue;
      // A finished run whose lesson no longer exists was deleted; don't resurrect it.
      if (run.status === 'completed' && run.conclusion === 'success' && Date.now() - Date.parse(run.updated_at || run.created_at) > 10 * 60e3) continue;
      const l = byId.get(id) || { id, created: Date.parse(run.created_at), url: '' };
      l.runId = run.id;
      l.runUrl = run.html_url;
      if (run.status !== 'completed') {
        l.state = 'processing';
        try { l.stage = stageText((await gh(`/actions/runs/${run.id}/jobs`)).jobs); } catch { /* keep old */ }
      } else if (run.conclusion === 'success') {
        l.state = 'processing';          // release list can lag a moment
        l.stage = 'Publishing lesson';
      } else {
        l.state = 'failed';
        l.error = l.error || (run.conclusion === 'cancelled' ? 'Cancelled.' : 'The lesson couldn’t be made.');
      }
      next.push(l);
      byId.delete(id);
    }

    // Just-requested lessons whose run hasn't shown up yet.
    for (const l of byId.values()) {
      if (l.state === 'starting' && Date.now() - l.created < 5 * 60e3) next.push(l);
      else if (l.state === 'failed' && !l.releaseId && Date.now() - l.created < DAY) next.push(l);
    }

    next.sort((a, b) => b.created - a.created);
    lessons = next;
    saveLessons();
    stRender();
  } catch (e) {
    console.warn('study refresh', e);
  } finally {
    stBusy = false;
    $('#st-refresh')?.classList.remove('spin');
  }
  if (lessons.some(l => l.state === 'starting' || l.state === 'processing')) stSchedule();
}

async function stDeleteLesson(l) {
  if (!confirm('Delete this lesson? Your flashcards from it stay, but without the video.')) return;
  try {
    if (l.releaseId) await gh(`/releases/${l.releaseId}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
    await gh(`/git/refs/tags/study-${l.id}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404 && e.status !== 422) throw e; });
    // Rebuild the site so the video file is removed from it too.
    gh('/actions/workflows/pages.yml/dispatches', { method: 'POST', body: { ref: await defaultBranch() } }).catch(() => {});
    lessons = lessons.filter(x => x !== l);
    deletedLessons.add(l.id);
    store.set('deletedLessons', [...deletedLessons]);
    saveLessons();
    closeSheet();
    stBack();
    stRender();
    toast('Lesson deleted');
  } catch (e) {
    toast(e.message);
  }
}

// Cancels the GitHub run making a lesson, then drops it from the list.
async function stStopLesson(l) {
  if (!confirm('Stop making this lesson and remove it?')) return;
  try {
    let runId = l.runId;
    if (!runId) {
      const { workflow_runs: runs } = await gh(`/actions/workflows/${ST_WORKFLOW}/runs?per_page=30`);
      runId = runs.find(r => r.display_title === `study ${l.id}` && r.status !== 'completed')?.id;
    }
    // 409: the run already finished.
    if (runId) await gh(`/actions/runs/${runId}/cancel`, { method: 'POST' }).catch(e => { if (e.status !== 409) throw e; });
    lessons = lessons.filter(x => x !== l);
    deletedLessons.add(l.id);
    store.set('deletedLessons', [...deletedLessons]);
    saveLessons();
    closeSheet();
    stRender();
    toast('Lesson stopped');
  } catch (e) {
    toast(e.message);
  }
}

/* ───────── Study home ───────── */
function dueCards() {
  const now = Date.now();
  return Object.values(cards).filter(c => !c.deleted && c.due <= now).sort((a, b) => a.due - b.due);
}

const engineTag = e => ({ free: 'Free · ', ai: 'AI · ', captions: 'Captions · ' })[e] || '';

function stRender() {
  const live = Object.values(cards).filter(c => !c.deleted);
  const due = dueCards().length;
  const nWords = live.filter(c => c.kind === 'word').length, nSent = live.length - nWords;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  $('#st-review-card').innerHTML = live.length
    ? `<div class="rc-text"><b>${due ? `${plural(due, 'card')} to review` : 'All caught up'}</b>
         <span>${[nSent && `${plural(nSent, 'sentence')} mined`, nWords && `${plural(nWords, 'word')} saved`].filter(Boolean).join(' · ')}</span></div>
       <div class="rc-btns"><button class="rc-btn ghost" data-s="saved">See All</button>
       <button class="rc-btn" data-s="review" ${due ? '' : 'disabled'}>Review</button></div>`
    : `<div class="rc-text"><b>Mine your first sentence</b>
         <span>Open a lesson and tap ☆ on sentences you want to learn.</span></div>`;
  const badge = $('#st-badge');
  badge.hidden = !due;
  badge.textContent = due > 99 ? '99+' : due;

  $('#st-lessons').innerHTML = lessons.length ? lessons.map(l => {
    const m = l.meta || {};
    const title = m.title || hostOf(l.url) || 'New lesson';
    let sub, dot = '';
    if (l.state === 'ready') {
      const mined = live.filter(c => c.lesson === l.id && c.kind !== 'word').length;
      sub = `${engineTag(m.engine)}${m.count || 0} sentences${mined ? ` · ${mined} mined` : ''}${m.duration ? ` · ${fmtDuration(m.duration)}` : ''}`;
      dot = 'ready';
    } else if (l.state === 'failed') {
      sub = 'Failed'; dot = 'failed';
    } else {
      sub = engineTag(m.engine) + (l.state === 'starting' ? 'Sending to GitHub…'
        : `${m.engine === 'captions' && l.stage === 'Transcribing speech' ? 'Reading captions' : l.stage || 'Waiting for GitHub'}…`);
      dot = 'running';
    }
    const thumb = m.thumbnail
      ? `<img src="${esc(m.thumbnail)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : '';
    return `<button class="cell row" data-s="open" data-id="${l.id}">
      <div class="row-thumb" style="position:relative;overflow:hidden">${ICON.film}${thumb}</div>
      <div class="row-text">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub"><i class="dot ${dot}"></i>${esc(sub)}</div>
      </div>
      <svg class="chevron" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
    </button>`;
  }).join('') : `<div class="empty">${ICON.empty}<div>No lessons yet. Paste a Russian video link above.</div></div>`;
}

function studyShow() {
  // Load the word recordings for every lesson with saved cards, so review
  // never has to wait for them.
  [...new Set(Object.values(cards).filter(c => !c.deleted).map(c => c.lesson))].forEach(ensureAudio);
  stRender();
  stRefresh();
  syncLoad();
}
window.studyShow = studyShow;

/* ───────── Pages (lesson / review) ───────── */
let prevTab = 'study';
function stOpenPage(name) {
  document.body.classList.add('in-page');
  showScreen(name);
}
function stBack() {
  player.close();
  $('#rv-video').pause();
  stop();
  if (prevTab === 'saved') {       // review started from the Saved list: go back there
    prevTab = 'study';
    stOpenPage('saved');
    renderSaved();
    return;
  }
  document.body.classList.remove('in-page');
  showScreen(prevTab);
  stRender();
}

/* ───────── Player: our downloaded copy, or YouTube's embedded player ───────── */
// Everything in the lesson page talks to `player`, never to a <video> directly,
// so the same features (sentence replay, loop, slow, word clips) work on both.
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

let ytApi = null;
function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => { ytApi = null; reject(new Error('YouTube player failed to load')); };
      document.head.appendChild(tag);
    });
  }
  return ytApi;
}

const player = {
  mode: 'local',            // 'local' | 'youtube'
  yt: null,
  want: false,              // YouTube reports state changes late; track intent
  get video() { return $('#ls-video'); },
  get paused() { return this.mode === 'youtube' ? !this.want : this.video.paused; },
  get time() { return this.mode === 'youtube' ? (this.yt?.getCurrentTime?.() || 0) : this.video.currentTime; },
  get duration() {
    const d = this.mode === 'youtube' ? this.yt?.getDuration?.() : this.video.duration;
    return isFinite(d) && d > 0 ? d : (lesson?.data.duration || 0);
  },
  seek(t) { if (this.mode === 'youtube') this.yt?.seekTo?.(t, true); else this.video.currentTime = t; },
  play() {
    if (this.mode === 'youtube') {
      this.want = true; this.playAt = Date.now();
      this.yt?.playVideo?.(); setPlayIcon(true);
      // On iPhone, YouTube often drops a play request that arrives while it's
      // still seeking, leaving its big ▶ on screen. Ask again until it plays.
      clearTimeout(this.retry);
      const again = n => { this.retry = setTimeout(() => {
        const st = this.yt?.getPlayerState?.();
        if (!this.want || st === 1) return;
        if (st !== 3) this.yt?.playVideo?.();
        if (n) again(n - 1);
      }, 700); };
      again(3);
    } else this.video.play().catch(() => {});
  },
  pause() {
    if (this.mode === 'youtube') { this.want = false; clearTimeout(this.retry); this.yt?.pauseVideo?.(); setPlayIcon(false); }
    else this.video.pause();
  },
  setRate(r) { if (this.mode === 'youtube') this.yt?.setPlaybackRate?.(r); else this.video.playbackRate = r; },
  async open(l) {
    this.pause();
    const noVideo = lesson?.data.video === false || l.meta?.video === false;
    const id = prefs.player === 'youtube' || noVideo ? youtubeId(l.url || lesson?.data.url) : null;
    const box = $('#ls-yt');
    if (!id) {
      if (noVideo) toast('This captions-only lesson has no downloaded video and isn’t a YouTube link');
      else if (prefs.player === 'youtube') toast('Not a YouTube video, so playing the downloaded copy');
      this.mode = 'local';
      $('#screen-lesson .scrub').hidden = false;
      box.hidden = true;
      this.video.hidden = false;
      this.video.src = `files/${l.id}/media.mp4`;
      this.video.playbackRate = prefs.speed;
      return;
    }
    this.mode = 'youtube';
    $('#screen-lesson .scrub').hidden = true;   // YouTube has its own bar; ours can't drive it reliably
    this.video.removeAttribute('src');
    this.video.load();
    this.video.hidden = true;
    box.hidden = false;
    try {
      const YT = await loadYouTubeApi();
      if (this.yt) { this.yt.destroy(); this.yt = null; }
      box.innerHTML = '<div id="ls-yt-frame"></div>';
      this.yt = new YT.Player('ls-yt-frame', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, cc_load_policy: 0, controls: 1 },
        events: {
          onReady: () => this.setRate(prefs.speed),
          onStateChange: e => {
            // 1 playing, 3 buffering, 2 paused, 0 ended
            if (e.data === 1) { this.want = true; setPlayIcon(true); startTick(); }
            // A pause right after we asked to play is YouTube dropping the
            // request (see play()), not you pausing: keep trying.
            if (e.data === 2 && this.want && Date.now() - this.playAt < 1500) return;
            if (e.data === 2 || e.data === 0) { this.want = false; clearTimeout(this.retry); setPlayIcon(false); }
          },
          onError: e => toast(e.data === 101 || e.data === 150
            ? 'This video’s owner doesn’t allow playing it in other apps. Switch Study → Play from: Downloaded.'
            : 'YouTube couldn’t play this video'),
        },
      });
    } catch (e) {
      toast(e.message);
    }
  },
  close() {
    this.pause();
    this.video.pause();
  },
};

/* ───────── Lesson player ───────── */
let lesson = null;          // { id, data }
let cur = -1;               // active sentence index
let stopAt = null;          // stop playback at this time (sentence mode)
let loopFrom = null;        // loop start time when looping one sentence
let nextAfterStop = null;   // "Pause each": sentence to play on the next ▶
let lockedIdx = null;       // while replaying one sentence, keep it highlighted
let rafId = 0;

async function openLesson(l) {
  if (l.state === 'failed') {
    openSheet('Lesson failed', `<p class="job-error" style="font-size:15px">${esc(l.error || 'Something went wrong.').replace(/\n/g, '<br>')}</p>
      ${l.url ? `<button class="primary-button" data-s="retry" data-id="${l.id}" style="margin-top:16px">Try Again</button>` : ''}
      ${l.runUrl ? `<a class="secondary-button" href="${esc(l.runUrl)}" target="_blank" rel="noopener">View Log on GitHub</a>` : ''}
      <button class="secondary-button destructive" data-s="forget" data-id="${l.id}">Remove</button>`);
    return;
  }
  if (l.state !== 'ready') {
    openSheet('Lesson in progress', `<p style="font-size:15px;color:var(--secondary)">${esc(engineTag(l.meta?.engine))}${esc(l.stage || 'Still working')}… it’ll be ready soon.</p>
      ${l.runUrl ? `<a class="secondary-button" href="${esc(l.runUrl)}" target="_blank" rel="noopener">View Progress on GitHub</a>` : ''}
      <button class="secondary-button destructive" data-s="stop" data-id="${l.id}">Stop &amp; Remove</button>`);
    return;
  }

  let data;
  try {
    const res = await fetch(`files/${l.id}/lesson.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    toast('The lesson is still being published — try again in a minute');
    return;
  }
  lesson = { id: l.id, data, meta: l.meta || {}, url: l.url };
  audioMaps[l.id] = data.audio?.clips || {};
  cur = -1;
  stopAt = null; loopFrom = null; nextAfterStop = null; lockedIdx = null;
  // Every lesson starts in "Pause each": the first play stops at the end of the
  // first sentence. The learner can switch it off for continuous playback.
  prefs.autopause = true;
  savePrefs();
  player.open(l);
  $('#ls-title').textContent = data.title || 'Lesson';
  renderTranscript();
  syncChips();
  updateScrub(0);
  prevTab = 'study';
  stOpenPage('lesson');
  $('#screen-lesson').scrollTop = 0;
  const pos = store.get(`pos.${l.id}`, 0);
  if (pos > 0) setActive(pos, false);
}

// Word timings: from the lesson (Whisper), or estimated by word length.
function wordTimes(s) {
  if (s._t) return s._t;
  if (s.tokens.every(t => Array.isArray(t.t))) return (s._t = s.tokens.map(t => t.t));
  const lens = s.tokens.map(t => Math.max(1, plainWord(t.w).length));
  const total = lens.reduce((a, b) => a + b, 0);
  let pos = s.start;
  return (s._t = lens.map(L => { const d = (s.end - s.start) * L / total; const r = [pos, pos + d]; pos += d; return r; }));
}

// "Пра́в." → "Прав" (no stress marks or punctuation), for speech and matching.
function plainWord(w) {
  return String(w || '').normalize('NFD').replace(/\u0301/g, '').normalize('NFC').replace(/[^\p{L}\p{N}\s-]/gu, '').trim();
}

// hl: index of a token to highlight; i: sentence index to make words tappable.
function tokensHTML(tokens, withGloss, { i = null, hl = -1 } = {}) {
  return tokens.map((t, k) => {
    const saved = i != null && lesson && isSaved(`${lesson.id}:${i}:${k}`);
    const attrs = i != null ? ` data-s="word" data-i="${i}" data-k="${k}"` : '';
    return `<span class="tok${k === hl ? ' hl' : ''}${saved ? ' saved' : ''}${t.u ? ' unsure' : ''}"${attrs}><b>${esc(t.w)}</b>${withGloss ? `<i>${esc(t.g || ' ')}</i>` : ''}</span>`;
  }).join('');
}

const isSaved = id => cards[id] && !cards[id].deleted;

function renderTranscript() {
  const { data } = lesson;
  const noMeanings = !data.enriched;
  $('#ls-transcript').innerHTML =
    (noMeanings ? `<p class="section-footer" style="margin:12px 16px">This lesson has no translations yet. Add an <b>ANTHROPIC_API_KEY</b> secret to the repo (see README) and make it again.</p>` : '') +
    data.sentences.map((s, i) => {
      const starred = cards[`${lesson.id}:${i}`] && !cards[`${lesson.id}:${i}`].deleted;
      return `<div class="sent${starred ? ' starred' : ''}" data-s="sent" data-i="${i}">
        <div class="sent-main">
          <div class="il">${tokensHTML(s.tokens, true, { i })}</div>
          ${s.en ? `<p class="en">${esc(s.en)}</p>` : ''}
        </div>
        <div class="sent-side">
          <button class="replay" data-s="replay" data-i="${i}" aria-label="Replay sentence">
            <svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>
          </button>
          <button class="star" data-s="star" data-i="${i}" aria-label="Save sentence">
            <svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  applyDisplayPrefs();
}

function applyDisplayPrefs() {
  const t = $('#ls-transcript');
  t.classList.toggle('hide-literal', !prefs.literal);
  t.classList.toggle('hide-english', !prefs.english);
}

// Showing/hiding the literal or English lines changes every sentence's height.
// Keep the current sentence pinned just under the video (or, if none is active
// yet, keep whatever sentence was at the top where it was).
function keepPlace(change) {
  const scroller = $('#screen-lesson');
  const playerBottom = () => $('#screen-lesson .player').getBoundingClientRect().bottom;
  let anchor = cur >= 0 ? $(`#ls-transcript .sent[data-i="${cur}"]`) : null;
  const pinCurrent = !!anchor;
  if (!anchor) anchor = [...document.querySelectorAll('#ls-transcript .sent')].find(e => e.getBoundingClientRect().bottom > playerBottom());
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  change();
  if (!anchor) return;
  const target = pinCurrent ? playerBottom() + 12 : before;
  scroller.scrollBy({ top: anchor.getBoundingClientRect().top - target, behavior: 'instant' });
}

function syncChips() {
  $('#ls-speed').textContent = `${prefs.speed}×`;
  $('#ls-speed').classList.toggle('on', prefs.speed !== 1);
  $('#ls-loop').classList.toggle('on', prefs.loop);
  $('#ls-autopause').classList.toggle('on', prefs.autopause);
  const has = !!lesson?.data.enriched;
  $('#ls-literal').classList.toggle('on', has && prefs.literal);
  $('#ls-english').classList.toggle('on', has && prefs.english);
  $('#ls-literal').classList.toggle('off', !has);
  $('#ls-english').classList.toggle('off', !has);
  $('#ls-follow').classList.toggle('on', prefs.follow);
}

function sentenceAt(t) {
  const ss = lesson.data.sentences;
  // Last sentence that has started by time t.
  let lo = 0, hi = ss.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ss[mid].start - PAD_BEFORE <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function setActive(i, scroll = true) {
  if (i === cur) return;
  const t = $('#ls-transcript');
  t.querySelector('.sent.now')?.classList.remove('now');
  cur = i;
  const el = t.querySelector(`.sent[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('now');
  if (scroll) followSentence(el);
}

// Auto-scroll: keep the current sentence right under the video. A manual
// scroll pauses it for a few seconds so it doesn't fight your finger.
let userScrolledAt = 0;
['touchmove', 'wheel'].forEach(ev => $('#screen-lesson').addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));
// Pressing play (any way) jumps the transcript back to the sentence being
// played, highlighted at the top: instantly (setting scrollTop also stops any
// leftover finger-flick momentum), and resumes auto-follow straight away.
// This happens even with Follow off (Follow only controls scrolling along
// while the video plays).
function returnToSentence(i) {
  const el = $(`#ls-transcript .sent[data-i="${i}"]`);
  if (!el) return;
  userScrolledAt = 0;
  const scroller = $('#screen-lesson');
  const playerBottom = $('#screen-lesson .player').getBoundingClientRect().bottom;
  scroller.scrollTop += el.getBoundingClientRect().top - playerBottom - 12;
}

function followSentence(el, force = false) {
  if (!prefs.follow || (!force && Date.now() - userScrolledAt < 4000)) return;
  const playerBottom = $('#screen-lesson .player').getBoundingClientRect().bottom;
  const offset = el.getBoundingClientRect().top - playerBottom - 12;
  if (Math.abs(offset) > 4) $('#screen-lesson').scrollBy({ top: offset, behavior: 'smooth' });
}

function setPlayIcon(playing) {
  $('#ls-playicon').innerHTML = playing ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
}

function tick() {
  if (!lesson || player.paused) { rafId = 0; return; }
  const t = player.time;
  updateScrub(t);
  // Replaying one sentence runs a moment past its end (so the last word isn't
  // clipped); don't let the next sentence steal the highlight meanwhile.
  if (stopAt == null) lockedIdx = null;   // plain playback again: follow the video
  const i = lockedIdx != null ? lockedIdx : sentenceAt(t);
  if (i >= 0) setActive(i);
  // Playback started some other way (e.g. YouTube's own play button) while
  // Pause each / Loop is on: stop at the end of the sentence being spoken.
  if (justStarted && stopAt == null && (prefs.autopause || prefs.loop)) armCurrentSentence();
  if (justStarted && i >= 0) {
    // Playback just (re)started, however it was started (our ▶, a sentence tap,
    // or YouTube's own play button): bring the sentence being spoken back into
    // view, even if you'd scrolled away or toggled Literal/English meanwhile.
    justStarted = false;
    returnToSentence(i);
  }
  if (stopAt != null && t >= stopAt) {
    if (prefs.loop && loopFrom != null) {
      player.seek(loopFrom);
    } else {
      player.pause();
      stopAt = null;
      if (prefs.autopause) nextAfterStop = cur + 1;
    }
  }
  rafId = requestAnimationFrame(tick);
}

/* Scrub bar: drag to jump anywhere in the video. */
let scrubbing = false;
function updateScrub(t = player.time) {
  if (scrubbing) return;
  const d = player.duration;
  $('#ls-seek').value = d ? Math.round((t / d) * 1000) : 0;
  $('#ls-cur').textContent = fmtDuration(t) || '0:00';
  $('#ls-dur').textContent = fmtDuration(d) || '0:00';
}
$('#ls-seek').addEventListener('input', () => {
  scrubbing = true;
  const t = ($('#ls-seek').value / 1000) * player.duration;
  $('#ls-cur').textContent = fmtDuration(t) || '0:00';
});
$('#ls-seek').addEventListener('change', () => {
  const t = ($('#ls-seek').value / 1000) * player.duration;
  scrubbing = false;
  // Jumping ends any single-sentence replay; carry on from the new spot.
  stopAt = null; loopFrom = null; nextAfterStop = null; lockedIdx = null;
  player.seek(t);
  const i = sentenceAt(t);
  if (i >= 0) setActive(i);
  updateScrub(t);
});
['loadedmetadata', 'timeupdate', 'seeked'].forEach(ev => $('#ls-video').addEventListener(ev, () => updateScrub()));

let justStarted = false;
function startTick() {
  justStarted = true;   // every start of playback re-finds the spoken sentence
  if (!rafId) rafId = requestAnimationFrame(tick);
}
function stop() { cancelAnimationFrame(rafId); rafId = 0; }

// Where replaying sentence i should start and stop: a little padding so the
// first and last words aren't clipped, but never into the neighbouring
// sentences (Easy Russian speakers often start right after each other).
const YT_LAG = 0.1;   // YouTube reports its position slightly late
function sentenceBounds(i) {
  const ss = lesson.data.sentences, s = ss[i];
  const prevEnd = i > 0 ? ss[i - 1].end : 0;
  const nextStart = i + 1 < ss.length ? ss[i + 1].start : Infinity;
  const from = Math.max(0, Math.min(s.start, Math.max(s.start - PAD_BEFORE, prevEnd)));
  let to = Math.min(s.end + PAD_AFTER, Math.max(s.end + 0.02, nextStart - 0.08));
  if (player.mode === 'youtube') to -= YT_LAG;
  return [from, Math.max(to, s.start + 0.3)];
}

// Pause each / Loop switched on while the video is already playing: stop (or
// loop) at the end of the sentence being spoken right now.
function armCurrentSentence() {
  if (!lesson || player.paused) return;
  const i = Math.max(0, lockedIdx != null ? lockedIdx : sentenceAt(player.time));
  [loopFrom, stopAt] = sentenceBounds(i);
  lockedIdx = i;
  nextAfterStop = null;
  setActive(i);
}

function playSentence(i) {
  const ss = lesson.data.sentences;
  if (i < 0 || i >= ss.length) return;
  nextAfterStop = null;
  lockedIdx = i;
  [loopFrom, stopAt] = sentenceBounds(i);
  // Already there (Pause each stopped right before this sentence): don't seek.
  // A seek makes YouTube re-buffer, which is slow and can swallow the play.
  const t = player.time;
  if (!(player.mode === 'youtube' && t >= loopFrom - 0.6 && t <= loopFrom + 0.1)) player.seek(loopFrom);
  setActive(i, false);
  returnToSentence(i);
  player.play();
  startTick();
  store.set(`pos.${lesson.id}`, i);
}

function togglePlay() {
  if (!player.paused) { player.pause(); return; }
  if (nextAfterStop != null) { playSentence(nextAfterStop); return; }
  if (prefs.autopause || prefs.loop) { playSentence(Math.max(0, cur)); return; }
  // Continuous play from the current sentence: the highlight follows the video.
  stopAt = null; loopFrom = null; lockedIdx = null;
  const here = Math.max(0, cur >= 0 ? cur : sentenceAt(player.time));
  setActive(here, false);
  returnToSentence(here);
  if (cur >= 0 && Math.abs(player.time - lesson.data.sentences[cur].start) > 30) {
    player.seek(Math.max(0, lesson.data.sentences[cur].start - PAD_BEFORE));
  }
  player.play();
  startTick();
}

['play', 'pause', 'ended'].forEach(ev => $('#ls-video').addEventListener(ev, () => {
  setPlayIcon(!$('#ls-video').paused);
  if (ev === 'play') startTick();
}));

function toggleStar(i) {
  const s = lesson.data.sentences[i];
  const id = `${lesson.id}:${i}`;
  const existing = cards[id];
  const el = $(`#ls-transcript .sent[data-i="${i}"]`);
  if (existing && !existing.deleted) {
    existing.deleted = true;
    existing.updated = Date.now();
    el?.classList.remove('starred');
    toast('Removed from review');
  } else {
    const now = Date.now();
    cards[id] = {
      id, lesson: lesson.id, title: lesson.data.title, i,
      start: s.start, end: s.end, ru: s.ru, tokens: s.tokens, en: s.en,
      created: now, updated: now, due: now, ivl: 0, ease: 2.5, reps: 0, seen: 0, lapses: 0,
    };
    el?.classList.add('starred');
    toast('Saved for review ⭐');
  }
  cardsChanged();
}

/* ───────── Words: tap a word to hear it, see it, save it ───────── */
let ruVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  ruVoice = voices.find(v => /^ru(-|_|$)/i.test(v.lang) && /milena|premium|enhanced/i.test(v.name))
    || voices.find(v => /^ru(-|_|$)/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

// Splits a Russian word into syllables (one vowel each), keeping the stress
// mark: "молоко́" → ["мо", "ло", "ко́"].
const VOWELS = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';
function syllables(word) {
  const w = String(word || '').replace(/[.,!?…:;«»"“”()]+/g, '').trim();
  const chars = [...w];
  const isV = c => VOWELS.includes(c);
  const vowelAt = chars.map(isV);
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    const vowel = vowelAt[i];
    if (chars[i + 1] === '\u0301') { cur += chars[++i]; }
    if (!vowel) continue;
    // Consonants until the next vowel (if any); decide where to cut.
    let j = i + 1;
    while (j < chars.length && !vowelAt[j]) j++;
    if (j >= chars.length) continue;                  // last vowel: rest stays here
    const cluster = chars.slice(i + 1, j).filter(c => c !== '\u0301');
    // One consonant goes to the next syllable; in a cluster, a leading
    // й/р/л/м/н (with its soft sign) stays with this one.
    const real = cluster.filter(c => !/[ьъЬЪ]/.test(c));
    let keep = 0;
    if (real.length > 1 && /[йрлмнЙРЛМН]/.test(cluster[0])) {
      keep = 1;
      while (cluster[keep] && /[ьъЬЪ]/.test(cluster[keep])) keep++;
    }
    for (let n = 0; n < keep; n++) cur += chars[++i];
    out.push(cur);
    cur = '';
  }
  if (cur) { if (out.length && ![...cur].some(isV)) out[out.length - 1] += cur; else out.push(cur); }
  return out.length ? out : [w];
}

function syllablesHTML(word) {
  return syllables(word).map((sy, n) =>
    `<span class="syl${sy.includes('\u0301') ? ' stress' : ''}" data-n="${n}">${esc(sy)}</span>`).join('<span class="sep">·</span>');
}

// Lights up each syllable in turn while an utterance plays.
let sylTimer = null;
// stepMs: time per syllable. From a recording's real length when we have one,
// otherwise estimated from the speech rate.
function animateSyllables(root, rate, stepMs = null) {
  clearInterval(sylTimer);
  const els = root ? [...root.querySelectorAll('.syl')] : [];
  els.forEach(e => e.classList.remove('on'));
  if (!els.length) return;
  let n = 0;
  const step = stepMs || 230 / rate;    // ms per syllable
  els[0].classList.add('on');
  sylTimer = setInterval(() => {
    els[n]?.classList.remove('on');
    n++;
    if (n >= els.length) { clearInterval(sylTimer); return; }
    els[n].classList.add('on');
  }, step);
}

function utter(text, rate, sylRoot) {
  const u = new SpeechSynthesisUtterance(plainWord(text));
  u.lang = 'ru-RU';
  if (ruVoice) u.voice = ruVoice;
  u.rate = rate;
  u.onstart = () => animateSyllables(sylRoot, rate);
  u.onend = () => { clearInterval(sylTimer); sylRoot?.querySelectorAll('.syl.on').forEach(e => e.classList.remove('on')); };
  return u;
}

// rates: one or more speeds, spoken one after another (e.g. normal, then slow).
/* Natural voice: word recordings made with the lesson (Microsoft neural voice,
 * as in the russian-study decks). audioMaps[lessonId] = {text: [normal, slow]}. */
const audioMaps = {};
const audioLoads = {};
function speakable(text) {
  return String(text || '').normalize('NFD').replace(/\u0301/g, '').normalize('NFC')
    .replace(/[^\p{L}\p{N}_\s-]/gu, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}
function ensureAudio(lessonId) {
  if (!lessonId || audioMaps[lessonId] || audioLoads[lessonId]) return audioLoads[lessonId];
  audioLoads[lessonId] = fetch(`files/${lessonId}/lesson.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(d => { audioMaps[lessonId] = d?.audio?.clips || {}; })
    .catch(() => { delete audioLoads[lessonId]; });
  return audioLoads[lessonId];
}

const voicePlayer = new Audio();
voicePlayer.preload = 'auto';
function playClips(urls, sylRoot) {
  speechSynthesis?.cancel?.();
  let i = 0;
  const next = () => {
    if (i >= urls.length) { sylRoot?.querySelectorAll('.syl.on').forEach(e => e.classList.remove('on')); return; }
    voicePlayer.src = urls[i++];
    voicePlayer.onplaying = () => {
      const n = sylRoot ? sylRoot.querySelectorAll('.syl').length : 0;
      if (n && isFinite(voicePlayer.duration)) animateSyllables(sylRoot, 1, (voicePlayer.duration * 1000 * 0.85) / n);
    };
    voicePlayer.onended = () => setTimeout(next, 300);
    voicePlayer.play().catch(() => {});
  };
  next();
}

// A moment of silence, used to "unlock" the voice player inside a tap so it
// may play a recording a little later (iOS only lets audio start from a tap).
let silence = null;
function silentWav() {
  if (silence) return silence;
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return (silence = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
}

// rates: one or more of RATE_NORMAL / RATE_SLOW, played one after another.
// Uses the lesson's natural-voice recordings. If they're still loading (e.g.
// the first card of a review), waits for them instead of falling back to the
// phone's robotic voice; that's only used when a word has no recording.
function speak(text, rates = [0.5], sylRoot = null, lessonId = lesson?.id) {
  const play = () => {
    const clips = audioMaps[lessonId]?.[speakable(text)];
    if (clips) playClips([].concat(rates).map(r => `files/${lessonId}/audio/${clips[r <= RATE_SLOW ? 1 : 0]}`), sylRoot);
    else speakWithPhone(text, rates, sylRoot);
  };
  if (!lessonId || audioMaps[lessonId]) { play(); return; }
  speechSynthesis?.cancel?.();
  voicePlayer.src = silentWav();
  voicePlayer.onended = null;
  voicePlayer.play().catch(() => {});
  const loading = ensureAudio(lessonId) || Promise.resolve();
  Promise.race([loading, new Promise(r => setTimeout(r, 4000))]).then(play);
}

function speakWithPhone(text, rates = [0.5], sylRoot = null) {
  if (!('speechSynthesis' in window)) { toast('Speech isn’t available in this browser'); return; }
  if (!ruVoice) pickVoice();
  speechSynthesis.cancel();
  [].concat(rates).forEach(r => speechSynthesis.speak(utter(text, r, sylRoot)));
  if (!ruVoice) setTimeout(() => { if (!ruVoice) toast('No Russian voice found. Add one in Settings → Accessibility → Spoken Content → Voices'); }, 800);
}

const RATE_NORMAL = 0.9, RATE_SLOW = 0.4;

// Plays just one word from the lesson video.
function playWord(i, k) {
  lockedIdx = i;
  const [a, b] = wordTimes(lesson.data.sentences[i])[k];
  nextAfterStop = null;
  loopFrom = null;
  // YouTube reports its position a little late, so give words more room.
  stopAt = b + (player.mode === 'youtube' ? 0.3 : 0.12);
  player.seek(Math.max(0, a - 0.08));
  player.play();
  startTick();
}

let wordOpen = null;   // { i, k }
function openWord(i, k) {
  wordOpen = { i, k };
  const s = lesson.data.sentences[i];
  const t = s.tokens[k];
  const id = `${lesson.id}:${i}:${k}`;
  openSheet('Word', `
    <div class="word-card">
      <div class="wc-word" id="wc-word">${syllablesHTML(t.w)}</div>
      ${t.g ? `<div class="wc-here">${esc(t.g)}</div>` : ''}
      <div class="wc-audio">
        <button class="chip" data-s="w-say" data-rate="${RATE_NORMAL}">🔊 Normal</button>
        <button class="chip" data-s="w-say" data-rate="${RATE_SLOW}">🐢 Slowly</button>
        <button class="chip" data-s="w-video">🎬 From the video</button>
      </div>
      ${t.u ? `<div class="wc-warn">⚠️ <b>This word may not be accurate.</b> ${esc(t.u.note || '')}
        ${t.u.alt ? `<br>The second transcriber heard: <b>${esc(t.u.alt)}</b>` : ''}
        <br><span>Tap 🎬 From the video to hear it yourself.</span></div>` : ''}
      ${t.b || t.m ? `<div class="group kv wc-dict">
        ${t.b ? `<div class="cell"><div class="k">Dictionary form</div><span class="wc-base">${esc(t.b)}</span> <button class="chip small" data-s="w-say-base">🔊</button></div>` : ''}
        ${t.m ? `<div class="cell"><div class="k">Meaning</div>${esc(t.m)}</div>` : ''}
      </div>` : (lesson.data.enriched ? '' : '<p class="section-footer" style="margin:12px 0">Meanings appear once the lesson is made with the ANTHROPIC_API_KEY secret set.</p>')}
      <div class="wc-sentence">
        <div class="k">In this sentence</div>
        <div class="il">${tokensHTML(s.tokens, false, { hl: k })}</div>
        ${s.en ? `<p class="en">${esc(s.en)}</p>` : ''}
      </div>
      <button class="primary-button${isSaved(id) ? ' saved-btn' : ''}" data-s="w-save">${isSaved(id) ? '★ Saved (tap to remove)' : '☆ Save Word'}</button>
      <button class="secondary-button" data-s="w-report">🚩 Report a Mistake</button>
    </div>`);
}

function toggleWord() {
  const { i, k } = wordOpen;
  const s = lesson.data.sentences[i];
  const t = s.tokens[k];
  const id = `${lesson.id}:${i}:${k}`;
  if (isSaved(id)) {
    cards[id].deleted = true;
    cards[id].updated = Date.now();
    toast('Word removed from review');
  } else {
    const now = Date.now();
    cards[id] = {
      id, kind: 'word', lesson: lesson.id, title: lesson.data.title, i, k,
      w: t.w, g: t.g || '', b: t.b || '', m: t.m || '', t: wordTimes(s)[k],
      start: s.start, end: s.end, ru: s.ru, tokens: s.tokens.map(({ w, g }) => ({ w, g })), en: s.en,
      created: now, updated: now, due: now, ivl: 0, ease: 2.5, reps: 0, seen: 0, lapses: 0,
    };
    toast('Word saved ⭐');
  }
  cardsChanged();
  $(`#ls-transcript .tok[data-i="${i}"][data-k="${k}"]`)?.classList.toggle('saved', isSaved(id));
  openWord(i, k);
}

// Reports go to the repo as GitHub issues (the public version will store them
// in its database and fix the shared lesson for everyone).
async function reportMistake(i, k) {
  const s = lesson.data.sentences[i];
  const t = s.tokens[k];
  const note = prompt(`What’s wrong with “${plainWord(t.w)}”? (e.g. wrong word, wrong meaning, wrong stress)`);
  if (note == null) return;
  const body = [
    `**Lesson:** ${lesson.data.title} (\`${lesson.id}\`)`,
    `**Sentence ${i}** at ${fmtDuration(s.start)}: ${s.ru}`,
    `**Word ${k}:** ${t.w} · literal: ${t.g || '—'} · dictionary: ${t.b || '—'} · meaning: ${t.m || '—'}`,
    `**English:** ${s.en || '—'}`,
    t.u ? `**Flagged as uncertain:** ${t.u.note || ''} ${t.u.alt ? `(2nd transcriber heard “${t.u.alt}”)` : ''}` : '',
    '',
    `**Report:** ${note || '(no details)'}`,
  ].filter(Boolean).join('\n');
  try {
    await gh('/issues', { method: 'POST', body: { title: `Lesson mistake: ${plainWord(t.w)}`, body } });
    toast('Thanks! Reported');
  } catch (e) {
    toast(e.status === 403 || e.status === 404 ? 'Your token can’t create issues (it needs the Issues permission)' : e.message);
  }
}

function lessonMenu() {
  const d = lesson.data;
  const src = {
    subtitles: 'the video’s own Russian subtitles',
    'creator-captions': 'the creator’s captions on YouTube (no audio downloaded)',
    'auto-captions': 'YouTube’s automatic captions, cleaned up by Claude from the text alone (no audio downloaded or re-checked)',
  }[d.source] || 'Whisper speech recognition';
  openSheet('Lesson', `
    <div class="group kv">
      <div class="cell"><div class="k">Title</div>${esc(d.title || '')}</div>
      <div class="cell"><div class="k">Transcript</div>From ${src} · ${d.sentences.length} sentences</div>
      ${d.checks ? `<div class="cell"><div class="k">Accuracy checks</div>${[
        d.checks.captions_changed_words != null && `Claude corrected ${d.checks.captions_changed_words} word${d.checks.captions_changed_words === 1 ? '' : 's'} in the automatic captions`,
        d.checks.second && `Double-checked by a 2nd transcriber (${esc(d.checks.second)}): ${Math.round((d.checks.agreement || 0) * 100)}% agreement`,
        d.checks.proofread_fixed != null && (d.checks.proofread_fixed || d.checks.proofread_confirmed) && `Claude corrected ${d.checks.proofread_fixed} misheard sentence${d.checks.proofread_fixed === 1 ? '' : 's'} and confirmed ${d.checks.proofread_confirmed}`,
        d.checks.review_word_fixes != null && `Final review fixed ${d.checks.review_word_fixes} word${d.checks.review_word_fixes === 1 ? '' : 's'} and ${d.checks.review_translation_fixes} translation${d.checks.review_translation_fixes === 1 ? '' : 's'}`,
        `${d.checks.flagged_words || 0} word${d.checks.flagged_words === 1 ? '' : 's'} flagged as possibly inaccurate (dotted orange underline)`,
      ].filter(Boolean).join('<br>')}</div>` : ''}
      <div class="cell"><div class="k">Meanings made with</div>${d.engine === 'free' ? 'Free tools' : d.engine === 'captions' ? 'Captions test · AI' : 'AI'}${d.model ? ` · ${esc(d.model)}` : ''}</div>
    </div>
    ${lesson.url ? `<a class="secondary-button" href="${esc(lesson.url)}" target="_blank" rel="noopener" style="margin-top:12px">Open Original Video</a>` : ''}
    ${d.audio ? '' : '<button class="secondary-button" data-s="add-voices">🎙️ Add Natural Voice</button>'}
    <button class="secondary-button" data-s="lesson-help">How to use this page</button>
    <button class="secondary-button destructive" data-s="delete-lesson">Delete Lesson</button>`);
}

function helpSheet() {
  openSheet('How to use a lesson', `<ol>
    <li><b>Tap a word</b> to hear it slowly, hear it from the video, see its meaning, and save it.</li>
    <li>A <b>dotted orange underline</b> means the word may not be accurate (the checks couldn’t confirm it). Tap it to see why, and 🚩 report mistakes you spot.</li>
    <li><b>▶</b> next to a sentence (or tapping its English line) replays exactly that moment of the video.</li>
    <li><b>☆</b> saves the whole sentence as a flashcard with its real audio clip.</li>
    <li><b>Loop</b> repeats one sentence until you tap ▶ again. Great for shadowing: say it along with the speaker.</li>
    <li><b>Pause each</b> stops after every sentence; tap ▶ for the next one.</li>
    <li><b>1× / 0.75× / 0.5×</b> slows the speaker down without changing their voice.</li>
    <li><b>Literal</b> and <b>English</b> hide or show the word‑by‑word meanings and the translation, so you can test yourself.</li>
  </ol>`);
}

/* ───────── Review (spaced repetition) ───────── */
const MODES = ['read', 'listen', 'say'];
let queue = [], qi = 0, revealed = false, reviewed = 0;

function startReview(list = dueCards().slice(0, 50), from = 'study') {
  queue = list;
  [...new Set(queue.map(c => c.lesson))].forEach(ensureAudio);
  if (!queue.length) { toast('Nothing due right now'); return; }
  qi = 0; reviewed = 0;
  prevTab = from;
  stOpenPage('review');
  showCard();
}

/* Anki-style scheduling (Anki's default settings):
   new cards go through learning steps of 1 min and 10 min before they
   "graduate" to days; Easy graduates straight away. A forgotten card
   (Again on a review card) relearns for 10 min, then comes back after a day. */
const MIN = 60e3;
const LEARN_STEPS = [1, 10];          // minutes
const RELEARN_STEPS = [10];           // minutes
const GRADUATE_DAYS = 1, EASY_DAYS = 3;

function cardState(c) {
  if (c.state) return c.state;
  return (c.reps || 0) > 0 && (c.ivl || 0) >= 1 ? 'review' : 'learn';   // cards saved before this change
}

function nextIntervals(c) {
  const out = {};
  for (const g of ['again', 'hard', 'good', 'easy']) out[g] = schedule({ ...c }, g).due - Date.now();
  return out;
}

function schedule(c, grade) {
  const now = Date.now();
  const state = cardState(c);
  c.seen = (c.seen || 0) + 1;
  c.ease = c.ease || 2.5;
  const inSteps = (steps, onGraduate) => {
    const step = Math.min(c.step || 0, steps.length - 1);
    if (grade === 'again') { c.step = 0; c.due = now + steps[0] * MIN; }
    else if (grade === 'hard') {
      // Anki: on the first step, halfway between the first two steps; otherwise repeat the step.
      const m = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[step] * (steps.length > 1 ? 1 : 1.5);
      c.step = step; c.due = now + m * MIN;
    } else if (grade === 'good' && step + 1 < steps.length) { c.step = step + 1; c.due = now + steps[step + 1] * MIN; }
    else onGraduate(grade === 'easy');
  };
  if (state === 'learn') {
    inSteps(LEARN_STEPS, easy => {
      c.state = 'review'; c.step = 0;
      c.ivl = easy ? EASY_DAYS : GRADUATE_DAYS;
      c.due = now + c.ivl * DAY;
    });
    if (c.state !== 'review') c.state = 'learn';
  } else if (state === 'relearn') {
    inSteps(RELEARN_STEPS, easy => {
      c.state = 'review'; c.step = 0;
      c.ivl = Math.max(1, c.ivl || 1) + (easy ? 1 : 0);
      c.due = now + c.ivl * DAY;
    });
    if (c.state !== 'review') c.state = 'relearn';
  } else {
    const ivl = Math.max(1, c.ivl || 1);
    if (grade === 'again') {
      c.lapses = (c.lapses || 0) + 1;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.state = 'relearn'; c.step = 0;
      c.ivl = 1;
      c.due = now + RELEARN_STEPS[0] * MIN;
    } else {
      // Like Anki, Hard < Good < Easy always, and each is at least a day more than before.
      const hard = Math.max(ivl + 1, Math.round(ivl * 1.2));
      const good = Math.max(hard + 1, Math.round(ivl * c.ease));
      const easy = Math.max(good + 1, Math.round(ivl * c.ease * 1.3));
      if (grade === 'hard') c.ease = Math.max(1.3, c.ease - 0.15);
      if (grade === 'easy') c.ease += 0.15;
      c.ivl = { hard, good, easy }[grade];
      c.state = 'review';
      c.due = now + c.ivl * DAY;
    }
  }
  if (grade !== 'again') c.reps = (c.reps || 0) + 1;
  c.updated = now;
  return c;
}

// How long until a card comes back, Anki style: "<1m", "<10m", "1d", "3.2mo".
function fmtIvl(ms) {
  const m = ms / MIN;
  if (m < 60) return `<${Math.max(1, Math.round(m))}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

let rvStopAt = null, rvRaf = 0;
function playClip(c, rate = 1, word = false) {
  const v = $('#rv-video');
  if (v.hidden) return;
  const [a, b] = word && c.t ? [c.t[0] - 0.08, c.t[1] + 0.12] : [c.start - PAD_BEFORE, c.end + PAD_AFTER];
  v.playbackRate = rate;
  v.currentTime = Math.max(0, a);
  rvStopAt = b;
  v.play().catch(() => {});
  cancelAnimationFrame(rvRaf);
  const loop = () => {
    if (v.paused) return;
    if (v.currentTime >= rvStopAt) { v.pause(); return; }
    rvRaf = requestAnimationFrame(loop);
  };
  rvRaf = requestAnimationFrame(loop);
}

function showCard() {
  const c = queue[qi];
  if (!c) { reviewDone(); return; }
  ensureAudio(c.lesson);
  if (queue[qi + 1]) ensureAudio(queue[qi + 1].lesson);
  revealed = false;
  const mode = MODES[(c.seen || 0) % MODES.length];
  const v = $('#rv-video');
  const src = `files/${c.lesson}/media.mp4`;
  const hasVideo = lessons.some(l => l.id === c.lesson && l.state === 'ready' && l.meta?.video !== false);
  v.hidden = !hasVideo;
  if (hasVideo && !v.src.endsWith(src)) v.src = src;
  $('#rv-count').textContent = `${qi + 1} of ${queue.length}`;

  if (c.kind === 'word') {
    const listen = (c.seen || 0) % 2 === 1;
    $('#rv-body').innerHTML = `
      <p class="rv-hint">${listen ? 'Listen. What’s the word, and what does it mean?' : 'What does this word mean?'}</p>
      <div class="rv-front">${listen ? '<div class="listen-icon">🔊</div>' : `<div class="wc-word">${syllablesHTML(c.w)}</div>`}</div>
      <div class="rv-tools"><button class="chip" data-s="rv-say" data-rate="${RATE_NORMAL}">🔊 Normal</button><button class="chip" data-s="rv-say" data-rate="${RATE_SLOW}">🐢 Slowly</button></div>
      <button class="primary-button" data-s="rv-show">Show</button>`;
    if (listen) speak(c.w, [RATE_NORMAL, RATE_SLOW], null, c.lesson);   // right away, inside the tap (iOS requires it)
    return;
  }

  const prompt = {
    read: { hint: 'Read it. What does it mean?', body: `<div class="il big">${tokensHTML(c.tokens, false)}</div>` },
    listen: { hint: hasVideo ? 'Listen. What did they say?' : 'Read it. What does it mean?',
      body: hasVideo ? '<div class="listen-icon">🎧</div>' : `<div class="il big">${tokensHTML(c.tokens, false)}</div>` },
    say: { hint: 'Say it in Russian, out loud.', body: `<p class="en big">${esc(c.en || '')}</p>` },
  }[mode === 'say' && !c.en ? 'read' : mode];

  $('#rv-body').innerHTML = `
    <p class="rv-hint">${prompt.hint}</p>
    <div class="rv-front">${prompt.body}</div>
    <div class="rv-tools">
      ${hasVideo ? `<button class="chip" data-s="rv-play">▶ Replay</button><button class="chip" data-s="rv-slow">🐢 Slow</button>` : ''}
    </div>
    <button class="primary-button" data-s="rv-show">Show</button>`;
  if (hasVideo && mode === 'listen') playClip(c);
}

function revealCard() {
  const c = queue[qi];
  revealed = true;
  const iv = nextIntervals(c);
  const hasVideo = !$('#rv-video').hidden;
  const grades = `<div class="grades">
      <button class="grade again" data-s="grade" data-g="again"><span>${fmtIvl(iv.again)}</span><b>Again</b></button>
      <button class="grade hard" data-s="grade" data-g="hard"><span>${fmtIvl(iv.hard)}</span><b>Hard</b></button>
      <button class="grade good" data-s="grade" data-g="good"><span>${fmtIvl(iv.good)}</span><b>Good</b></button>
      <button class="grade easy" data-s="grade" data-g="easy"><span>${fmtIvl(iv.easy)}</span><b>Easy</b></button>
    </div>`;
  if (c.kind === 'word') {
    $('#rv-body').innerHTML = `
      <div class="rv-back">
        <div class="wc-word" id="rv-word">${syllablesHTML(c.w)}</div>
        ${c.g ? `<div class="wc-here">${esc(c.g)}</div>` : ''}
        ${c.b || c.m ? `<p class="wc-dictline">${c.b ? `<b>${esc(c.b)}</b>` : ''}${c.b && c.m ? ' · ' : ''}${esc(c.m)}</p>` : ''}
        <div class="il" style="margin-top:14px">${tokensHTML(c.tokens, true, { hl: c.k })}</div>
        ${c.en ? `<p class="en">${esc(c.en)}</p>` : ''}
        <p class="rv-src">${esc(c.title || '')}</p>
      </div>
      <div class="rv-tools">
        <button class="chip" data-s="rv-say" data-rate="${RATE_NORMAL}">🔊 Normal</button>
        <button class="chip" data-s="rv-say" data-rate="${RATE_SLOW}">🐢 Slowly</button>
        ${hasVideo ? `<button class="chip" data-s="rv-word">🎬 Word</button><button class="chip" data-s="rv-play">▶ Sentence</button>` : ''}
      </div>
      ${grades}`;
    speak(c.w, [RATE_NORMAL, RATE_SLOW], $('#rv-word'), c.lesson);
    return;
  }
  $('#rv-body').innerHTML = `
    <div class="rv-back">
      <div class="il">${tokensHTML(c.tokens, true)}</div>
      ${c.en ? `<p class="en">${esc(c.en)}</p>` : ''}
      <p class="rv-src">${esc(c.title || '')}</p>
    </div>
    <div class="rv-tools">
      ${hasVideo ? `<button class="chip" data-s="rv-play">▶ Replay</button><button class="chip" data-s="rv-slow">🐢 Slow</button>` : ''}
    </div>
    ${grades}`;
  if (hasVideo) playClip(c);
}

function grade(g) {
  const c = queue[qi];
  schedule(c, g);
  cards[c.id] = c;
  // Still learning (back in minutes): see it again later in this session, like Anki.
  if (c.due - Date.now() < 20 * MIN) queue.push(c);
  reviewed++;
  qi++;
  cardsChanged();
  showCard();
}

function reviewDone() {
  $('#rv-video').pause();
  $('#rv-count').textContent = 'Done';
  const left = dueCards().length;
  $('#rv-body').innerHTML = `
    <div class="empty" style="padding-top:24px">
      <div style="font-size:48px">🎉</div>
      <p style="font-size:20px;font-weight:600;color:var(--label);margin:8px 0">${reviewed} review${reviewed === 1 ? '' : 's'} done</p>
      <p>${left ? `${left} more due.` : 'Nothing else due. Go mine some new sentences!'}</p>
    </div>
    ${left ? '<button class="primary-button" data-s="review">Keep Going</button>' : ''}
    <button class="secondary-button" data-s="back">Back to Study</button>`;
}

/* ───────── Saved: every saved word and sentence in one list ───────── */
let svKind = 'word';
const liveCards = kind => Object.values(cards)
  .filter(c => !c.deleted && (kind === 'word') === (c.kind === 'word'))
  .sort((a, b) => (b.created || 0) - (a.created || 0));

function openSaved() {
  prevTab = 'study';
  stOpenPage('saved');
  [...new Set(Object.values(cards).map(c => c.lesson))].forEach(ensureAudio);
  renderSaved();
}

function dueText(c) {
  const days = (c.due - Date.now()) / DAY;
  if (days <= 0) return '<span class="sv-due now">Due</span>';
  return `<span class="sv-due">in ${fmtIvl(c.due - Date.now()).replace('<', '')}</span>`;
}

function renderSaved() {
  const btns = [...document.querySelectorAll('#sv-kind button')];
  btns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.kind === svKind)));
  $('#sv-kind .seg-thumb').style.transform = `translateX(${svKind === 'word' ? 0 : 100}%)`;
  const all = liveCards(svKind);
  const q = speakable($('#sv-search').value);
  const qEn = $('#sv-search').value.trim().toLowerCase();
  const list = !q && !qEn ? all : all.filter(c => {
    const ru = speakable(svKind === 'word' ? `${c.w} ${c.b}` : c.ru);
    const en = `${c.g || ''} ${c.m || ''} ${c.en || ''}`.toLowerCase();
    return (q && ru.includes(q)) || (qEn && en.includes(qEn));
  });
  const noun = svKind === 'word' ? 'word' : 'sentence';
  $('#sv-review-all').textContent = `Review All ${all.length} ${noun}${all.length === 1 ? '' : 's'}`;
  $('#sv-review-all').hidden = !all.length;
  $('#sv-list').innerHTML = list.length ? list.map(c => svKind === 'word'
    ? `<button class="cell sv-row" data-s="sv-open" data-id="${esc(c.id)}">
        <div class="sv-main"><span class="sv-word">${esc(c.w)}</span>${c.g ? `<span class="sv-gloss">${esc(c.g)}</span>` : ''}
          <div class="sv-sub">${esc([c.b, c.m].filter(Boolean).join(' · ') || c.ru || '')}</div></div>
        ${dueText(c)}</button>`
    : `<button class="cell sv-row" data-s="sv-open" data-id="${esc(c.id)}">
        <div class="sv-main"><div class="sv-ru">${esc(c.ru)}</div>${c.en ? `<div class="sv-sub">${esc(c.en)}</div>` : ''}</div>
        ${dueText(c)}</button>`).join('')
    : `<div class="sv-empty">${all.length ? 'Nothing matches your search.'
      : svKind === 'word' ? 'No saved words yet. In a lesson, tap a word, then ☆ Save Word.'
        : 'No saved sentences yet. In a lesson, tap ☆ next to a sentence.'}</div>`;
}

let svOpen = null;
function openSavedCard(id) {
  const c = cards[id];
  if (!c) return;
  svOpen = c;
  const hasLesson = lessons.some(l => l.id === c.lesson && l.state === 'ready');
  const actions = `
    ${hasLesson ? '<button class="primary-button" data-s="sv-lesson">Open in Lesson</button>' : ''}
    <button class="secondary-button" data-s="sv-now">Review It Now</button>
    <button class="secondary-button destructive" data-s="sv-remove">Remove</button>`;
  if (c.kind === 'word') {
    openSheet('Saved word', `
      <div class="word-card">
        <div class="wc-word" id="sv-word">${syllablesHTML(c.w)}</div>
        ${c.g ? `<div class="wc-here">${esc(c.g)}</div>` : ''}
        <div class="wc-audio">
          <button class="chip" data-s="sv-say" data-rate="${RATE_NORMAL}">🔊 Normal</button>
          <button class="chip" data-s="sv-say" data-rate="${RATE_SLOW}">🐢 Slowly</button>
        </div>
        ${c.b || c.m ? `<p class="wc-dictline">${c.b ? `<b>${esc(c.b)}</b>` : ''}${c.b && c.m ? ' · ' : ''}${esc(c.m)}</p>` : ''}
        <div class="wc-sentence">
          <div class="k">In this sentence</div>
          <div class="il">${tokensHTML(c.tokens, true, { hl: c.k })}</div>
          ${c.en ? `<p class="en">${esc(c.en)}</p>` : ''}
          <p class="rv-src">${esc(c.title || '')}</p>
        </div>
        ${actions}
      </div>`);
  } else {
    openSheet('Saved sentence', `
      <div class="word-card">
        <div class="il">${tokensHTML(c.tokens, true)}</div>
        ${c.en ? `<p class="en">${esc(c.en)}</p>` : ''}
        <p class="rv-src">${esc(c.title || '')}</p>
        ${actions}
      </div>`);
  }
}

function svAction(what) {
  const c = svOpen;
  if (!c) return;
  if (what === 'remove') {
    if (!confirm(c.kind === 'word' ? 'Remove this word from your saved words?' : 'Remove this sentence from your saved sentences?')) return;
    c.deleted = true;
  }
  c.updated = Date.now();
  cardsChanged();
  closeSheet();
  renderSaved();
}

// Review just this one card, right now; back returns to the Saved list.
function svReviewNow() {
  const c = svOpen;
  if (!c) return;
  closeSheet();
  startReview([c], 'saved');
}

async function svOpenLesson() {
  const c = svOpen, l = lessons.find(x => x.id === c.lesson);
  if (!l) return;
  store.set(`pos.${l.id}`, c.i);
  closeSheet();
  prevTab = 'study';
  await openLesson(l);
}

$('#sv-kind').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { svKind = b.dataset.kind; renderSaved(); } });
$('#sv-search').addEventListener('input', renderSaved);

/* ───────── Card sync (repo branch "study-data", file cards.json) ───────── */
const SYNC_BRANCH = 'study-data', SYNC_PATH = 'cards.json';
let syncSha = null, syncTimer = null, syncing = false, syncLoaded = false;

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}

function mergeCards(remote) {
  let changed = false;
  for (const [id, rc] of Object.entries(remote || {})) {
    const lc = cards[id];
    if (!lc || (rc.updated || 0) > (lc.updated || 0)) { cards[id] = rc; changed = true; }
  }
  return changed;
}

async function syncLoad() {
  if (!configured() || syncing) return;
  try {
    const meta = await gh(`/contents/${SYNC_PATH}?ref=${SYNC_BRANCH}`);
    syncSha = meta.sha;
    let text = meta.content ? b64decode(meta.content) : '';
    if (!text) {   // files over 1 MB come without inline content
      const blob = await gh(`/git/blobs/${meta.sha}`);
      text = b64decode(blob.content);
    }
    const remote = JSON.parse(text || '{}').cards || {};
    const localNewer = Object.entries(cards).some(([id, c]) => !remote[id] || (c.updated || 0) > (remote[id].updated || 0));
    if (mergeCards(remote)) { store.set('cards', cards); stRender(); }
    syncLoaded = true;
    if (localNewer) syncSave();
  } catch (e) {
    if (e.status === 404) { syncLoaded = true; syncSha = null; if (Object.keys(cards).length) syncSave(); }
    else console.warn('sync load', e);
  }
}

function cardsChanged() {
  store.set('cards', cards);
  stRender();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSave, 4000);
}

async function ensureBranch() {
  const base = await gh(`/git/ref/heads/${await defaultBranch()}`);
  await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${SYNC_BRANCH}`, sha: base.object.sha } })
    .catch(e => { if (e.status !== 422) throw e; });   // 422: already exists
}

async function syncSave(retried = false) {
  if (!configured()) return;
  if (!syncLoaded) { await syncLoad(); if (!syncLoaded) return; }
  if (syncing) { clearTimeout(syncTimer); syncTimer = setTimeout(syncSave, 3000); return; }
  syncing = true;
  const body = {
    message: 'Update study cards',
    content: b64encode(JSON.stringify({ version: 1, cards })),
    branch: SYNC_BRANCH,
    ...(syncSha ? { sha: syncSha } : {}),
  };
  try {
    const res = await gh(`/contents/${SYNC_PATH}`, { method: 'PUT', body });
    syncSha = res.content.sha;
  } catch (e) {
    syncing = false;
    if (retried) { console.warn('sync save', e); return; }
    if (e.status === 404 || (e.status === 422 && /branch/i.test(e.message))) {
      await ensureBranch().catch(() => {});
      return syncSave(true);
    }
    if (e.status === 409 || e.status === 422) {   // someone else saved first: merge, retry
      syncLoaded = false;
      await syncLoad();
      return syncSave(true);
    }
    console.warn('sync save', e);
    return;
  }
  syncing = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && syncTimer) { clearTimeout(syncTimer); syncSave(); }
  if (!document.hidden && $('#screen-study').classList.contains('active')) stRefresh();
});

/* ───────── Wiring ───────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-s]');
  if (!el) return;
  const id = el.dataset.id;
  const i = Number(el.dataset.i);
  switch (el.dataset.s) {
    case 'open': { const l = lessons.find(x => x.id === id); if (l) openLesson(l); break; }
    case 'retry': { const l = lessons.find(x => x.id === id); closeSheet(); if (l) { lessons = lessons.filter(x => x !== l); stStart(l.url); } break; }
    case 'stop': { const l = lessons.find(x => x.id === id); if (l) stStopLesson(l); break; }
    case 'forget':
      lessons = lessons.filter(x => x.id !== id);
      deletedLessons.add(id);
      store.set('deletedLessons', [...deletedLessons]);
      saveLessons(); closeSheet(); stRender(); break;
    case 'back': stBack(); break;
    case 'sent': playSentence(i); break;
    case 'replay': playSentence(i); break;
    case 'word': {
      openWord(i, Number(el.dataset.k));
      const w = lesson.data.sentences[i].tokens[Number(el.dataset.k)].w;
      speak(w, [RATE_NORMAL, RATE_SLOW], $('#wc-word'));   // inside the tap, so iOS allows it
      break;
    }
    case 'w-say': speak(lesson.data.sentences[wordOpen.i].tokens[wordOpen.k].w, Number(el.dataset.rate), $('#wc-word')); break;
    case 'w-say-base': speak(lesson.data.sentences[wordOpen.i].tokens[wordOpen.k].b, RATE_SLOW); break;
    case 'w-video': playWord(wordOpen.i, wordOpen.k); break;
    case 'w-save': toggleWord(); break;
    case 'w-report': reportMistake(wordOpen.i, wordOpen.k); break;
    case 'add-voices':
      defaultBranch().then(ref => gh('/actions/workflows/voices.yml/dispatches', { method: 'POST', body: { ref, inputs: { job_id: lesson.id } } }))
        .then(() => { closeSheet(); toast('Recording a natural voice for every word. Reopen this lesson in about 10 minutes.'); })
        .catch(e => toast(e.status === 404 ? 'The Add voices workflow isn’t on GitHub yet' : e.message));
      break;
    case 'rv-say': speak(queue[qi].w, Number(el.dataset.rate) || RATE_SLOW, $('#rv-word'), queue[qi].lesson); break;
    case 'rv-word': playClip(queue[qi], 1, true); break;
    case 'star': e.stopPropagation(); toggleStar(i); break;
    case 'toggle': togglePlay(); break;
    case 'prev': playSentence(Math.max(0, cur - 1)); break;
    case 'next': playSentence(cur + 1); break;
    case 'speed': {
      const speeds = [1, 0.75, 0.5];
      prefs.speed = speeds[(speeds.indexOf(prefs.speed) + 1) % speeds.length];
      player.setRate(prefs.speed);
      savePrefs(); syncChips(); break;
    }
    case 'loop':
    case 'autopause':
      if (el.dataset.s === 'loop') prefs.loop = !prefs.loop; else prefs.autopause = !prefs.autopause;
      nextAfterStop = null;
      savePrefs(); syncChips();
      if (!player.paused) {
        if (prefs.loop || prefs.autopause) armCurrentSentence();       // takes effect right now
        else { stopAt = null; loopFrom = null; lockedIdx = null; }    // back to plain playback
      }
      break;
    case 'show-literal':
    case 'show-english':
      if (!lesson?.data.enriched) {
        toast('This lesson has no meanings yet. Add the ANTHROPIC_API_KEY secret, then make the lesson again');
        break;
      }
      if (el.dataset.s === 'show-literal') prefs.literal = !prefs.literal; else prefs.english = !prefs.english;
      savePrefs(); syncChips();
      keepPlace(applyDisplayPrefs);
      break;
    case 'show-follow': prefs.follow = !prefs.follow; savePrefs(); syncChips(); break;
    case 'lesson-menu': lessonMenu(); break;
    case 'lesson-help': closeSheet(); setTimeout(helpSheet, 350); break;
    case 'delete-lesson': { const l = lessons.find(x => x.id === lesson?.id); if (l) stDeleteLesson(l); break; }
    case 'review': startReview(); break;
    case 'saved': openSaved(); break;
    case 'sv-open': openSavedCard(el.dataset.id); break;
    case 'sv-say': speak(svOpen.w, Number(el.dataset.rate), $('#sv-word'), svOpen.lesson); break;
    case 'sv-now': svReviewNow(); break;
    case 'sv-remove': svAction('remove'); break;
    case 'sv-lesson': svOpenLesson(); break;
    case 'sv-review-all': startReview(liveCards(svKind).sort((a, b) => a.due - b.due), 'saved'); break;
    case 'rv-show': revealCard(); break;
    case 'rv-play': playClip(queue[qi]); break;
    case 'rv-slow': playClip(queue[qi], 0.6); break;
    case 'grade': grade(el.dataset.g); break;
  }
});

// Tapping the video itself plays/pauses.
$('#ls-video').addEventListener('click', togglePlay);

const ENGINE_HINTS = {
  free: 'Free: open-source tools add stress marks, dictionary meanings and a machine translation. Costs nothing; literal meanings are less precise.',
  ai: 'AI: Claude writes stress marks, in-context literal meanings and natural translations. Best quality; uses your Anthropic API credit (needs the ANTHROPIC_API_KEY secret).',
  captions: 'Captions test: no video or audio is downloaded. The transcript comes from YouTube’s own captions (the creator’s if any, else YouTube’s automatic ones, cleaned up by Claude); the lesson plays through YouTube’s player. Every word Claude changed or doubts is flagged.',
};
function setEngine(e) {
  prefs.engine = e;
  savePrefs();
  const btns = [...document.querySelectorAll('#st-engine button')];
  btns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.engine === e)));
  $('#st-engine .seg-thumb').style.transform = `translateX(${btns.findIndex(b => b.dataset.engine === e) * 100}%)`;
  $('#st-engine-hint').textContent = ENGINE_HINTS[e];
  $('#st-check').hidden = e !== 'captions';
  $('#st-check-result').hidden = e !== 'captions' || !$('#st-check-result').innerHTML;
}
$('#st-engine').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setEngine(b.dataset.engine); });
setEngine(prefs.engine);

function setPlayerPref(p) {
  prefs.player = p;
  savePrefs();
  const btns = [...document.querySelectorAll('#st-player button')];
  btns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.player === p)));
  $('#st-player .seg-thumb').style.transform = `translateX(${btns.findIndex(b => b.dataset.player === p) * 100}%)`;
  $('#st-player-hint').textContent = p === 'youtube'
    ? 'Test mode: lessons play through YouTube’s own player (no hosting of the video). Tap play on the YouTube video once to start it.'
    : 'Lessons play the copy downloaded when the lesson was made.';
}
$('#st-player').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPlayerPref(b.dataset.player); });
setPlayerPref(prefs.player);

/* ───────── Caption check: which captions does a YouTube video have? ─────────
   Runs the small "Caption check" workflow (no download) and reads its answer
   from release check-<id>, then deletes that release. */
let checking = null;
const checkResults = new Map();   // video id → 'creator' | 'auto' | 'none'
function showCheck(kind, title, text = '', videoTitle = '') {
  const box = $('#st-check-result');
  box.className = `check-result ${kind}`;
  box.innerHTML = `<b>${esc(title)}</b>${esc(text)}${videoTitle ? `<span class="ct">${esc(videoTitle)}</span>` : ''}`;
  box.hidden = false;
}
async function stCheckCaptions() {
  if (!configured()) { toast('Add your GitHub token in Settings first'); showScreen('settings'); return; }
  const m = String($('#st-url').value || '').match(/https?:\/\/\S+/i);
  if (!m) { toast('Paste a video link first'); $('#st-url').focus(); return; }
  const vid = youtubeId(m[0]);
  if (!vid) { showCheck('bad', 'Not a YouTube link', 'Captions can only be checked for YouTube videos.'); return; }
  if (checking) return;
  const id = randomId();
  checking = id;
  showCheck('busy', 'Checking captions…', 'Asking YouTube which captions this video has. About a minute.');
  try {
    await gh('/actions/workflows/captions-check.yml/dispatches', {
      method: 'POST', body: { ref: await defaultBranch(), inputs: { url: m[0], job_id: id } },
    });
  } catch (e) {
    checking = null;
    showCheck('bad', 'Couldn’t start the check', e.status === 404 ? 'The Caption check workflow isn’t on GitHub yet.' : e.message);
    return;
  }
  const started = Date.now();
  while (checking === id && Date.now() - started < 6 * 60e3) {
    await new Promise(r => setTimeout(r, 5000));
    let rel = null;
    try { rel = await gh(`/releases/tags/check-${id}`); } catch (e) { if (e.status !== 404) continue; }
    if (!rel) continue;
    checking = null;
    let meta = {};
    try { meta = JSON.parse(rel.body || '{}'); } catch { /* ignore */ }
    gh(`/releases/${rel.id}`, { method: 'DELETE' })
      .then(() => gh(`/git/refs/tags/check-${id}`, { method: 'DELETE' })).catch(() => {});
    if (meta.ok === false) {
      showCheck('bad', 'The check failed', String(meta.error || 'Open the Caption check run on GitHub for details.').split('\n')[0]);
    } else if (meta.creator?.length) {
      checkResults.set(vid, 'creator');
      showCheck('good', '✓ The creator’s own Russian captions',
        'Written by the channel, so a Captions lesson should be accurate.', meta.title);
    } else if (meta.auto) {
      checkResults.set(vid, 'auto');
      showCheck('warn', '⚠ Only YouTube’s automatic captions',
        'Made by YouTube’s computer: about 93% accurate in our test, with some wrong or extra words. For an accurate lesson, choose AI (best).', meta.title);
    } else {
      checkResults.set(vid, 'none');
      showCheck('bad', '✗ No Russian captions',
        'This video has no Russian captions on YouTube, so a Captions lesson can’t be made. Choose AI (best).', meta.title);
    }
    return;
  }
  if (checking === id) { checking = null; showCheck('bad', 'The check took too long', 'Try again in a minute.'); }
}
$('#st-check').addEventListener('click', stCheckCaptions);
$('#st-url').addEventListener('input', () => { checking = null; $('#st-check-result').hidden = true; $('#st-check-result').innerHTML = ''; });

$('#st-make').addEventListener('click', () => {
  // A Captions lesson for a video the check found wanting: say so first.
  const vid = youtubeId(($('#st-url').value.match(/https?:\/\/\S+/i) || [''])[0]);
  const found = prefs.engine === 'captions' && vid && checkResults.get(vid);
  if (found === 'none') { toast('This video has no Russian captions. Choose AI (best) instead.'); return; }
  if (found === 'auto' && !confirm('This video only has YouTube’s automatic captions (about 93% accurate). Make a Captions lesson anyway?')) return;
  stStart($('#st-url').value);
});
$('#st-url').addEventListener('keydown', e => { if (e.key === 'Enter') stStart($('#st-url').value); });
$('#st-refresh').addEventListener('click', () => { stRefresh(); syncLoad(); });

// app.js may have opened the Study tab before this file loaded.
if ($('#screen-study').classList.contains('active')) studyShow();
else {
  stRender();
  if (configured()) { syncLoad(); if (lessons.some(l => l.state !== 'ready' && l.state !== 'failed')) stSchedule(2000); }
}
