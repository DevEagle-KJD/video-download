'use strict';

/* The learning app: lessons made once per YouTube video (shared by everyone),
 * played live through YouTube's own player, with the exact transcript, stress
 * marks, literal word-by-word meanings, English, natural voices, and
 * Anki-style review of saved words and sentences.
 *
 * Lessons: Supabase tables lessons + user_lessons; files (lesson.json, voice
 * clips) in the public storage bucket "lessons". Cards: table cards.
 * Uses helpers from core.js: $, esc, store, toast, randomId, showScreen,
 * openSheet, closeSheet, fmtDuration, hostOf, db, api, fileUrl, session. */

const DAY = 864e5;
const PAD_BEFORE = 0.15, PAD_AFTER = 0.25;

let lessons = store.get('lessons', []);
let cards = store.get('cards', {});                 // id → card (deleted ones kept as tombstones)
const prefs = Object.assign({ literal: true, english: true, follow: true, loop: false, autopause: true, speed: 1 },
  store.get('studyPrefs', {}));
const saveLessons = () => store.set('lessons', lessons);
const savePrefs = () => store.set('studyPrefs', prefs);

/* ───────── Lessons: add + track ───────── */
const ICON = {
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M6 3h12M10 10.5v5l4.5-2.5z"/></svg>',
};

const toLesson = row => {
  const L = row.lessons || row;
  return {
    id: L.video_id, url: `https://www.youtube.com/watch?v=${L.video_id}`,
    created: Date.parse(row.added_at || L.created_at) || Date.now(),
    state: L.status === 'ready' ? 'ready' : L.status === 'failed' ? 'failed' : 'processing',
    stage: L.stage, error: L.error,
    meta: { title: L.title, channel: L.channel, thumbnail: L.thumbnail, duration: L.duration, count: L.sentence_count, video: false },
  };
};

async function stStart(url) {
  const m = String(url || '').match(/https?:\/\/\S+/i);
  if (!m) { toast('Paste a YouTube link first'); $('#st-url').focus(); return; }
  $('#st-make').disabled = true;
  try {
    const { lesson: row, already } = await api('lessons', { url: m[0], language: 'ru' });
    $('#st-url').value = '';
    const l = toLesson(row);
    lessons = [l, ...lessons.filter(x => x.id !== l.id)];
    saveLessons();
    stRender();
    toast(already ? 'That lesson is already in your list'
      : l.state === 'ready' ? 'Added! This lesson is ready to study.' : 'Making your lesson… you can keep studying meanwhile.');
    stSchedule(5000);
  } catch (e) {
    if (e.code === 'limit') openSheet('Free lessons used up', `<p style="font-size:16px">${esc(e.message)}</p>
      <p class="section-footer">You can keep studying and reviewing everything you already have.</p>`);
    else toast(e.message);
  } finally {
    $('#st-make').disabled = false;
  }
}

let stTimer = null, stBusy = false;
function stSchedule(ms = 15000) {
  clearTimeout(stTimer);
  stTimer = setTimeout(stRefresh, ms);
}

async function stRefresh() {
  if (stBusy || !session || document.hidden) return;
  stBusy = true;
  $('#st-refresh')?.classList.add('spin');
  try {
    const rows = await db(`user_lessons?select=added_at,lessons(*)&order=added_at.desc`);
    lessons = rows.filter(r => r.lessons).map(toLesson);
    saveLessons();
    stRender();
  } catch (e) {
    console.warn('lessons refresh', e);
  } finally {
    stBusy = false;
    $('#st-refresh')?.classList.remove('spin');
  }
  if (lessons.some(l => l.state === 'processing')) stSchedule();
}

// Removes a lesson from your list (the shared lesson stays for everyone else;
// your saved cards from it stay too).
async function stRemoveLesson(l, ask = true) {
  if (ask && !confirm('Remove this lesson from your list? Your saved words and sentences from it stay.')) return;
  try {
    await db(`user_lessons?user_id=eq.${session.user.id}&video_id=eq.${l.id}`, { method: 'DELETE' });
    lessons = lessons.filter(x => x.id !== l.id);
    saveLessons();
    closeSheet();
    if ($('#screen-lesson').classList.contains('active')) stBack();
    stRender();
    toast('Removed from your lessons');
  } catch (e) {
    toast(e.message);
  }
}

/* ───────── Study home ───────── */
/* Two separate card groups, never mixed: "app" = video lessons + Say it like a
   native; "anki" = cards from the owner's imported Anki decks (lesson id dk-…). */
const cardSet = c => (String(c.lesson || '').startsWith('dk-') ? 'anki' : 'app');
let reviewSet = 'app';                      // the group the current review session uses
function dueCards(set = reviewSet) {
  const now = Date.now();
  return Object.values(cards).filter(c => !c.deleted && c.due <= now && cardSet(c) === set).sort((a, b) => a.due - b.due);
}

