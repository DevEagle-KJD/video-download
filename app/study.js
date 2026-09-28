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
  ['Translate', 'Adding meanings & translations'],
  ['Publish', 'Publishing lesson'],
];
const DAY = 864e5;
const PAD_BEFORE = 0.15, PAD_AFTER = 0.25;

let lessons = store.get('lessons', []);
let cards = store.get('cards', {});                 // id → card (deleted ones kept as tombstones)
const prefs = Object.assign({ literal: true, english: true, follow: true, loop: false, autopause: false, speed: 1 },
  store.get('studyPrefs', {}));
const saveLessons = () => store.set('lessons', lessons);
const savePrefs = () => store.set('studyPrefs', prefs);

/* ───────── Lessons: create + track ───────── */
async function stStart(url) {
  if (!configured()) { toast('Add your GitHub token in Settings first'); showScreen('settings'); return; }
  const m = String(url || '').match(/https?:\/\/\S+/i);
  if (!m) { toast('Paste a video link first'); $('#st-url').focus(); return; }
  const lesson = { id: randomId(), url: m[0], created: Date.now(), state: 'starting' };
  lessons.unshift(lesson);
  saveLessons();
  stRender();
  try {
    await gh(`/actions/workflows/${ST_WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref: await defaultBranch(), inputs: { url: lesson.url, job_id: lesson.id } },
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
      if (next.some(l => l.id === id)) continue;
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
    saveLessons();
    closeSheet();
    stBack();
    stRender();
    toast('Lesson deleted');
  } catch (e) {
    toast(e.message);
  }
}

/* ───────── Study home ───────── */
function dueCards() {
  const now = Date.now();
  return Object.values(cards).filter(c => !c.deleted && c.due <= now).sort((a, b) => a.due - b.due);
}

function stRender() {
  const live = Object.values(cards).filter(c => !c.deleted);
  const due = dueCards().length;
  const nWords = live.filter(c => c.kind === 'word').length, nSent = live.length - nWords;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  $('#st-review-card').innerHTML = live.length
    ? `<div class="rc-text"><b>${due ? `${plural(due, 'card')} to review` : 'All caught up'}</b>
         <span>${[nSent && `${plural(nSent, 'sentence')} mined`, nWords && `${plural(nWords, 'word')} saved`].filter(Boolean).join(' · ')}</span></div>
       <button class="rc-btn" data-s="review" ${due ? '' : 'disabled'}>Review</button>`
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
      sub = `${m.count || 0} sentences${mined ? ` · ${mined} mined` : ''}${m.duration ? ` · ${fmtDuration(m.duration)}` : ''}`;
      dot = 'ready';
    } else if (l.state === 'failed') {
      sub = 'Failed'; dot = 'failed';
    } else {
      sub = l.state === 'starting' ? 'Sending to GitHub…' : `${l.stage || 'Waiting for GitHub'}…`;
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
  $('#ls-video').pause();
  $('#rv-video').pause();
  stop();
  document.body.classList.remove('in-page');
  showScreen(prevTab);
  stRender();
}

/* ───────── Lesson player ───────── */
let lesson = null;          // { id, data }
let cur = -1;               // active sentence index
let stopAt = null;          // stop playback at this time (sentence mode)
let loopFrom = null;        // loop start time when looping one sentence
let nextAfterStop = null;   // "Pause each": sentence to play on the next ▶
let rafId = 0;

async function openLesson(l) {
  if (l.state === 'failed') {
    openSheet('Lesson failed', `<p class="job-error" style="font-size:15px">${esc(l.error || 'Something went wrong.').replace(/\n/g, '<br>')}</p>
      ${l.url ? `<button class="primary-button" data-s="retry" data-id="${l.id}" style="margin-top:16px">Try Again</button>` : ''}
      ${l.runUrl ? `<a class="secondary-button" href="${esc(l.runUrl)}" target="_blank" rel="noopener">View Log on GitHub</a>` : ''}
      <button class="secondary-button destructive" data-s="forget" data-id="${l.id}">Remove</button>`);
    return;
  }
  if (l.state !== 'ready') { toast(`${l.stage || 'Still working'}… it’ll be ready soon`); return; }

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
  cur = -1;
  stopAt = null; loopFrom = null; nextAfterStop = null;
  const v = $('#ls-video');
  v.src = `files/${l.id}/media.mp4`;
  v.playbackRate = prefs.speed;
  $('#ls-title').textContent = data.title || 'Lesson';
  renderTranscript();
  syncChips();
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
    return `<span class="tok${k === hl ? ' hl' : ''}${saved ? ' saved' : ''}"${attrs}><b>${esc(t.w)}</b>${withGloss ? `<i>${esc(t.g || ' ')}</i>` : ''}</span>`;
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

function syncChips() {
  $('#ls-speed').textContent = `${prefs.speed}×`;
  $('#ls-speed').classList.toggle('on', prefs.speed !== 1);
  $('#ls-loop').classList.toggle('on', prefs.loop);
  $('#ls-autopause').classList.toggle('on', prefs.autopause);
  $('#ls-literal').classList.toggle('on', prefs.literal);
  $('#ls-english').classList.toggle('on', prefs.english);
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
  if (scroll && prefs.follow) {
    const scroller = $('#screen-lesson');
    const playerBottom = $('#screen-lesson .player').getBoundingClientRect().bottom;
    const r = el.getBoundingClientRect();
    if (r.top < playerBottom + 8 || r.bottom > window.innerHeight - 40) {
      scroller.scrollBy({ top: r.top - playerBottom - 16, behavior: 'smooth' });
    }
  }
}

function setPlayIcon(playing) {
  $('#ls-playicon').innerHTML = playing ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
}

let sayEl = null;
function highlightWord(t) {
  let el = null;
  const s = lesson.data.sentences[cur];
  if (s && t <= s.end + PAD_AFTER) {
    const times = wordTimes(s);
    const k = times.findIndex(([a, b], n) => t >= a - 0.05 && (t < b || n === times.length - 1 || t < times[n + 1][0]));
    if (k >= 0) el = $(`#ls-transcript .sent[data-i="${cur}"] .tok[data-k="${k}"]`);
  }
  if (el !== sayEl) {
    sayEl?.classList.remove('say');
    el?.classList.add('say');
    sayEl = el;
  }
}

function tick() {
  const v = $('#ls-video');
  if (!lesson || v.paused) { rafId = 0; sayEl?.classList.remove('say'); sayEl = null; return; }
  const t = v.currentTime;
  const i = sentenceAt(t);
  if (i >= 0) setActive(i);
  highlightWord(t);
  if (stopAt != null && t >= stopAt) {
    if (prefs.loop && loopFrom != null) {
      v.currentTime = loopFrom;
    } else {
      v.pause();
      stopAt = null;
      if (prefs.autopause) nextAfterStop = cur + 1;
    }
  }
  rafId = requestAnimationFrame(tick);
}

function startTick() { if (!rafId) rafId = requestAnimationFrame(tick); }
function stop() { cancelAnimationFrame(rafId); rafId = 0; }

function playSentence(i) {
  const ss = lesson.data.sentences;
  if (i < 0 || i >= ss.length) return;
  const s = ss[i];
  const v = $('#ls-video');
  nextAfterStop = null;
  loopFrom = Math.max(0, s.start - PAD_BEFORE);
  stopAt = s.end + PAD_AFTER;
  v.currentTime = loopFrom;
  setActive(i);
  v.play().catch(() => {});
  startTick();
  store.set(`pos.${lesson.id}`, i);
}

function togglePlay() {
  const v = $('#ls-video');
  if (!v.paused) { v.pause(); return; }
  if (nextAfterStop != null) { playSentence(nextAfterStop); return; }
  if (prefs.autopause || prefs.loop) { playSentence(Math.max(0, cur)); return; }
  // Continuous play from the current sentence.
  stopAt = null; loopFrom = null;
  if (cur >= 0 && Math.abs(v.currentTime - lesson.data.sentences[cur].start) > 30) {
    v.currentTime = Math.max(0, lesson.data.sentences[cur].start - PAD_BEFORE);
  }
  v.play().catch(() => {});
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

function speak(text, rate = 0.5) {
  if (!('speechSynthesis' in window)) { toast('Speech isn’t available in this browser'); return; }
  if (!ruVoice) pickVoice();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plainWord(text));
  u.lang = 'ru-RU';
  if (ruVoice) u.voice = ruVoice;
  u.rate = rate;
  speechSynthesis.speak(u);
  if (!ruVoice) setTimeout(() => { if (!ruVoice) toast('No Russian voice found. Add one in Settings → Accessibility → Spoken Content → Voices'); }, 800);
}

// Plays just one word from the lesson video.
function playWord(i, k) {
  const [a, b] = wordTimes(lesson.data.sentences[i])[k];
  const v = $('#ls-video');
  nextAfterStop = null;
  loopFrom = null;
  stopAt = b + 0.12;
  v.currentTime = Math.max(0, a - 0.08);
  v.play().catch(() => {});
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
      <div class="wc-word">${esc(t.w.replace(/[.,!?…:;«»"“”()]+$|^[«"“(]+/g, ''))}</div>
      ${t.g ? `<div class="wc-here">${esc(t.g)}</div>` : ''}
      <div class="wc-audio">
        <button class="chip" data-s="w-say" data-rate="0.45">🔊 Slowly</button>
        <button class="chip" data-s="w-say" data-rate="0.85">🔊 Normal</button>
        <button class="chip" data-s="w-video">🎬 From the video</button>
      </div>
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

function lessonMenu() {
  const d = lesson.data;
  const src = d.source === 'subtitles' ? 'the video’s own Russian subtitles' : 'Whisper speech recognition';
  openSheet('Lesson', `
    <div class="group kv">
      <div class="cell"><div class="k">Title</div>${esc(d.title || '')}</div>
      <div class="cell"><div class="k">Transcript</div>From ${src} · ${d.sentences.length} sentences</div>
      ${d.model ? `<div class="cell"><div class="k">Meanings & translations</div>${esc(d.model)}</div>` : ''}
    </div>
    ${lesson.url ? `<a class="secondary-button" href="${esc(lesson.url)}" target="_blank" rel="noopener" style="margin-top:12px">Open Original Video</a>` : ''}
    <button class="secondary-button" data-s="lesson-help">How to use this page</button>
    <button class="secondary-button destructive" data-s="delete-lesson">Delete Lesson</button>`);
}

function helpSheet() {
  openSheet('How to use a lesson', `<ol>
    <li><b>Tap a word</b> to hear it slowly, hear it from the video, see its meaning, and save it.</li>
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

function startReview() {
  queue = dueCards().slice(0, 50);
  if (!queue.length) { toast('Nothing due right now'); return; }
  qi = 0; reviewed = 0;
  prevTab = 'study';
  stOpenPage('review');
  showCard();
}

function nextIntervals(c) {
  const out = {};
  for (const g of ['again', 'good', 'easy']) out[g] = schedule({ ...c }, g).ivl;
  return out;
}

function schedule(c, grade) {
  const now = Date.now();
  c.seen = (c.seen || 0) + 1;
  if (grade === 'again') {
    c.lapses = (c.lapses || 0) + 1;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.ivl = 0;
    c.due = now + 10 * 60e3;
  } else {
    if (grade === 'good') c.ivl = c.ivl < 1 ? 1 : c.ivl < 3 ? 3 : Math.round(c.ivl * c.ease);
    else { c.ivl = c.ivl < 1 ? 3 : Math.round(Math.max(c.ivl, 1) * c.ease * 1.3); c.ease += 0.15; }
    c.reps = (c.reps || 0) + 1;
    c.due = now + c.ivl * DAY;
  }
  c.updated = now;
  return c;
}

function fmtIvl(days) {
  if (days < 1) return '10m';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
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
  revealed = false;
  const mode = MODES[(c.seen || 0) % MODES.length];
  const v = $('#rv-video');
  const src = `files/${c.lesson}/media.mp4`;
  const hasVideo = lessons.some(l => l.id === c.lesson && l.state === 'ready');
  v.hidden = !hasVideo;
  if (hasVideo && !v.src.endsWith(src)) v.src = src;
  $('#rv-count').textContent = `${qi + 1} of ${queue.length}`;

  if (c.kind === 'word') {
    const listen = (c.seen || 0) % 2 === 1;
    $('#rv-body').innerHTML = `
      <p class="rv-hint">${listen ? 'Listen. What’s the word, and what does it mean?' : 'What does this word mean?'}</p>
      <div class="rv-front">${listen ? '<div class="listen-icon">🔊</div>' : `<div class="wc-word">${esc(c.w)}</div>`}</div>
      <div class="rv-tools"><button class="chip" data-s="rv-say">🔊 Hear it</button></div>
      <button class="primary-button" data-s="rv-show">Show</button>`;
    if (listen) speak(c.w);   // right away, while still inside the tap (iOS requires it)
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
      <button class="grade again" data-s="grade" data-g="again"><b>Again</b><span>${fmtIvl(iv.again)}</span></button>
      <button class="grade good" data-s="grade" data-g="good"><b>Good</b><span>${fmtIvl(iv.good)}</span></button>
      <button class="grade easy" data-s="grade" data-g="easy"><b>Easy</b><span>${fmtIvl(iv.easy)}</span></button>
    </div>`;
  if (c.kind === 'word') {
    $('#rv-body').innerHTML = `
      <div class="rv-back">
        <div class="wc-word">${esc(c.w)}</div>
        ${c.g ? `<div class="wc-here">${esc(c.g)}</div>` : ''}
        ${c.b || c.m ? `<p class="wc-dictline">${c.b ? `<b>${esc(c.b)}</b>` : ''}${c.b && c.m ? ' · ' : ''}${esc(c.m)}</p>` : ''}
        <div class="il" style="margin-top:14px">${tokensHTML(c.tokens, true, { hl: c.k })}</div>
        ${c.en ? `<p class="en">${esc(c.en)}</p>` : ''}
        <p class="rv-src">${esc(c.title || '')}</p>
      </div>
      <div class="rv-tools">
        <button class="chip" data-s="rv-say">🔊 Slowly</button>
        ${hasVideo ? `<button class="chip" data-s="rv-word">🎬 Word</button><button class="chip" data-s="rv-play">▶ Sentence</button>` : ''}
      </div>
      ${grades}`;
    if (hasVideo) playClip(c, 1, true); else speak(c.w);
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
  if (g === 'again') queue.push(c);       // see it again this session
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
    case 'forget': lessons = lessons.filter(x => x.id !== id); saveLessons(); closeSheet(); stRender(); break;
    case 'back': stBack(); break;
    case 'sent': playSentence(i); break;
    case 'replay': playSentence(i); break;
    case 'word': openWord(i, Number(el.dataset.k)); break;
    case 'w-say': speak(lesson.data.sentences[wordOpen.i].tokens[wordOpen.k].w, Number(el.dataset.rate)); break;
    case 'w-say-base': speak(lesson.data.sentences[wordOpen.i].tokens[wordOpen.k].b, 0.45); break;
    case 'w-video': playWord(wordOpen.i, wordOpen.k); break;
    case 'w-save': toggleWord(); break;
    case 'rv-say': speak(queue[qi].w, 0.45); break;
    case 'rv-word': playClip(queue[qi], 1, true); break;
    case 'star': e.stopPropagation(); toggleStar(i); break;
    case 'toggle': togglePlay(); break;
    case 'prev': playSentence(Math.max(0, cur - 1)); break;
    case 'next': playSentence(cur + 1); break;
    case 'speed': {
      const speeds = [1, 0.75, 0.5];
      prefs.speed = speeds[(speeds.indexOf(prefs.speed) + 1) % speeds.length];
      $('#ls-video').playbackRate = prefs.speed;
      savePrefs(); syncChips(); break;
    }
    case 'loop': prefs.loop = !prefs.loop; savePrefs(); syncChips(); break;
    case 'autopause': prefs.autopause = !prefs.autopause; nextAfterStop = null; savePrefs(); syncChips(); break;
    case 'show-literal': prefs.literal = !prefs.literal; savePrefs(); syncChips(); applyDisplayPrefs(); break;
    case 'show-english': prefs.english = !prefs.english; savePrefs(); syncChips(); applyDisplayPrefs(); break;
    case 'show-follow': prefs.follow = !prefs.follow; savePrefs(); syncChips(); break;
    case 'lesson-menu': lessonMenu(); break;
    case 'lesson-help': closeSheet(); setTimeout(helpSheet, 350); break;
    case 'delete-lesson': { const l = lessons.find(x => x.id === lesson?.id); if (l) stDeleteLesson(l); break; }
    case 'review': startReview(); break;
    case 'rv-show': revealCard(); break;
    case 'rv-play': playClip(queue[qi]); break;
    case 'rv-slow': playClip(queue[qi], 0.6); break;
    case 'grade': grade(el.dataset.g); break;
  }
});

// Tapping the video itself plays/pauses.
$('#ls-video').addEventListener('click', togglePlay);

$('#st-make').addEventListener('click', () => stStart($('#st-url').value));
$('#st-url').addEventListener('keydown', e => { if (e.key === 'Enter') stStart($('#st-url').value); });
$('#st-refresh').addEventListener('click', () => { stRefresh(); syncLoad(); });

// app.js may have opened the Study tab before this file loaded.
if ($('#screen-study').classList.contains('active')) studyShow();
else {
  stRender();
  if (configured()) { syncLoad(); if (lessons.some(l => l.state !== 'ready' && l.state !== 'failed')) stSchedule(2000); }
}
