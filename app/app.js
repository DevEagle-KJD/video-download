'use strict';

/* Grab — a private, iPhone-style front end for the "Download" GitHub Actions
 * workflow in this repo. The app never touches the video site itself: it asks
 * GitHub to run yt-dlp, waits for the run, then pulls the finished file from a
 * temporary release and hands it to the iOS share sheet ("Save Video"). */

const WORKFLOW = 'download.yml';
const POLL_MS = 4000;
const QUALITY_HINTS = {
  best: 'The highest resolution the site offers, up to 4K/8K. Converted for iPhone if needed.',
  1080: 'Full HD. Uses the closest lower quality if 1080p isn’t available.',
  720: 'HD with smaller files. Uses the closest lower quality if 720p isn’t available.',
  audio: 'Audio only, as a high-quality MP3 (VBR V0, ~245 kbps) with cover art.',
};
const QUALITY_LABEL = { best: 'Best', 1080: '1080p', 720: '720p', audio: 'MP3' };
const STAGES = [
  ['Install tools', 'Preparing'],
  ['Download', 'Downloading'],
  ['Convert for iPhone', 'Converting for iPhone'],
  ['Upload', 'Uploading'],
];
const ACTIVE = new Set(['starting', 'queued', 'running', 'finishing']);

/* ───────── Storage ───────── */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem('grab.' + key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('grab.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const cfg = Object.assign({ owner: '', repo: '', token: '', branch: '' }, store.get('cfg', {}));
if (!cfg.owner && location.hostname.endsWith('.github.io')) {
  cfg.owner = location.hostname.split('.')[0];
  cfg.repo = location.pathname.split('/').filter(Boolean)[0] || '';
}
let jobs = store.get('jobs', []).filter(j => Date.now() - j.created < 7 * 864e5);
let quality = store.get('quality', 'best');
let currentId = store.get('current', null);
const files = new Map();      // job id → File downloaded this session
const transfers = new Map();  // job id → 0..1 progress while pulling the file
let sheetJobId = null;

const saveJobs = () => { store.set('jobs', jobs); store.set('current', currentId); };
const findJob = id => jobs.find(j => j.id === id);
const configured = () => cfg.owner && cfg.repo && cfg.token;

/* ───────── Helpers ───────── */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1000 && i < u.length - 1) { bytes /= 1000; i++; }
  return `${bytes.toFixed(bytes < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}
function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function fmtAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ───────── GitHub API ───────── */
async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `GitHub error ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* no body */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 || res.status === 202 ? null : res.json().catch(() => null);
}

async function defaultBranch() {
  if (!cfg.branch) {
    cfg.branch = (await gh('')).default_branch;
    store.set('cfg', cfg);
  }
  return cfg.branch;
}

/* ───────── Jobs ───────── */
async function startJob(url, q) {
  if (!configured()) {
    toast('Paste your token here first. The Home Screen app and Safari keep separate settings');
    showScreen('settings');
    return;
  }
  url = url.trim();
  const match = url.match(/https?:\/\/\S+/i);
  if (!match) { toast('That doesn’t look like a link'); return; }
  url = match[0];

  const job = { id: randomId(), url, quality: q, created: Date.now(), state: 'starting' };
  jobs.unshift(job);
  currentId = job.id;
  saveJobs();
  render();

  try {
    const ref = await defaultBranch();
    await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref, inputs: { url, quality: q, job_id: job.id } },
    });
    job.state = 'queued';
    $('#url').value = '';
    syncClear();
  } catch (e) {
    job.state = 'failed';
    job.error = e.status === 404
      ? 'Couldn’t find the Download workflow. Check the owner/repo in Settings and that your token has Actions: Read and write.'
      : e.message;
  }
  if (job.state === 'failed') restoreLink(job);
  saveJobs();
  render();
  schedulePoll(1500);
}

// After a failure, put the link back in the box (and its quality back in the
// picker) so it can be retried or tried at another quality without re-pasting.
function restoreLink(job) {
  if (!job.url || $('#url').value.trim()) return;
  $('#url').value = job.url;
  if (QUALITY_LABEL[job.quality]) setQuality(job.quality);
  syncClear();
}