// Sharpest thumbnail YouTube has: 1280px, else 640px, else the 480px one.
// Remembers which size worked for each video, so redrawn pictures load straight
// from the cache instead of flickering through the larger sizes again.
const thumbSize = store.get('thumbSize', {});
const thumbOf = id => `https://i.ytimg.com/vi/${id}/${thumbSize[id] || 'maxresdefault'}.jpg`;
function thumbFallback(img) {
  const [, id, size] = img.src.match(/\/vi\/([^/]+)\/(\w+)\.jpg/) || [];
  const next = { maxresdefault: 'sddefault', sddefault: 'hqdefault' }[size];
  if (!next) { img.remove(); return; }
  thumbSize[id] = next; store.set('thumbSize', thumbSize);
  img.src = img.src.replace(/\w+\.jpg$/, `${next}.jpg`);
}
// Replaces an element's HTML only when it changed, so pictures and videos
// already on screen aren't torn down and reloaded (that made tabs blink).
function setHTML(el, html) {
  if (!el || el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}
window.thumbFallback = thumbFallback;
const posterImg = id => `<img src="${esc(thumbOf(id))}" referrerpolicy="no-referrer" alt="" loading="lazy" onload="if (this.naturalWidth <= 120) thumbFallback(this)" onerror="thumbFallback(this)">`;

function stRender() {
  const live = Object.values(cards).filter(c => !c.deleted && cardSet(c) === 'app');
  const due = dueCards('app').length, dueAll = due + dueCards('anki').length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // Review: one slim bar, only once something is saved.
  setHTML($('#st-review-card'), false
    ? `<button class="rv-bar${due ? ' due' : ''}" data-s="${due ? 'review' : 'saved'}">
         <span class="rv-bar-n">${due || '✓'}</span>
         <span class="rv-bar-t"><b>${due ? `${plural(due, 'card')} to review` : 'All caught up'}</b><i>${plural(live.length, 'saved card')}</i></span>
         <span class="rv-bar-go">${due ? 'Review' : 'See all'}</span>
       </button>` : '');
  for (const [badge, n] of [[$('#st-badge'), 0], [$('#pr-badge'), dueAll]]) {   // review lives in Practice
    if (!badge) continue;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
  }

  window.engage?.render();
  // Continue: the lesson you opened last.
  const last = lessons.find(l => l.id === store.get('lastLesson') && l.state === 'ready');
  setHTML($('#st-continue'), last ? `
    <button class="hero" data-s="open" data-id="${esc(last.id)}">
      ${posterImg(last.id, last.meta)}
      <span class="hero-shade"></span>
      <span class="hero-text"><i>Continue</i><b>${esc(last.meta?.title || 'Lesson')}</b></span>
      <span class="hero-play"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>
    </button>` : '');

  setHTML($('#st-lessons'), lessons.length ? lessons.map(l => {
    const m = l.meta || {};
    const over = l.state === 'ready' ? ''
      : l.state === 'failed' ? '<span class="poster-state failed">Couldn’t be made</span>'
        : `<span class="poster-state"><span class="spinner"></span>${esc(l.stage || 'Waiting to start')}…</span>`;
    return `<button class="poster${l.state === 'ready' ? '' : ' busy'}" data-s="open" data-id="${esc(l.id)}">
      <span class="poster-img">${posterImg(l.id, m)}${over}${m.duration && l.state === 'ready' ? `<span class="poster-time">${fmtDuration(m.duration)}</span>` : ''}${window.engage ? engage.progressBar(l.id) : ''}</span>
      <span class="poster-title">${esc(m.title || 'New lesson')}</span>
      <span class="poster-sub">${esc(m.channel || '')}</span>
    </button>`;
  }).join('') : `<div class="empty-card"><span class="big">🎬</span><b>Your first lesson is one link away</b>
      <span>Paste a YouTube link above, or pick a video in Explore.</span></div>`);
  // A friendly hello, Russian first.
  const h = new Date().getHours();
  const [ru, en] = h < 5 ? ['Доброй ночи!', 'Good night'] : h < 12 ? ['Доброе утро!', 'Good morning'] : h < 18 ? ['Добрый день!', 'Good afternoon'] : ['Добрый вечер!', 'Good evening'];
  setHTML($('#st-hello'), `<b>${ru}</b> ${en}. Ready to sound native today?`);
}

function studyShow() {
  window.engage?.pull();
  // Load the word recordings for every lesson with saved cards, so review
  // never has to wait for them.
  [...new Set(Object.values(cards).filter(c => !c.deleted).map(c => c.lesson))].forEach(ensureAudio);
  stRender();
  stRefresh();
  syncLoad();
  stRestorePages();   // after a reload: reopen the page you were on
}
window.studyShow = studyShow;

/* ───────── Pages (lesson / saved / review) ───────── */
/* Pages opened from Study form a stack (e.g. Saved → a lesson),
   so ← goes back to the page you came from, and it's saved so a reload reopens
   the page you were on. Each page also gets a browser history entry, so
   swiping back / Safari's back button work like ←. Review isn't reopened after
   a reload (the session is gone); you land on the page under it. */
let pageStack = store.get('pageStack', []);   // [{ name, id }]
let pageRestoring = false;
const savePages = () => store.set('pageStack', pageStack.filter(p => p.name !== 'review'));
function stOpenPage(name, id = null) {
  if (!pageRestoring) {
    const at = pageStack.findIndex(p => p.name === name && p.id === id);
    if (at >= 0) pageStack.length = at + 1;       // already open further down: go back to it
    else {
      pageStack.push({ name, id });
      try { history.pushState({ page: pageStack.length }, ''); } catch { /* ignore */ }
    }
    savePages();
  }
  document.body.classList.add('in-page');
  showScreen(name);
}
// Opens a page from the stack again without adding it.
async function stReopen(p) {
  pageRestoring = true;
  try {
    if (p.name === 'lesson') {
      const l = lessons.find(x => x.id === p.id && x.state === 'ready');
      if (l) await openLesson(l); else return false;
    } else if (p.name === 'saved') openSaved();
    else if (p.name === 'anki') openAnki();
    else if (p.name === 'phrases') openPhrasesPage();
    else return false;
    return true;
  } finally { pageRestoring = false; }
}
async function stBack() {
  clearTimeout(waitTimer);
  player.close();
  $('#rv-video').pause();
  stop();
  pageStack.pop();
  while (pageStack.length) {
    if (await stReopen(pageStack[pageStack.length - 1])) { savePages(); return; }
    pageStack.pop();                               // that page is gone (e.g. lesson deleted)
  }
  savePages();
  document.body.classList.remove('in-page');
  showScreen(store.get('tab', 'study'));
  stRender();
}
// In-app ←: step back through the browser history too, so the two stay in step.
function stBackButton() {
  if (history.state?.page) history.back();         // → popstate → stBack()
  else stBack();
}
window.addEventListener('popstate', () => {
  if (document.body.classList.contains('in-page') && pageStack.length) stBack();
});
// After a reload: reopen the page you were on.
let pagesRestored = false;
async function stRestorePages() {
  if (pagesRestored) return;
  pagesRestored = true;
  try { history.replaceState(null, ''); } catch { /* ignore */ }   // ← then works without old history entries
  while (pageStack.length) {
    if (await stReopen(pageStack[pageStack.length - 1])) return;
    pageStack.pop();
  }
  savePages();
}

/* ───────── Player: YouTube's embedded player (the `player` layer can also drive a <video>) ───────── */
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
    const id = youtubeId(l.url || lesson?.data.url);
    const box = $('#ls-yt');
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
            ? 'This video’s owner doesn’t allow playing it in other apps.'
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
    openSheet('Lesson couldn’t be made', `<p class="job-error" style="font-size:15px">${esc(l.error || 'Something went wrong.').replace(/\n/g, '<br>')}</p>
      <button class="primary-button" data-s="retry" data-id="${l.id}" style="margin-top:16px">Try Again</button>
      <button class="secondary-button destructive" data-s="forget" data-id="${l.id}">Remove</button>`);
    return;
  }
  if (l.state !== 'ready') {
    openSheet('Lesson in progress', `<p style="font-size:15px;color:var(--secondary)">${esc(l.stage || 'Waiting to start')}… Lessons take about 30–40 minutes the first time anyone adds a video; after that they’re instant for everyone.</p>
      <button class="secondary-button destructive" data-s="forget" data-id="${l.id}">Remove from My Lessons</button>`);
    return;
  }

  let data;
  try {
    const res = await fetch(fileUrl(l.id, 'lesson.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    toast('Couldn’t load the lesson. Check your connection and try again.');
    return;
  }
  lesson = { id: l.id, data, meta: l.meta || {}, url: l.url };
  store.set('lastLesson', l.id);
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
  stOpenPage('lesson', l.id);
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
function tokensHTML(tokens, withGloss, { i = null, hl = -1, ph = null } = {}) {
  return tokens.map((t, k) => {
    const saved = i != null && (ph ? isSaved(`${ph}:${i}:${k}`) : lesson && isSaved(`${lesson.id}:${i}:${k}`));
    const attrs = i == null ? '' : ph ? ` data-s="ph-word" data-id="${ph}" data-i="${i}" data-k="${k}"` : ` data-s="word" data-i="${i}" data-k="${k}"`;
    return `<span class="tok${k === hl ? ' hl' : ''}${saved ? ' saved' : ''}${t.u ? ' unsure' : ''}"${attrs}><b>${esc(t.w)}</b>${withGloss ? `<i>${esc(t.g || ' ')}</i>` : ''}</span>`;
  }).join('');
}

const isSaved = id => cards[id] && !cards[id].deleted;

function renderTranscript() {
  const { data } = lesson;
  const noMeanings = !data.enriched;
  $('#ls-transcript').innerHTML =
    (noMeanings ? `<p class="section-footer" style="margin:12px 16px">Translations for this lesson are still being added. Check back soon.</p>` : '') +
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
  if (i >= 0) { setActive(i); window.engage?.heard(lesson.id, i, lesson.data.sentences.length); }
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
    window.engage?.xp(3);
  }
  cardsChanged(id);
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
  audioLoads[lessonId] = fetch(fileUrl(lessonId, 'lesson.json'), { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { audioMaps[lessonId] = d?.audio?.clips || {}; })
    .catch(() => { delete audioLoads[lessonId]; });
  return audioLoads[lessonId];
}

const voicePlayer = new Audio();
voicePlayer.preload = 'auto';
/* Syllable highlighting that follows the recording itself: the clip is decoded
   once, its loudness measured every 10 ms to find where the voice really starts
   and stops (recordings have silence at both ends), and syllable boundaries are
   placed in the quiet dips between syllables. The highlight then follows the
   player's actual position, so it can't drift. */
const sylMaps = new Map();   // url → Promise<{ start, end, env: Float32Array }>
let audioCtx = null;
function analyzeClip(url) {
  if (!sylMaps.has(url)) {
    sylMaps.set(url, (async () => {
      const buf = await (await fetch(url)).arrayBuffer();
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const audio = await new Promise((ok, bad) => audioCtx.decodeAudioData(buf, ok, bad));
      const data = audio.getChannelData(0), hop = Math.round(audio.sampleRate / 100);
      const env = new Float32Array(Math.floor(data.length / hop));
      for (let f = 0; f < env.length; f++) {
        let sum = 0;
        for (let j = f * hop; j < (f + 1) * hop; j++) sum += data[j] * data[j];
        env[f] = Math.sqrt(sum / hop);
      }
      const max = env.reduce((m, x) => Math.max(m, x), 0) || 1;
      const loud = max * 0.08;
      let a = env.findIndex(x => x > loud), b = env.length - 1;
      while (b > a && env[b] <= loud) b--;
      return { start: Math.max(0, a) / 100, end: (b + 1) / 100, env };
    })().catch(() => null));
  }
  return sylMaps.get(url);
}

// Syllable start times (seconds) for this clip: weighted by letters (stressed
// syllables are held longer), then each boundary moved to the quietest moment nearby.
function sylTimes(info, els) {
  const w = els.map(e => Math.max(1, e.textContent.replace(/[^\p{L}]/gu, '').length) * (e.classList.contains('stress') ? 1.4 : 1));
  const total = w.reduce((x, y) => x + y, 0), span = info.end - info.start;
  const smooth = f => { let s = 0, c = 0; for (let k = f - 2; k <= f + 2; k++) if (info.env[k] != null) { s += info.env[k]; c++; } return s / c; };
  const ex = w.map(x => (span * x) / total);   // expected length of each syllable
  const times = [info.start];
  let acc = 0;
  for (let n = 0; n < els.length - 1; n++) {
    acc += w[n];
    const guess = info.start + (span * acc) / total;
    // Only look a little either side, and never make a syllable much shorter than expected.
    const lo = Math.max(times[n] + ex[n] * 0.6, guess - ex[n] * 0.3), hi = guess + ex[n + 1] * 0.3;
    let best = Math.max(guess, lo), bestE = Infinity;
    for (let t = lo; t <= hi; t += 0.01) {
      const e = smooth(Math.round(t * 100));
      if (e < bestE) { bestE = e; best = t; }
    }
    times.push(best);
  }
  return times;
}

let sylRaf = 0;
function followSyllables(sylRoot, url) {
  cancelAnimationFrame(sylRaf);
  clearInterval(sylTimer);
  const els = sylRoot ? [...sylRoot.querySelectorAll('.syl')] : [];
  if (!els.length) return;
  let times = null;
  analyzeClip(url).then(info => { if (info && voicePlayer.src.endsWith(url)) { times = sylTimes(info, els); times.end = info.end; } });
  const tick = () => {
    if (!voicePlayer.src.endsWith(url) || voicePlayer.ended) { els.forEach(e => e.classList.remove('on')); return; }
    const t = voicePlayer.currentTime, d = voicePlayer.duration;
    let on = -1;
    if (times) {
      if (t >= times[0] && t <= times.end + 0.05) for (let n = 0; n < times.length; n++) if (t >= times[n]) on = n;
    } else if (isFinite(d) && d) {
      on = Math.min(els.length - 1, Math.floor((t / (d * 0.8)) * els.length));   // until measured
    }
    els.forEach((e, n) => e.classList.toggle('on', n === on));
    sylRaf = requestAnimationFrame(tick);
  };
  sylRaf = requestAnimationFrame(tick);
}

function playClips(urls, sylRoot) {
  speechSynthesis?.cancel?.();
  if (sylRoot) urls.forEach(analyzeClip);   // measure while the first one starts
  let i = 0;
  const next = () => {
    if (i >= urls.length) { sylRoot?.querySelectorAll('.syl.on').forEach(e => e.classList.remove('on')); return; }
    const url = urls[i++];
    voicePlayer.src = url;
    voicePlayer.onplaying = () => followSyllables(sylRoot, url);
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
function speak(text, rates = [0.5], sylRoot = null, lessonId = lesson?.id, onMissing = null) {
  const play = () => {
    const clips = audioMaps[lessonId]?.[speakable(text)];
    if (clips) playClips([].concat(rates).map(r => fileUrl(lessonId, `audio/${clips[r <= RATE_SLOW ? 1 : 0]}`)), sylRoot);
    else if (onMissing) onMissing();
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

// A whole sentence in the natural voice (recorded per lesson by voices.py).
// Never the robotic phone voice: without a recording, `fallback` runs instead
// (e.g. the clip from the video), or it offers to record the lesson's sentences.
function saySentence(c, rate = RATE_NORMAL, fallback = null) {
  speak(c.ru, [rate], null, c.lesson, fallback || (() => toast('No natural voice for this sentence yet')));
}

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
      </div>` : (lesson.data.enriched ? '' : '')}
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
    window.engage?.xp(3);
  }
  cardsChanged(id);
  $(`#ls-transcript .tok[data-i="${i}"][data-k="${k}"]`)?.classList.toggle('saved', isSaved(id));
  openWord(i, k);
}

// Reports go to the reports table; they're used to fix the shared lesson for everyone.
async function reportMistake(i, k) {
  const s = lesson.data.sentences[i];
  const t = s.tokens[k];
  const note = prompt(`What’s wrong with “${plainWord(t.w)}”? (e.g. wrong word, wrong meaning, wrong stress)`);
  if (note == null) return;
  try {
    await db('reports', { method: 'POST', prefer: 'return=minimal',
      body: { user_id: session.user.id, video_id: lesson.id, sentence: i, token: k, word: t.w, note: note || '' } });
    toast('Thanks! We’ll check it');
  } catch (e) {
    toast(e.message);
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
      <div class="cell"><div class="k">Channel</div>${esc(lesson.meta.channel || '')}</div>
    </div>
    ${lesson.url ? `<a class="secondary-button" href="${esc(lesson.url)}" target="_blank" rel="noopener" style="margin-top:12px">Watch on YouTube</a>` : ''}
    <button class="secondary-button" data-s="lesson-help">How to use this page</button>
    <button class="secondary-button destructive" data-s="delete-lesson">Remove from My Lessons</button>`);
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
// Cards you're still learning come back after a few minutes (Anki's learning
// steps). They wait here and are shown once they're due, not straight away.
let learning = [], waitTimer = 0;
const cardsLeft = () => queue.length - qi + learning.length;

function startReview(list, from = 'study', set = 'app') {
  reviewSet = set;
  list ||= dueCards(set).slice(0, 50);
  queue = list;
  [...new Set(queue.map(c => c.lesson))].forEach(ensureAudio);
  if (!queue.length) { toast('Nothing due right now'); return; }
  qi = 0; reviewed = 0;
  learning = [];
  clearTimeout(waitTimer);
  undoStack = [];
  $('#rv-undo').hidden = true;
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
  clearTimeout(waitTimer);
  // A learning card that's due now goes next.
  learning.sort((a, b) => a.due - b.due);
  if (learning[0] && learning[0].due <= Date.now()) queue.splice(qi, 0, learning.shift());
  if (!queue[qi]) {
    // Out of cards: carry on with anything else that's due now (e.g. after
    // "Review It Now" on one card, or cards that became due meanwhile).
    const inSession = new Set([...queue.slice(qi), ...learning].map(x => x.id));
    const more = dueCards().filter(x => !inSession.has(x.id)).slice(0, 50);
    more.forEach(x => ensureAudio(x.lesson));
    queue.push(...more);
  }
  const c = queue[qi];
  if (!c) { learning.length ? waitForLearning() : reviewDone(); return; }
  ensureAudio(c.lesson);
  if (queue[qi + 1]) ensureAudio(queue[qi + 1].lesson);
  revealed = false;
  const mode = MODES[(c.seen || 0) % MODES.length];
  const v = $('#rv-video');
  const src = `files/${c.lesson}/media.mp4`;
  const hasVideo = false;   // lessons play on YouTube; review uses the natural voice
  v.hidden = !hasVideo;
  if (hasVideo && !v.src.endsWith(src)) v.src = src;
  $('#rv-count').textContent = `${cardsLeft()} left`;

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
    listen: { hint: 'Listen. What did they say?', body: '<div class="listen-icon">🎧</div>' },
    say: { hint: 'Say it in Russian, out loud.', body: `<p class="en big">${esc(c.en || '')}</p>` },
  }[mode === 'say' && !c.en ? 'read' : mode];

  $('#rv-body').innerHTML = `
    <p class="rv-hint">${prompt.hint}</p>
    <div class="rv-front">${prompt.body}</div>
    ${mode === 'listen' ? sentenceTools(hasVideo) : ''}
    <button class="primary-button" data-s="rv-show">Show</button>`;
  // Listening: the natural voice says it right away (or the video, if there's no recording).
  if (mode === 'listen') saySentence(c, RATE_NORMAL, hasVideo ? () => playClip(c) : null);
}

function sentenceTools(hasVideo) {
  return `<div class="rv-tools">${sentenceVoiceButtons(queue[qi], 'rv-say-sent')}
      ${hasVideo ? '<button class="chip" data-s="rv-play">🎬 Video</button>' : ''}
    </div>`;
}

// 🔊 Normal / 🐢 Slowly for a sentence, or, when its lesson has no sentence
// recordings yet, a 🎙️ button that records them right there. Updates itself
// once the lesson's recordings list has loaded.
function sentenceVoiceButtons(c, action) {
  return `<span class="sv-voice" data-card="${esc(c.id)}"><button class="chip" data-s="${action}" data-rate="${RATE_NORMAL}">🔊 Normal</button>
      <button class="chip" data-s="${action}" data-rate="${RATE_SLOW}">🐢 Slowly</button></span>`;
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
    ${sentenceTools(hasVideo)}
    ${grades}`;
  // The natural voice says the sentence (the video clip if there's no recording).
  saySentence(c, RATE_NORMAL, hasVideo ? () => playClip(c) : () => {});
}

// Undo, like Anki's: puts the last graded card back exactly as it was.
let undoStack = [];
function grade(g) {
  const c = queue[qi];
  undoStack.push({ card: JSON.parse(JSON.stringify(c)), qlen: queue.length, qi, reviewed, learning: learning.map(x => x.id) });
  $('#rv-undo').hidden = false;
  schedule(c, g);
  cards[c.id] = c;
  window.engage?.xp(2);
  // Still learning (back in minutes): it comes back later in this session, like Anki.
  if (c.due - Date.now() < 20 * MIN) learning.push(c);
  reviewed++;
  qi++;
  cardsChanged(c.id);
  showCard();
}

function undoGrade() {
  const u = undoStack.pop();
  if (!u) return;
  const c = cards[u.card.id] || queue[u.qi];
  Object.keys(c).forEach(k => delete c[k]);
  Object.assign(c, u.card, { updated: Date.now() });
  queue.length = u.qlen;
  qi = u.qi;
  learning = u.learning.map(id => cards[id]).filter(Boolean);
  reviewed = u.reviewed;
  $('#rv-undo').hidden = !undoStack.length;
  cardsChanged(c.id);
  showCard();
  toast('Undone');
}

// Only cards you're still learning are left, and none is due yet: wait for the
// next one (like Anki), with the option to see it now or stop here.
function waitForLearning() {
  $('#rv-video').pause();
  const next = learning[0];
  const tick = () => {
    const ms = next.due - Date.now();
    if (ms <= 0) { showCard(); return; }
    const sec = Math.ceil(ms / 1000);
    const el = $('#rv-wait');
    if (el) el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    waitTimer = setTimeout(tick, 1000);
  };
  $('#rv-count').textContent = `${cardsLeft()} left`;
  $('#rv-body').innerHTML = `
    <div class="empty" style="padding-top:24px">
      <div style="font-size:44px">⏳</div>
      <p style="font-size:20px;font-weight:600;color:var(--label);margin:8px 0">Next card in <span id="rv-wait"></span></p>
      <p>You're still learning ${learning.length === 1 ? 'this card' : `these ${learning.length} cards`}, so ${learning.length === 1 ? 'it comes' : 'they come'} back after a short break. That spacing is what makes it stick.</p>
    </div>
    <button class="primary-button" data-s="rv-now">Show It Now</button>
    <button class="secondary-button" data-s="back">Stop for Now</button>`;
  tick();
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
let svSet = 'app';                          // Saved page: which group is shown
const liveCards = kind => Object.values(cards)
  .filter(c => !c.deleted && (kind === 'word') === (c.kind === 'word') && cardSet(c) === svSet)
  .sort((a, b) => (b.created || 0) - (a.created || 0));

function openSaved() {
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
  const hasAnki = Object.values(cards).some(c => !c.deleted && cardSet(c) === 'anki');
  if (!hasAnki) svSet = 'app';
  $('#sv-set').hidden = !hasAnki;
  document.querySelectorAll('#sv-set button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.set === svSet)));
  $('#sv-set .seg-thumb').style.transform = `translateX(${svSet === 'app' ? 0 : 100}%)`;
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
    ${cardState(c) !== 'learn' || (c.step || 0) > 0 ? `<button class="secondary-button" data-s="sv-reset">Start Over <span style="font-weight:400;opacity:.7">(show it often again)</span></button>` : ''}
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
        <div class="wc-audio" style="margin-bottom:12px">
          ${sentenceVoiceButtons(c, 'sv-say-sent')}
        </div>
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
  if (what === 'reset') {
    if (!confirm('Start this card over? It will come back often again, like a new card (next review: now).')) return;
    Object.assign(c, { state: 'learn', step: 0, ivl: 0, ease: 2.5, reps: 0, due: Date.now() });
    toast('Starting over: it’s due now');
  } else if (what === 'remove') {
    if (!confirm(c.kind === 'word' ? 'Remove this word from your saved words?' : 'Remove this sentence from your saved sentences?')) return;
    c.deleted = true;
  }
  c.updated = Date.now();
  cardsChanged(c.id);
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
  await openLesson(l);
}

$('#sv-kind').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { svKind = b.dataset.kind; renderSaved(); } });
$('#sv-search').addEventListener('input', renderSaved);

/* ───────── Card sync (Supabase table "cards", one row per card) ───────── */
let syncTimer = null, syncing = false, syncLoaded = false;
const dirty = new Set(store.get('dirtyCards', []));   // ids changed here and not yet saved

function mergeCards(remote) {
  let changed = false;
  for (const [id, rc] of Object.entries(remote || {})) {
    const lc = cards[id];
    if (!lc || (rc.updated || 0) > (lc.updated || 0)) { cards[id] = rc; dirty.delete(id); changed = true; }
  }
  return changed;
}

async function syncLoad() {
  if (!session || syncing) return;
  try {
    const rows = await db('cards?select=id,data');
    const remote = Object.fromEntries(rows.map(r => [r.id, r.data]));
    // Cards saved on this device before signing in (or while offline) go up too.
    Object.entries(cards).forEach(([id, c]) => { if (!remote[id] || (c.updated || 0) > (remote[id].updated || 0)) dirty.add(id); });
    if (mergeCards(remote)) { store.set('cards', cards); stRender(); }
    syncLoaded = true;
    if (dirty.size) syncSave();
  } catch (e) {
    console.warn('sync load', e);
  }
}

function cardsChanged(ids) {
  [].concat(ids || Object.keys(cards)).forEach(id => dirty.add(id));
  store.set('cards', cards);
  store.set('dirtyCards', [...dirty]);
  stRender();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSave, 3000);
}

async function syncSave() {
  if (!session) return;
  if (!syncLoaded) { await syncLoad(); if (!syncLoaded) return; }
  if (syncing) { clearTimeout(syncTimer); syncTimer = setTimeout(syncSave, 3000); return; }
  const ids = [...dirty].filter(id => cards[id]);
  if (!ids.length) return;
  syncing = true;
  try {
    await db('cards?on_conflict=user_id,id', {
      method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
      body: ids.map(id => ({ user_id: session.user.id, id, data: cards[id], updated_at: new Date(cards[id].updated || Date.now()).toISOString() })),
    });
    ids.forEach(id => dirty.delete(id));
    store.set('dirtyCards', [...dirty]);
  } catch (e) {
    console.warn('sync save', e);   // kept in `dirty`; retried on the next change or visit
  } finally {
    syncing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && dirty.size) { clearTimeout(syncTimer); syncSave(); }
});

/* ───────── Staying fresh (Home Screen apps have no reload button) ─────────
   iOS often resumes a Home Screen app instead of restarting it, so: whenever the
   app comes back on screen, check for a newer version (reload into it, unless
   you're mid-review) and fetch the latest data. Plus pull-to-refresh on the tabs. */
let appVersion = null;
async function serverVersion() {
  try {
    const t = await (await fetch(`/sw.js?v=${Date.now()}`, { cache: 'no-store' })).text();
    return t.match(/CACHE = '([^']+)'/)?.[1] || null;
  } catch { return null; }
}
serverVersion().then(v => { appVersion = v; });
const busy = () => $('#screen-review').classList.contains('active');   // don't lose a review session
async function updateIfNewer() {
  const v = await serverVersion();
  if (!v || !appVersion || v === appVersion || busy()) return false;
  toast('Updating Nativnik…');
  if (dirty.size) await syncSave().catch(() => {});
  setTimeout(() => location.reload(), 600);
  return true;
}
function refreshData() {
  if (!session) return;
  stRefresh();
  syncLoad();
  window.engage?.pull();
  if ($('#screen-practice')?.classList.contains('active')) practiceShow();
  if ($('#screen-explore')?.classList.contains('active')) exploreShow();
}
let lastResume = Date.now();
async function onResume() {
  if (document.hidden || Date.now() - lastResume < 3000) return;
  lastResume = Date.now();
  if (await updateIfNewer()) return;
  refreshData();
}
document.addEventListener('visibilitychange', onResume);
window.addEventListener('pageshow', e => { if (e.persisted) onResume(); });
window.addEventListener('focus', onResume);

// Pull down at the top of a tab to refresh.
(() => {
  const ptr = document.createElement('div');
  ptr.className = 'ptr';
  ptr.innerHTML = '<span class="spinner"></span><b>Pull to refresh</b>';
  document.body.appendChild(ptr);
  let startY = null, pulled = 0, scroller = null;
  const TABS = ['screen-study', 'screen-practice', 'screen-explore', 'screen-account'];
  document.addEventListener('touchstart', e => {
    scroller = e.target.closest('.screen.active');
    startY = scroller && TABS.includes(scroller.id) && scroller.scrollTop <= 0 && !$('#sheet').classList.contains('open') ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (startY == null) return;
    pulled = Math.max(0, e.touches[0].clientY - startY);
    if (scroller.scrollTop > 0) { startY = null; pulled = 0; }
    const d = Math.min(pulled, 120);
    ptr.style.transform = `translate(-50%, ${d * 0.8 - 60}px)`;
    ptr.style.opacity = Math.min(1, d / 70);
    ptr.querySelector('b').textContent = d >= 80 ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (startY == null) return;
    const go = pulled >= 80;
    startY = null;
    if (!go) { ptr.style.transform = ''; ptr.style.opacity = 0; return; }
    ptr.classList.add('busy');
    ptr.querySelector('b').textContent = 'Refreshing…';
    if (!(await updateIfNewer())) refreshData();
    setTimeout(() => { ptr.classList.remove('busy'); ptr.style.transform = ''; ptr.style.opacity = 0; }, 900);
  });
})();

/* ───────── Wiring ───────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-s]');
  if (!el) return;
  const id = el.dataset.id;
  const i = Number(el.dataset.i);
  switch (el.dataset.s) {
    case 'open': { const l = lessons.find(x => x.id === id); if (l) openLesson(l); break; }
    case 'retry': { const l = lessons.find(x => x.id === id); closeSheet(); if (l) stStart(l.url); break; }
    case 'forget': { const l = lessons.find(x => x.id === id); if (l) stRemoveLesson(l, false); break; }
    case 'back': stBackButton(); break;
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
      if (!lesson?.data.enriched) { toast('This lesson has no meanings yet'); break; }
      if (el.dataset.s === 'show-literal') prefs.literal = !prefs.literal; else prefs.english = !prefs.english;
      savePrefs(); syncChips();
      keepPlace(applyDisplayPrefs);
      break;
    case 'show-follow': prefs.follow = !prefs.follow; savePrefs(); syncChips(); break;
    case 'lesson-menu': lessonMenu(); break;
    case 'lesson-help': closeSheet(); setTimeout(helpSheet, 350); break;
    case 'delete-lesson': { const l = lessons.find(x => x.id === lesson?.id); if (l) stRemoveLesson(l); break; }
    case 'review': startReview(null, 'study', 'app'); break;
    case 'saved': openSaved(); break;
    case 'sv-open': openSavedCard(el.dataset.id); break;
    case 'sv-say': speak(svOpen.w, Number(el.dataset.rate), $('#sv-word'), svOpen.lesson); break;
    case 'sv-now': svReviewNow(); break;
    case 'sv-remove': svAction('remove'); break;
    case 'sv-reset': svAction('reset'); break;
    case 'rv-undo': undoGrade(); break;
    case 'rv-now': clearTimeout(waitTimer); if (learning[0]) { learning[0].due = Date.now(); showCard(); } break;
    case 'sv-lesson': svOpenLesson(); break;
    case 'sv-review-all': startReview(liveCards(svKind).sort((a, b) => a.due - b.due), 'saved', svSet); break;
    case 'rv-show': revealCard(); break;
    case 'rv-play': voicePlayer.pause(); playClip(queue[qi]); break;
    case 'rv-say-sent': $('#rv-video').pause(); saySentence(queue[qi], Number(el.dataset.rate)); break;
    case 'sv-say-sent': saySentence(svOpen, Number(el.dataset.rate)); break;
    case 'rv-slow': playClip(queue[qi], 0.6); break;
    case 'grade': grade(el.dataset.g); break;
  }
});

// Tapping the video itself plays/pauses.
$('#ls-video').addEventListener('click', togglePlay);

$('#st-make').addEventListener('click', () => stStart($('#st-url').value));

/* ───────── Explore: every finished lesson and the channels in the library ───────── */
async function exploreShow() {
  const list = $('#ex-lessons');
  try {
    const [rows, channels] = await Promise.all([
      db('lessons?status=eq.ready&select=video_id,title,channel,thumbnail,duration,sentence_count&order=updated_at.desc&limit=100'),
      db('channels?select=name,author_url&order=name'),
    ]);
    const mine = new Set(lessons.map(l => l.id));
    setHTML(list, rows.length ? rows.map(r => {
      const m = { thumbnail: r.thumbnail };
      const added = mine.has(r.video_id);
      return `<button class="poster" data-s="${added ? 'open' : 'ex-add'}" data-id="${esc(r.video_id)}">
        <span class="poster-img">${posterImg(r.video_id, m)}${r.duration ? `<span class="poster-time">${fmtDuration(r.duration)}</span>` : ''}
          <span class="poster-add${added ? ' added' : ''}">${added ? '✓' : '+'}</span></span>
        <span class="poster-title">${esc(r.title || 'Lesson')}</span>
        <span class="poster-sub">${esc(r.channel || '')}</span>
      </button>`;
    }).join('') : '<p class="empty-note">No lessons in the library yet.</p>');
    setHTML($('#ex-channels'), channels.length
      ? channels.map(c => `<a class="channel-pill" href="${esc(c.author_url)}" target="_blank" rel="noopener">${esc(c.name || c.author_url)}</a>`).join('')
      : '');
    $('#ex-channels-box').hidden = !channels.length;   // shown once a creator's channel is approved
  } catch (e) {
    setHTML(list, `<p class="empty-note">${esc(e.message)}</p>`);
  }
}
window.exploreShow = exploreShow;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-s="ex-add"]');
  if (!b) return;
  stStart(`https://www.youtube.com/watch?v=${b.dataset.id}`).then(() => exploreShow());
});
$('#st-url').addEventListener('keydown', e => { if (e.key === 'Enter') stStart($('#st-url').value); });
$('#st-refresh').addEventListener('click', () => { stRefresh(); syncLoad(); });