function stageOf(ghJob) {
  let done = 0, now = -1;
  STAGES.forEach(([name], i) => {
    const step = ghJob.steps?.find(s => s.name === name);
    if (!step) return;
    if (step.status === 'completed') done = i + 1;
    else if (step.status === 'in_progress') now = i;
  });
  return { done, now };
}

async function updateJob(job) {
  if (!job.runId) {
    const since = new Date(job.created - 120e3).toISOString();
    const res = await gh(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30&created=%3E%3D${since}`);
    const run = res.workflow_runs.find(r => r.display_title === `dl ${job.id}`);
    if (!run) {
      if (Date.now() - job.created > 5 * 60e3) {
        job.state = 'failed';
        job.error = 'GitHub never started the download. Is Actions enabled for this repo?';
      }
      return;
    }
    job.runId = run.id;
    job.runUrl = run.html_url;
  }

  const run = await gh(`/actions/runs/${job.runId}`);
  job.runUrl = run.html_url;
  if (run.status !== 'completed') {
    if (['queued', 'waiting', 'pending', 'requested'].includes(run.status)) {
      job.state = 'queued';
      return;
    }
    job.state = 'running';
    const { jobs: ghJobs } = await gh(`/actions/runs/${job.runId}/jobs`);
    if (ghJobs[0]) job.stage = stageOf(ghJobs[0]);
    return;
  }

  job.state = 'finishing';
  await loadRelease(job, run.conclusion);
}

async function loadRelease(job, conclusion) {
  let rel = null;
  try {
    rel = await gh(`/releases/tags/dl-${job.id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  if (!rel) {
    if (conclusion === 'cancelled') { job.state = 'failed'; job.error = 'The download was cancelled.'; return; }
    if (Date.now() - job.created > 23 * 3600e3) { job.state = 'expired'; return; }
    job.missing = (job.missing || 0) + 1;
    if (conclusion === 'success' && job.missing < 4) return; // release may lag a few seconds
    job.state = 'failed';
    job.error = conclusion === 'success' ? 'The file wasn’t found on GitHub.' : 'The download failed on GitHub.';
    return;
  }

  let meta = {};
  try { meta = JSON.parse(rel.body || '{}'); } catch { /* old/foreign release */ }
  job.releaseId = rel.id;
  if (meta.url && !job.url) job.url = meta.url;
  if (meta.quality && !job.quality) job.quality = meta.quality;

  const asset = rel.assets?.[0];
  if (meta.ok === false || !asset) {
    job.state = 'failed';
    job.error = cleanError(meta.error) || 'The download failed.';
    if (meta.run) job.runUrl = meta.run;
    return;
  }
  job.state = 'ready';
  job.meta = meta;
  job.asset = { id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url, type: asset.content_type };
}

function cleanError(msg) {
  if (!msg) return '';
  msg = msg.replace(/^ERROR:\s*/gm, '').replace(/\[[^\]]+\]\s*[\w-]+:\s*/g, '').trim();
  if (/sign in to confirm|not a bot/i.test(msg)) {
    msg += '\n\nYouTube is blocking GitHub’s servers. Add your YouTube cookies as the YTDLP_COOKIES secret (see README).';
  } else if (/login|log in|cookies|private|members|age/i.test(msg)) {
    msg += '\n\nThis site needs you to be logged in. Add cookies as the YTDLP_COOKIES secret (see README).';
  } else if (/drm/i.test(msg)) {
    msg += '\n\nThis video is DRM-protected, so it can’t be downloaded.';
  }
  return msg;
}

let pollTimer = null;
let polling = false;
function schedulePoll(ms = POLL_MS) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}
async function poll() {
  if (polling || document.hidden || !configured()) return;
  const active = jobs.filter(j => ACTIVE.has(j.state) && j.state !== 'starting');
  if (!active.length) return;
  polling = true;
  try {
    await Promise.all(active.map(async job => {
      try { await updateJob(job); } catch (e) { console.warn(job.id, e); }
      if (job.state === 'ready' && job.id === currentId) toast('Ready to save');
      if (job.state === 'failed' && job.id === currentId) restoreLink(job);
    }));
    saveJobs();
    render();
  } finally {
    polling = false;
  }
  if (jobs.some(j => ACTIVE.has(j.state))) schedulePoll();
}

/* Pick up downloads started elsewhere (the Share Sheet shortcut, another device). */
async function syncRemote() {
  if (!configured()) return;
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    const res = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=30`);
    for (const run of res.workflow_runs) {
      const m = /^dl ([a-z0-9]{6,32})$/.exec(run.display_title);
      const created = Date.parse(run.created_at);
      if (!m || findJob(m[1]) || Date.now() - created > 24 * 3600e3) continue;
      jobs.push({ id: m[1], url: '', quality: '', created, runId: run.id, runUrl: run.html_url, state: 'queued', remote: true });
    }
    jobs.sort((a, b) => b.created - a.created);
    saveJobs();
    render();
    schedulePoll(100);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.classList.remove('spin');
  }
}

/* ───────── Getting the file onto the phone ───────── */
function fileNameFor(job) {
  const ext = job.meta?.ext || job.asset.name.split('.').pop();
  const base = (job.meta?.title || 'Download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'Download'}.${ext}`;
}
function mimeFor(job) {
  const ext = (job.meta?.ext || '').toLowerCase();
  return { mp4: 'video/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', jpg: 'image/jpeg', png: 'image/png' }[ext]
    || job.asset.type || 'application/octet-stream';
}

async function fetchFile(job) {
  if (transfers.has(job.id)) return;
  if (job.asset.size > 1.5e9 && !confirm(`This file is ${fmtSize(job.asset.size)}. Very large files can make Safari run out of memory. Continue? (Otherwise use “Open Link”.)`)) return;
  transfers.set(job.id, 0);
  render();
  try {
    // The Download workflow copies each file onto this site (files/<id>/),
    // which the app can read. GitHub's own release file host blocks
    // cross-site reads, so the API route below is only a fallback.
    let res = await fetch(`files/${job.id}/${encodeURIComponent(job.asset.name)}`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) {
      res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/assets/${job.asset.id}`, {
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/octet-stream' },
      });
    }
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    const total = job.asset.size || Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, lastPaint = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total && performance.now() - lastPaint > 200) {
        transfers.set(job.id, got / total);
        paintTransfer(job.id);
        lastPaint = performance.now();
      }
    }
    files.set(job.id, new File(chunks, fileNameFor(job), { type: mimeFor(job) }));
    toast('Tap Save to put it in Photos or Files');
  } catch (e) {
    console.warn(e);
    toast('Couldn’t pull the file into the app — try Open Link');
  } finally {
    transfers.delete(job.id);
    render();
  }
}

async function shareFile(job) {
  const file = files.get(job.id);
  if (!file) return;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      toast('Saved');
      removeFromGitHub(job, true);
    } catch (e) {
      if (e.name !== 'AbortError') downloadViaLink(file);
    }
  } else {
    downloadViaLink(file);
  }
}

function downloadViaLink(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

async function removeFromGitHub(job, quiet) {
  try {
    if (job.releaseId) await gh(`/releases/${job.releaseId}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
    await gh(`/git/refs/tags/dl-${job.id}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404 && e.status !== 422) throw e; });
    if (job.state === 'ready') job.state = files.has(job.id) ? 'saved' : 'removed';
    saveJobs();
    render();
    if (!quiet) toast('Removed from GitHub');
  } catch (e) {
    if (!quiet) toast(e.message);
  }
}

function deleteJob(job) {
  if (job.state === 'ready' || job.state === 'failed') removeFromGitHub(job, true);
  jobs = jobs.filter(j => j !== job);
  files.delete(job.id);
  if (currentId === job.id) currentId = null;
  saveJobs();
  closeSheet();
  render();
}

/* ───────── Rendering ───────── */
const ICON = {
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  check: '<svg class="status-icon" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg class="status-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.34-5.66M4 4v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M6 3h12M10 10.5v5l4.5-2.5z"/></svg>',
};

function statusText(job) {
  switch (job.state) {
    case 'starting': return 'Sending to GitHub…';
    case 'queued': return 'Waiting for a GitHub runner…';
    case 'running': {
      const s = job.stage;
      if (!s || s.now < 0) return s && s.done >= STAGES.length ? 'Finishing up…' : 'Starting…';
      return STAGES[s.now][1] + '…';
    }
    case 'finishing': return 'Finishing up…';
    case 'ready': return 'Ready';
    case 'saved': return 'Saved';
    case 'removed': return 'Removed from GitHub';
    case 'expired': return 'Expired';
    case 'failed': return 'Failed';
    default: return job.state;
  }
}

function subline(job) {
  const m = job.meta || {};
  const bits = [
    m.site || hostOf(job.url) || (job.remote ? 'From Shortcut' : ''),
    QUALITY_LABEL[job.quality] || '',
    m.height && job.quality !== 'audio' ? `${m.height}p` : '',
    fmtDuration(m.duration),
    fmtSize(job.asset?.size),
  ].filter(Boolean);
  return [...new Set(bits)].join(' · ');
}

function thumbHTML(job, cls) {
  const m = job.meta || {};
  const icon = job.quality === 'audio' ? ICON.music : ICON.film;
  const img = m.thumbnail ? `<img src="${esc(m.thumbnail)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : '';
  const pill = cls === 'job-thumb' && m.duration ? `<span class="pill">${fmtDuration(m.duration)}</span>` : '';
  return `<div class="${cls}" style="position:relative;overflow:hidden">${icon}${img}${pill}</div>`;
}

function cardHTML(job) {
  const m = job.meta || {};
  const title = m.title || (job.state === 'failed' ? 'Couldn’t download' : ACTIVE.has(job.state) ? 'Fetching video…' : hostOf(job.url) || 'Download');
  let status = '';
  let actions = '';

  if (ACTIVE.has(job.state)) {
    const s = job.stage || { done: 0, now: -1 };
    const steps = job.quality === 'audio' ? STAGES.filter(([n]) => n !== 'Convert for iPhone') : STAGES;
    const bar = job.state === 'running'
      ? `<div class="steps">${steps.map(([n]) => {
          const i = STAGES.findIndex(([x]) => x === n);
          return `<span class="${i < s.done ? 'done' : i === s.now ? 'now' : ''}"></span>`;
        }).join('')}</div>`
      : `<div class="progress indeterminate"><i></i></div>`;
    status = `<p class="job-status"><span class="spinner"></span>${statusText(job)}</p>${bar}`;
  } else if (job.state === 'ready' || job.state === 'saved') {
    status = `<p class="job-status ready">${ICON.check}${statusText(job)}</p>`;
    const kind = job.quality === 'audio' || m.ext === 'mp3' ? 'Audio' : 'Video';
    if (transfers.has(job.id)) {
      const p = transfers.get(job.id);
      actions += `<button class="primary-button" disabled>Getting file… <span data-pct="${job.id}">${Math.round(p * 100)}%</span></button>
        <div class="progress" style="margin:-16px 0 20px"><i data-bar="${job.id}" style="width:${p * 100}%"></i></div>`;
    } else if (files.has(job.id)) {
      actions += `<button class="primary-button green" data-action="share" data-id="${job.id}">${ICON.share}<span>Save ${kind}</span></button>`;
    } else if (job.state === 'ready') {
      actions += `<button class="primary-button" data-action="fetch" data-id="${job.id}">${ICON.save}<span>Save to iPhone</span></button>`;
    }
    if (job.state === 'ready') {
      actions += `<a class="secondary-button" href="${esc(job.asset.url)}" target="_blank" rel="noopener">${ICON.link}Open Link</a>
        <button class="secondary-button destructive" data-action="remove" data-id="${job.id}">${ICON.trash}Remove from GitHub</button>`;
    }
  }

  // Any finished video (saved or not) can become a Russian lesson.
  if (job.url && job.quality !== 'audio' && ['ready', 'saved', 'removed', 'expired'].includes(job.state)) {
    actions += job.lessonStarted
      ? `<button class="study-button done" data-action="open-study">✓ Lesson started, open Study</button>`
      : `<button class="study-button" data-action="study" data-id="${job.id}">📖 Use for Russian Study</button>`;
  }

  if (job.state === 'failed') {
    status = `<p class="job-status failed">${ICON.x}Failed</p>${job.error ? `<p class="job-error">${esc(job.error).replace(/\n/g, '<br>')}</p>` : ''}`;
    if (job.url) actions += `<button class="primary-button" data-action="retry" data-id="${job.id}">${ICON.retry}<span>Try Again</span></button>`;
    if (job.runUrl) actions += `<a class="secondary-button" href="${esc(job.runUrl)}" target="_blank" rel="noopener">${ICON.link}View Log on GitHub</a>`;
  } else if (!status) {
    status = `<p class="job-status" style="color:var(--secondary)">${statusText(job)}</p>`;
  }

  return `<div class="job-card">
    ${thumbHTML(job, 'job-thumb')}
    <div class="job-info">
      <p class="job-title">${esc(title)}</p>
      <p class="job-sub">${esc(subline(job) || job.url)}</p>
      ${status}
    </div>
    ${actions ? `<div class="job-actions">${actions}</div>` : ''}
  </div>`;
}

function paintTransfer(id) {
  const p = transfers.get(id) || 0;
  document.querySelectorAll(`[data-pct="${id}"]`).forEach(el => { el.textContent = `${Math.round(p * 100)}%`; });
  document.querySelectorAll(`[data-bar="${id}"]`).forEach(el => { el.style.width = `${p * 100}%`; });
}

function render() {
  const cur = findJob(currentId);
  $('#current').innerHTML = cur ? cardHTML(cur) : '';

  const lib = $('#library');
  lib.innerHTML = jobs.length
    ? jobs.map(job => {
        const dot = ACTIVE.has(job.state) ? 'running' : job.state === 'failed' ? 'failed' : job.state === 'ready' ? 'ready' : '';
        const title = job.meta?.title || hostOf(job.url) || 'Download';
        return `<button class="cell row" data-action="open" data-id="${job.id}">
          ${thumbHTML(job, 'row-thumb')}
          <div class="row-text">
            <div class="row-title">${esc(title)}</div>
            <div class="row-sub"><i class="dot ${dot}"></i>${esc(statusText(job))} · ${esc(QUALITY_LABEL[job.quality] || '')} · ${fmtAgo(job.created)}</div>
          </div>
          <svg class="chevron" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
        </button>`;
      }).join('')
    : `<div class="empty">${ICON.empty}<div>No downloads yet</div></div>`;

  const n = jobs.filter(j => ACTIVE.has(j.state)).length;
  $('#badge').hidden = !n;
  $('#badge').textContent = n;

  if (sheetJobId) {
    const job = findJob(sheetJobId);
    if (job) {
      $('#sheet-body').innerHTML = cardHTML(job) +
        `<button class="secondary-button destructive" data-action="delete" data-id="${job.id}">${ICON.trash}Delete from Library</button>`;
    }
  }
}

/* ───────── Navigation, sheet, controls ───────── */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  if (!['lesson', 'review', 'saved'].includes(name)) {
    document.body.classList.remove('in-page');
    store.set('tab', name);
  }
  if (name === 'library') syncRemote();
  if (name === 'study' && window.studyShow) window.studyShow();
}

function openSheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  $('#sheet').classList.add('open');
  $('#sheet-backdrop').classList.add('open');
}
function closeSheet() {
  sheetJobId = null;
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').classList.remove('open');
}

function setQuality(q) {
  quality = q;
  store.set('quality', q);
  const buttons = [...document.querySelectorAll('#quality button')];
  const i = buttons.findIndex(b => b.dataset.q === q);
  buttons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.q === q)));
  $('.seg-thumb').style.transform = `translateX(${i * 100}%)`;
  $('#quality-hint').textContent = QUALITY_HINTS[q];
  $('#go span').textContent = q === 'audio' ? 'Extract MP3' : 'Download';
}