// core.js may have opened the Study tab before this file loaded.
if ($('#screen-study').classList.contains('active')) studyShow();
else stRender();


/* ───────── Practice tab: Review, Saved and "Say it like a native" ─────────
   Phrases are rows in the phrases table (one per request); the "Web phrase"
   workflow updates status/stage and uploads lesson.json + voices to storage
   (lessons/<id>/), so they play and save exactly like lesson sentences. */
const PH_STEPS = [
  'Gathering real sentences from our videos',
  'Searching real native speech, then asking a native-speaker AI and double-checking it',
  'Adding stress marks and word-by-word meanings',
  'Recording the natural voice',
  'Publishing',
];
let phrases = store.get('phrases', []);            // rows: {id, text, status, stage, error, created_at}
const phData = {};                                  // id → lesson.json
let phOpenId = store.get('phOpen', undefined);      // the one open result (null = all closed)
function phSetOpen(id) { phOpenId = id; store.set('phOpen', id); }
let dkOpenId = null;                                // the open Anki deck (decks start closed: they're long)

function openPhrasesPage() {
  stOpenPage('phrases');
  renderPhrases();
  phRefresh();
}
function openAnki() {
  stOpenPage('anki');
  renderAnki();
  renderPhrases();
}
function renderAnki() {
  const n = dueCards('anki').length, decks = phrases.filter(isDeck).length;
  $('#pr-anki').hidden = !(decks || meAdmin);
  $('#pr-due-anki').hidden = !n;
  $('#pr-due-anki').textContent = n;
  $('#pr-due-anki-l').textContent = decks ? `${decks} deck${decks === 1 ? '' : 's'}${n ? ` · ${n} card${n === 1 ? '' : 's'} ready` : ''}` : 'Import your Anki decks';
  $('#ak-review').textContent = n ? `Review ${n} Anki Card${n === 1 ? '' : 's'}` : 'Anki: All Caught Up';
  $('#ak-review').classList.toggle('done', !n);
}

function practiceShow() {
  const live = Object.values(cards).filter(c => !c.deleted);
  const due = dueCards('app').length, dueAnki = dueCards('anki').length;
  const saved = live.filter(c => cardSet(c) === 'app').length;
  $('#mc-review-n').hidden = !due;
  $('#mc-review-n').textContent = due;
  $('#mc-review').classList.toggle('lit', due > 0);
  $('#mc-review-sub').textContent = due ? `${due} card${due === 1 ? '' : 's'} ready` : saved ? 'All caught up. Nice work!' : 'Save words and sentences to review them';
  $('#mc-saved-sub').textContent = live.length ? `${live.length} word${live.length === 1 ? '' : 's'} and sentences` : 'Words and sentences you saved';
  const nph = phrases.filter(p => !isDeck(p)).length;
  $('#mc-phrases-sub').textContent = nph ? `${nph} phrase${nph === 1 ? '' : 's'} · type a new one` : 'Type it in English or Russian';
  renderAnki();
  renderPhrases();
  phRefresh();
  checkAdmin();
}
window.practiceShow = practiceShow;

let phTimer = null;
async function phRefresh() {
  clearTimeout(phTimer);
  if (!session) return;
  try {
    const before = new Map(phrases.map(p => [p.id, p.status]));
    phrases = await db('phrases?select=id,text,status,stage,error,created_at&order=created_at.desc&limit=60');
    store.set('phrases', phrases);
    await Promise.all(phrases.filter(p => p.status === 'ready' && !phData[p.id]).map(async p => {
      try {
        const r = await fetch(fileUrl(p.id, 'lesson.json'), { cache: 'no-cache' });
        if (!r.ok) return;
        phData[p.id] = await r.json();
        audioMaps[p.id] = phData[p.id].audio?.clips || {};
        if (before.has(p.id) && before.get(p.id) !== 'ready') phSetOpen(p.id);   // just finished: show it
      } catch { /* next time */ }
    }));
    renderPhrases();
  } catch (e) { console.warn('phrases', e); }
  if (phrases.some(p => p.status === 'queued' || p.status === 'processing')) phTimer = setTimeout(phRefresh, 6000);
}