function syncClear() { $('#clear-url').hidden = !$('#url').value; }

function shortcutHTML() {
  const o = esc(cfg.owner || 'OWNER'), r = esc(cfg.repo || 'REPO'), b = esc(cfg.branch || 'main');
  const endpoint = `https://api.github.com/repos/${o}/${r}/actions/workflows/${WORKFLOW}/dispatches`;
  return `
  <p style="font-size:15px;margin:0 0 14px">Make a Shortcut once, then tap <b>Share → Grab</b> in any app. It starts the download on GitHub in the background; open Grab (Library tab) to save the file when it’s ready.</p>
  <ol>
    <li>Open the <b>Shortcuts</b> app, tap <b>+</b>, and name it <b>Grab</b>.</li>
    <li>Tap the <b>ⓘ</b> button and turn on <b>Show in Share Sheet</b>. Set it to receive <b>URLs</b>, <b>Safari web pages</b> and <b>Text</b>.</li>
    <li>Add a <b>Random Number</b> action: minimum <code>100000000</code>, maximum <code>999999999</code>.</li>
    <li>Add <b>Get Contents of URL</b> with this URL:<br><code>${endpoint}</code></li>
    <li>Expand it and set <b>Method</b> to <code>POST</code>. Add two <b>Headers</b>:<br>
      <code>Authorization</code> → <code>Bearer</code> + a space + your token<br>
      <code>Accept</code> → <code>application/vnd.github+json</code></li>
    <li>Set <b>Request Body</b> to <b>JSON</b> and add:<br>
      <code>ref</code> (Text) → <code>${b}</code><br>
      <code>inputs</code> (Dictionary) containing:<br>
      &nbsp;&nbsp;<code>url</code> (Text) → <i>Shortcut Input</i><br>
      &nbsp;&nbsp;<code>quality</code> (Text) → <code>best</code>, <code>1080</code>, <code>720</code> or <code>audio</code><br>
      &nbsp;&nbsp;<code>job_id</code> (Text) → <i>Random Number</i></li>
    <li>Optional: add <b>Show Notification</b> “Downloading — open Grab to save it”.</li>
  </ol>
  <p style="font-size:13px;color:var(--secondary)">Tip: to be asked for the quality each time, add a <b>Choose from List</b> action with <code>best</code>, <code>1080</code>, <code>720</code>, <code>audio</code> before step 4 and use its result for <code>quality</code>.</p>
  <button class="secondary-button" data-action="copy-token">Copy Token</button>
  <button class="secondary-button" data-action="copy-endpoint">Copy URL</button>`;
}