async function phStart(textArg) {
  const text = (textArg ?? $('#ph-input').value).replace(/\s+/g, ' ').trim();
  if (!text) { toast('Type what you want to say'); $('#ph-input').focus(); return; }
  if (phrases.some(x => x.status !== 'failed' && x.text.toLowerCase() === text.toLowerCase())) { toast('Already on it: see below'); $('#ph-input').value = ''; return; }
  $('#ph-go').disabled = true;
  try {
    const { phrase } = await api('phrases', { text });
    phrases.unshift(phrase);
    $('#ph-input').value = '';
    renderPhrases();
    phTimer = setTimeout(phRefresh, 4000);
  } catch (e) { toast(e.message); } finally { $('#ph-go').disabled = false; }
}

const isDeck = p => p.id.startsWith('dk-');
const DK_STEPS = ['Reading your Anki sentences', 'Adding stress marks and word-by-word meanings', 'Recording the natural voice', 'Publishing'];
function renderPhrases() {
  renderList($('#dk-list'), phrases.filter(isDeck), true);
  renderList($('#ph-list'), phrases.filter(p => !isDeck(p)), false);
  $('#dk-import').hidden = !meAdmin;
  const nph = phrases.filter(p => !isDeck(p)).length;
  if ($('#mc-phrases-sub')) $('#mc-phrases-sub').textContent = nph ? `${nph} phrase${nph === 1 ? '' : 's'} · type a new one` : 'Type it in English or Russian';
  renderAnki();
  $('#dk-import').textContent = phrases.some(isDeck) ? 'Update My Anki Decks' : 'Import My Anki Decks';
}
function renderList(list, items, decks) {
  if (!list) return;
  // Nothing chosen yet (or it was deleted): open the newest finished one.
  if (!decks && (phOpenId === undefined || (phOpenId !== null && !phrases.some(p => p.id === phOpenId)))) {
    phOpenId = items.find(p => p.status === 'ready' && phData[p.id])?.id;
  }
  list.innerHTML = items.length ? items.map(p => {
    const del = `<button class="ph-x" data-s="ph-del" data-id="${p.id}" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`;
    let head = `<div class="ph-q"><b>${decks ? `📚 ${esc(p.text)}` : `“${esc(p.text)}”`}</b>${del}</div>`;
    const d = phData[p.id];
    if (p.status === 'ready' && d) {
      const open = p.id === (decks ? dkOpenId : phOpenId);
      head = `<div class="ph-q ph-fold${open ? ' open' : ''}"><div class="ph-head" role="button" tabindex="0" data-s="ph-toggle" data-id="${p.id}" aria-expanded="${open}">
        <span class="ph-chev"><svg viewBox="0 0 24 24"><path d="M9 5.5l6.5 6.5L9 18.5"/></svg></span><span class="ph-title"><b>${decks ? `📚 ${esc(p.text)}` : `“${esc(p.text)}”`}</b>${open ? '' : `<small>${decks ? `${d.sentences.length} ${d.vocab ? 'words' : 'sentences'} · ${esc(d.sentences[0]?.ru || '')}` : `${esc(d.sentences[0]?.ru || '')}${d.sentences.length > 1 ? ` · ${d.sentences.length} ways` : ''}`}</small>`}</span></div>${del}</div>`;
      if (!open) return `<div class="ph-item">${head}</div>`;
    }
    if (p.status === 'failed') return `<div class="ph-item">${head}<div class="ph-wait">⚠️ ${esc(p.error || 'Something went wrong.')} <button class="text-button" data-s="ph-retry" data-id="${p.id}">Try again</button></div></div>`;
    if (p.status !== 'ready' || !d) {
      const STEPS = decks ? DK_STEPS : PH_STEPS;
      const step = p.status === 'ready' ? STEPS.length - 1 : STEPS.indexOf(p.stage);
      return `<div class="ph-item">${head}<div class="ph-wait ph-steps">${STEPS.map((label, k) =>
        `<div class="${k < step ? 'done' : k === step ? 'now' : ''}"><i>${k < step ? '✓' : k === step ? '<span class="spinner"></span>' : '•'}</i><span>${label}</span></div>`).join('')}
        <p class="ph-why">${step < 0 ? 'Starting… ' : ''}${decks ? 'Takes a few minutes: every sentence gets stress marks, word-by-word meanings and a natural voice.' : 'Takes about 2–3 minutes: we check real native speech first instead of guessing.'}</p></div></div>`;
    }
    const chk = d.check?.verdict ? `<div class="ph-check ${d.check.verdict === 'natural' ? 'good' : 'bad'}"><b>Your Russian: ${esc(d.check.verdict)}.</b> ${esc(d.check.comment || '')}</div>` : '';
    const gendered = d.sentences.some(s => s.who);
    const unsaved = d.sentences.filter((_, i) => !isSaved(`${p.id}:${i}`)).length;
    const top = decks ? `<div class="dk-top"><span>Tap any word to hear it, see its meaning and save it.</span>
      <button class="chip${unsaved ? ' on' : ''}" data-s="dk-save-all" data-id="${p.id}"${unsaved ? '' : ' disabled'}>${unsaved ? `☆ Save all ${unsaved} to Review` : '★ All in Review'}</button></div>` : '';
    return `<div class="ph-item">${head}${chk}${top}${d.sentences.map((s, i) => {
      const ctx = s.context === 'polite' ? 'with strangers' : s.context || '';
      const who = s.who || (gendered ? 'man or woman' : '');
      const id = `${p.id}:${i}`;
      const heard = (s.matches || []).length ? `<div class="ph-heard"><b>🎬 Heard in ${s.matches.length} real video sentence${s.matches.length === 1 ? '' : 's'}</b>${s.matches.map(m =>
        `<button data-s="ph-heard" data-lesson="${esc(m.lesson)}" data-i="${m.i}">${esc(m.ru)}<span>${esc(m.title || '')}</span></button>`).join('')}</div>` : '';
      return `<div class="ph-v">
        <div class="ph-top"><span class="ph-ctx">${esc(ctx)}${ctx && who ? ' · ' : ''}${who ? `<em>${esc(who)}</em>` : ''}</span>
          <button class="ph-star${isSaved(id) ? ' on' : ''}" data-s="ph-save" data-id="${p.id}" data-i="${i}" aria-label="Save to review">${isSaved(id) ? '★' : '☆'}</button></div>
        <div class="il">${tokensHTML(s.tokens, true, { i, ph: p.id })}</div>
        ${s.en ? `<p class="en">${esc(s.en)}</p>` : ''}
        ${s.note ? `<div class="ph-note">${esc(s.note)}</div>` : ''}
        ${s.flag ? `<div class="ph-flag">⚠️ ${esc(s.flag)}</div>` : ''}
        <div class="ph-tools"><button class="chip" data-s="ph-say" data-id="${p.id}" data-i="${i}" data-rate="${RATE_NORMAL}">🔊 Normal</button>
          <button class="chip" data-s="ph-say" data-id="${p.id}" data-i="${i}" data-rate="${RATE_SLOW}">🐢 Slowly</button></div>
        ${decks ? '' : '<p class="ph-hint">Tap any word to hear it, see its meaning and save it.</p>'}
        ${heard}
      </div>`;
    }).join('')}</div>`;
  }).join('') : decks ? '' : '<div class="empty-card"><span class="big">💬</span><b>What do you want to be able to say?</b><span>Try “No worries, take your time” or “Can I get the check?”</span></div>';
}