async function saveSettings() {
  cfg.owner = $('#s-owner').value.trim();
  cfg.repo = $('#s-repo').value.trim();
  cfg.token = $('#s-token').value.trim();
  cfg.branch = '';
  store.set('cfg', cfg);
  const status = $('#s-status');
  if (!configured()) { status.textContent = 'Fill in all three fields.'; return; }
  status.textContent = 'Checking…';
  try {
    const repo = await gh('');
    cfg.branch = repo.default_branch;
    store.set('cfg', cfg);
    await gh(`/actions/workflows/${WORKFLOW}`);
    status.innerHTML = `<span style="color:var(--green)">✓ Connected to ${esc(repo.full_name)}${repo.private ? ' (private)' : ''} · branch ${esc(cfg.branch)}</span>`;
    toast('Connected');
    syncRemote();
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">${esc(
      e.status === 401 ? 'The token was rejected. Check it or make a new one.'
      : e.status === 404 ? 'Repo or Download workflow not found (or the token can’t see it). Make sure the workflow is on the default branch.'
      : e.message)}</span>`;
  }
}

/* ───────── Wiring ───────── */
document.addEventListener('click', async e => {
  const tab = e.target.closest('.tab');
  if (tab) { showScreen(tab.dataset.screen); return; }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const job = findJob(el.dataset.id);
  switch (el.dataset.action) {
    case 'fetch': fetchFile(job); break;
    case 'share': shareFile(job); break;
    case 'remove': removeFromGitHub(job); break;
    case 'retry': closeSheet(); showScreen('download'); startJob(job.url, job.quality); break;
    case 'study':
      job.lessonStarted = true;
      saveJobs();
      render();
      closeSheet();
      showScreen('study');
      window.stStart?.(job.url);
      break;
    case 'open-study': closeSheet(); showScreen('study'); break;
    case 'delete': deleteJob(job); break;
    case 'open': sheetJobId = job.id; openSheet('Details', ''); render(); break;
    case 'copy-token': await navigator.clipboard.writeText(cfg.token); toast('Token copied'); break;
    case 'copy-endpoint':
      await navigator.clipboard.writeText(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${WORKFLOW}/dispatches`);
      toast('URL copied');
      break;
  }
});