// A saved item: a sentence card, or for a one-word vocabulary item a word card
// (reviewed like words saved from lessons, with your English as its meaning).
function deckCard(pid, i, now = Date.now()) {
  const d = phData[pid], s = d.sentences[i], id = `${pid}:${i}`;
  const base = { id, lesson: pid, title: d.input, i, start: 0, end: 0, ru: s.ru, tokens: s.tokens.map(({ w, g }) => ({ w, g })), en: s.en,
    created: now + i, updated: now, due: now, ivl: 0, ease: 2.5, reps: 0, seen: 0, lapses: 0 };
  if (d.vocab && s.tokens.length === 1) {
    const t = s.tokens[0];
    return { ...base, kind: 'word', k: 0, w: t.w, g: t.g || '', b: t.b || '', m: s.en || t.m || '' };
  }
  return base;
}

function dkSaveAll(pid) {
  const d = phData[pid];
  if (!d) return;
  const now = Date.now(), ids = [];
  d.sentences.forEach((s, i) => {
    const id = `${pid}:${i}`;
    if (isSaved(id)) return;
    cards[id] = deckCard(pid, i, now);
    ids.push(id);
  });
  if (!ids.length) return;
  cardsChanged(ids);
  toast(`Added ${ids.length} ${d.vocab ? 'words' : 'sentences'} to Review ⭐`);
  window.engage?.xp(3);
  renderPhrases();
  practiceShow();
}

let meAdmin = store.get('meAdmin', false);
async function checkAdmin() {
  try { meAdmin = !!(await api('me')).admin; store.set('meAdmin', meAdmin); renderPhrases(); } catch { /* offline */ }
}

async function dkImport() {
  const btn = $('#dk-import');
  btn.disabled = true;
  try {
    const { decks } = await api('decks', {});
    const replaced = new Set(decks.map(d => d.id.split('-').slice(0, -1).join('-')));   // "dk-<source>"
    phrases = [...decks, ...phrases.filter(p => !(isDeck(p) && replaced.has(p.id.split('-').slice(0, -1).join('-'))))];
    renderPhrases();
    toast('Importing your Anki decks… this takes a few minutes');
    phTimer = setTimeout(phRefresh, 4000);
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

function phToggleSave(pid, i) {
  const d = phData[pid], s = d?.sentences[i];
  if (!s) return;
  const id = `${pid}:${i}`;
  if (isSaved(id)) {
    cards[id].deleted = true;
    cards[id].updated = Date.now();
    toast('Removed from review');
  } else {
    cards[id] = deckCard(pid, i);
    toast('Saved for review ⭐');
    window.engage?.xp(3);
  }
  cardsChanged(id);
  renderPhrases();
}

function deckRemoveSheet(id) {
  const p = phrases.find(x => x.id === id);
  const n = Object.values(cards).filter(c => !c.deleted && c.lesson === id).length;
  openSheet('Remove deck', `
    <p style="font-size:17px;margin:4px 4px 16px">Remove <b>📚 ${esc(p?.text || 'this deck')}</b> from Nativnik? Your Anki app and files aren’t touched, and you can bring it back with Update My Anki Decks.</p>
    ${n ? `<button class="secondary-button destructive" data-s="dk-remove" data-id="${esc(id)}" data-cards="1">Remove Deck and Its ${n} Review Card${n === 1 ? '' : 's'}</button>` : ''}
    <button class="secondary-button${n ? '' : ' destructive'}" data-s="dk-remove" data-id="${esc(id)}" data-cards="0">${n ? 'Remove Deck, Keep My Review Cards' : 'Remove Deck'}</button>
    <button class="secondary-button" data-s="sheet-close">Cancel</button>`);
}
async function dkRemove(id, withCards) {
  closeSheet();
  try { await db(`phrases?id=eq.${id}`, { method: 'DELETE' }); } catch (e) { toast(e.message); return; }
  if (withCards) {
    const ids = Object.values(cards).filter(c => !c.deleted && c.lesson === id).map(c => c.id);
    ids.forEach(cid => { cards[cid].deleted = true; cards[cid].updated = Date.now(); });
    if (ids.length) cardsChanged(ids);
  }
  phrases = phrases.filter(x => x.id !== id);
  store.set('phrases', phrases);
  toast('Deck removed');
  practiceShow();
}

async function phDelete(id) {
  if (id.startsWith('dk-')) { deckRemoveSheet(id); return; }
  if (!confirm('Delete this phrase? Anything you saved to Review stays.')) return;
  try { await db(`phrases?id=eq.${id}`, { method: 'DELETE' }); } catch (e) { toast(e.message); return; }
  phrases = phrases.filter(x => x.id !== id);
  store.set('phrases', phrases);
  renderPhrases();
}

/* Tapping a word: hear it, see its meaning, save it, and find it in real video
   sentences (matched by dictionary form, so спала also finds спал). */
let phWordOpen = null;   // { pid, i, k }
const plainKey = w => (w || '').normalize('NFD').replace(/́/g, '').normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9-]/g, '');
const videoData = {};
async function phWordInVideos(t) {
  const want = plainKey(t.b || t.w), surface = plainKey(t.w);
  if (!want) return [];
  const vids = lessons.filter(l => l.state === 'ready');
  await Promise.all(vids.filter(l => !videoData[l.id]).map(l =>
    fetch(fileUrl(l.id, 'lesson.json'), { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) videoData[l.id] = d; }).catch(() => {})));
  const found = [];
  for (const l of vids) {
    (videoData[l.id]?.sentences || []).forEach((s, i) => {
      const k = (s.tokens || []).findIndex(x => (x.b ? plainKey(x.b) === want : false) || plainKey(x.w) === surface);
      if (k >= 0) found.push({ lesson: l.id, title: videoData[l.id].title || '', i, k, s });
    });
  }
  return found.sort((a, b) => a.s.tokens.length - b.s.tokens.length).slice(0, 4);
}