$('#quality').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setQuality(b.dataset.q);
});

$('#go').addEventListener('click', () => {
  const url = $('#url').value;
  if (!url.trim()) { $('#url').focus(); return; }
  $('#url').blur();
  startJob(url, quality);
});
$('#url').addEventListener('keydown', e => { if (e.key === 'Enter') $('#go').click(); });
$('#url').addEventListener('input', syncClear);
$('#clear-url').addEventListener('click', () => { $('#url').value = ''; syncClear(); $('#url').focus(); });
$('#paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('#url').value = (text.match(/https?:\/\/\S+/i) || [text])[0].trim();
    syncClear();
  } catch {
    $('#url').focus();
    toast('Long-press the field and tap Paste');
  }
});
$('#refresh').addEventListener('click', syncRemote);

$('#s-owner').value = cfg.owner;
$('#s-repo').value = cfg.repo;
$('#s-token').value = cfg.token;
$('#s-save').addEventListener('click', saveSettings);
$('#s-show').addEventListener('click', () => {
  const input = $('#s-token');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#s-show').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#s-copy').addEventListener('click', async () => {
  const token = $('#s-token').value.trim();
  if (!token) { toast('No token saved in this copy of the app'); return; }
  try { await navigator.clipboard.writeText(token); toast('Token copied'); } catch { toast('Tap Show, then copy it manually'); }
});
$('#s-shortcut').addEventListener('click', () => openSheet('Share Sheet Shortcut', shortcutHTML()));
$('#s-signout').addEventListener('click', () => {
  if (!confirm('Remove your token and download history from this device?')) return;
  cfg.token = '';
  $('#s-token').value = '';
  jobs = [];
  currentId = null;
  store.set('cfg', cfg);
  saveJobs();
  render();
  toast('Signed out');
});

$('#sheet-done').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);

// Collapse the large title into the navigation bar on scroll, like UIKit.
document.querySelectorAll('.screen').forEach(screen => {
  screen.addEventListener('scroll', () => screen.classList.toggle('scrolled', screen.scrollTop > 36), { passive: true });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { schedulePoll(100); }
});

// Deep link: …/?url=<link>&q=best|1080|720|audio&go=1
(function handleLaunchParams() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url') || p.get('text');
  const q = p.get('q');
  if (q && QUALITY_LABEL[q]) setQuality(q);
  if (url) {
    $('#url').value = (url.match(/https?:\/\/\S+/i) || [url])[0];
    syncClear();
    history.replaceState(null, '', location.pathname);
    if (p.get('go') === '1') startJob($('#url').value, quality);
  }
})();

setQuality(quality);
if (findJob(currentId)?.state === 'failed') restoreLink(findJob(currentId));
showScreen(configured() ? (['library', 'study'].includes(store.get('tab')) ? store.get('tab') : 'download') : 'settings');
render();
schedulePoll(300);
if (configured() && !$('#screen-library').classList.contains('active')) syncRemote();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