function phOpenWord(pid, i, k) {
  const d = phData[pid], s = d?.sentences[i], t = s?.tokens[k];
  if (!t) return;
  phWordOpen = { pid, i, k };
  const id = `${pid}:${i}:${k}`;
  openSheet('Word', `
    <div class="word-card">
      <div class="wc-word" id="wc-word">${syllablesHTML(t.w)}</div>
      ${t.g ? `<div class="wc-here">${esc(t.g)}</div>` : ''}
      <div class="wc-audio">
        <button class="chip" data-s="phw-say" data-rate="${RATE_NORMAL}">🔊 Normal</button>
        <button class="chip" data-s="phw-say" data-rate="${RATE_SLOW}">🐢 Slowly</button>
      </div>
      ${t.b || t.m ? `<div class="group kv wc-dict">
        ${t.b ? `<div class="cell"><div class="k">Dictionary form</div><span class="wc-base">${esc(t.b)}</span></div>` : ''}
        ${t.m ? `<div class="cell"><div class="k">Meaning</div>${esc(t.m)}</div>` : ''}
      </div>` : ''}
      <div class="wc-sentence">
        <div class="k">In this sentence</div>
        <div class="il">${tokensHTML(s.tokens, false, { hl: k })}</div>
        ${s.en ? `<p class="en">${esc(s.en)}</p>` : ''}
      </div>
      <div class="ph-heard" id="phw-videos"><b><span class="spinner"></span> Looking for it in your videos…</b></div>
      <button class="primary-button${isSaved(id) ? ' saved-btn' : ''}" data-s="phw-save">${isSaved(id) ? '★ Saved (tap to remove)' : '☆ Save Word'}</button>
    </div>`);
  phWordInVideos(t).then(found => {
    const box = $('#phw-videos');
    if (!box || phWordOpen?.pid !== pid || phWordOpen.i !== i || phWordOpen.k !== k) return;
    box.innerHTML = found.length
      ? `<b>🎬 In your videos</b>${found.map(f => `<button data-s="ph-heard" data-lesson="${esc(f.lesson)}" data-i="${f.i}">${f.s.tokens.map((x, j) => (j === f.k ? `<mark>${esc(x.w)}</mark>` : esc(x.w))).join(' ')}<span>${esc(f.title)}</span></button>`).join('')}`
      : '<b>Not in your videos yet.</b> Add more lessons and it may turn up.';
  });
}

function phToggleWord() {
  const { pid, i, k } = phWordOpen;
  const d = phData[pid], s = d.sentences[i], t = s.tokens[k];
  const id = `${pid}:${i}:${k}`;
  if (isSaved(id)) {
    cards[id].deleted = true;
    cards[id].updated = Date.now();
    toast('Word removed from review');
  } else {
    const now = Date.now();
    cards[id] = {
      id, kind: 'word', lesson: pid, title: d.input, i, k,
      w: t.w, g: t.g || '', b: t.b || '', m: t.m || '',
      start: 0, end: 0, ru: s.ru, tokens: s.tokens.map(({ w, g }) => ({ w, g })), en: s.en,
      created: now, updated: now, due: now, ivl: 0, ease: 2.5, reps: 0, seen: 0, lapses: 0,
    };
    toast('Word saved ⭐');
    window.engage?.xp(3);
  }
  cardsChanged(id);
  renderPhrases();
  phOpenWord(pid, i, k);
}

// A real video sentence: open that lesson there (adding it to your list if needed).
async function phOpenHeard(lessonId, i) {
  closeSheet();
  let l = lessons.find(x => x.id === lessonId && x.state === 'ready');
  if (!l) {
    await stStart(`https://www.youtube.com/watch?v=${lessonId}`);
    await stRefresh();
    l = lessons.find(x => x.id === lessonId && x.state === 'ready');
    if (!l) return;
  }
  store.set(`pos.${l.id}`, i);
  await openLesson(l);
  playSentence(i);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-s]');
  if (!el) return;
  const id = el.dataset.id, i = Number(el.dataset.i);
  switch (el.dataset.s) {
    case 'pr-review': if (dueCards('app').length) startReview(null, 'practice', 'app'); else toast('Nothing due right now. Save words and sentences to review them.'); break;
    case 'pr-review-anki': if (dueCards('anki').length) startReview(null, 'practice', 'anki'); else toast('No Anki cards due right now.'); break;
    case 'ph-toggle':
      if (id.startsWith('dk-')) dkOpenId = dkOpenId === id ? null : id; else phSetOpen(phOpenId === id ? null : id);
      renderPhrases(); break;
    case 'ph-del': phDelete(id); break;
    case 'dk-save-all': dkSaveAll(id); renderAnki(); break;
    case 'open-anki': openAnki(); break;
    case 'open-phrases': openPhrasesPage(); break;
    case 'dk-remove': dkRemove(id, el.dataset.cards === '1'); break;
    case 'sheet-close': closeSheet(); break;
    case 'ph-retry': { const p = phrases.find(x => x.id === id); if (p) { phrases = phrases.filter(x => x !== p); phStart(p.text); } break; }
    case 'ph-save': phToggleSave(id, i); break;
    case 'ph-say': { const d = phData[id]; if (d) saySentence({ ru: d.sentences[i].ru, lesson: id }, Number(el.dataset.rate)); break; }
    case 'ph-heard': phOpenHeard(el.dataset.lesson, i); break;
    case 'ph-word': {
      phOpenWord(id, i, Number(el.dataset.k));
      const t = phData[id]?.sentences[i]?.tokens[Number(el.dataset.k)];
      if (t) speak(t.w, [RATE_NORMAL, RATE_SLOW], $('#wc-word'), id);   // inside the tap, so iOS allows it
      break;
    }
    case 'phw-say': { const t = phData[phWordOpen.pid].sentences[phWordOpen.i].tokens[phWordOpen.k]; speak(t.w, Number(el.dataset.rate), $('#wc-word'), phWordOpen.pid); break; }
    case 'phw-save': phToggleWord(); break;
  }
});
$('#ph-go').addEventListener('click', () => phStart());
$('#dk-import').addEventListener('click', dkImport);
$('#sv-set').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { svSet = b.dataset.set; renderSaved(); } });
$('#ph-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); phStart(); } });
if ($('#screen-practice').classList.contains('active')) practiceShow();
