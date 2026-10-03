'use strict';

/* Core of the web app: small helpers, sign-in (Supabase email code) and a
 * tiny Supabase client (REST, no library). study.js builds on these. */

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem('app.' + key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('app.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  del(key) { try { localStorage.removeItem('app.' + key); } catch { /* ignore */ } },
};

function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function openSheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  $('#sheet').classList.add('open');
  $('#sheet-backdrop').classList.add('open');
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').classList.remove('open');
}
$('#sheet-done').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);

const PAGES = ['lesson', 'review', 'saved', 'anki', 'phrases', 'channel', 'help'];
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  const signedIn = !!session;
  document.body.classList.toggle('signed-out', !signedIn);
  if (!PAGES.includes(name)) {
    document.body.classList.remove('in-page');
    if (name !== 'signin') store.set('tab', name);
  }
  if (name === 'study' && window.studyShow) window.studyShow();
  if (name === 'explore' && window.exploreShow) window.exploreShow();
  if (name === 'practice' && window.practiceShow) window.practiceShow();
  if (name === 'account') renderAccount();
  setTimeout(() => window.guide?.showTip(name), 400);   // first visit: a tip card (guide.js)
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showScreen(t.dataset.screen)));

/* ───────── Settings from the server (/api/config) ───────── */
let config = store.get('config', null);
async function loadConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-cache' });
    if (r.ok) { config = await r.json(); store.set('config', config); }
  } catch { /* offline: use the saved copy */ }
  if (!config?.supabaseUrl) throw new Error('The app isn’t set up yet (no Supabase settings).');
  document.querySelectorAll('.app-name').forEach(el => { el.textContent = config.appName; });
  document.title = config.appName;
  return config;
}

/* ───────── Sign-in: 6-digit code by email (works inside the Home Screen app) ───────── */
let session = store.get('session', null);   // { access_token, refresh_token, expires_at, user }

async function auth(path, body) {
  const r = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.msg || data.error_description || data.message || `Sign-in error ${r.status}`);
  return data;
}

function saveSession(s) {
  session = s && { access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user };
  if (session) store.set('session', session); else store.del('session');
}

let refreshing = null;
async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ||= auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .then(saveSession)
    .catch(e => { if (!navigator.onLine) throw e; saveSession(null); showScreen('signin'); throw new Error('Please sign in again.'); })
    .finally(() => { refreshing = null; });
  await refreshing;
  return session?.access_token;
}

async function sendCode(email) {
  // redirect_to: where the email's sign-in link brings you back (until custom
  // email is set up, Supabase's default email has a link instead of a code).
  await auth(`otp?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { email, create_user: true });
}

// Coming back from the email's sign-in link: the session is in the address (#access_token=…).
async function signInFromLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('access_token') && !h.get('error_description')) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (h.get('error_description')) { toast(h.get('error_description').replace(/\+/g, ' ')); return; }
  const r = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${h.get('access_token')}` },
  });
  if (!r.ok) { toast('That sign-in link didn’t work. Try again.'); return; }
  saveSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'),
    expires_in: Number(h.get('expires_in')) || 3600, user: await r.json() });
}
async function verifyCode(email, token) {
  saveSession(await auth('verify', { type: 'email', email, token }));
}
function signOut() {
  const t = session?.access_token;
  if (t) fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${t}` } }).catch(() => {});
  saveSession(null);
  ['cards', 'lessons', 'studyPrefs'].forEach(k => store.del(k));
  location.reload();
}

/* ───────── Data: Supabase REST as the signed-in user ───────── */
async function db(path, { method = 'GET', body, prefer } = {}) {
  const token = await accessToken();
  const r = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    method,
    cache: 'no-store',
    headers: {
      apikey: config.supabaseAnonKey,
      ...(token || config.supabaseAnonKey.startsWith('eyJ') ? { Authorization: `Bearer ${token || config.supabaseAnonKey}` } : {}),
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Couldn’t reach the server (${r.status})`), { status: r.status, detail: text });
  return text ? JSON.parse(text) : null;
}

// Our own server functions (web/api/*).
async function api(path, body) {
  const token = await accessToken();
  const r = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Server error ${r.status}`), { status: r.status, code: data.code });
  return data;
}

// Public lesson files: lesson.json and voice clips.
const fileUrl = (videoId, path) => `${config.supabaseUrl}/storage/v1/object/public/lessons/${videoId}/${path}`;

/* ───────── Sign-in screen ───────── */
let signinEmail = '';
$('#si-send').addEventListener('click', async () => {
  const email = $('#si-email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Type your email address'); return; }
  $('#si-send').disabled = true;
  try {
    await sendCode(email);
    signinEmail = email;
    $('#si-step1').hidden = true;
    $('#si-step2').hidden = false;
    $('#si-sent-to').textContent = email;
    $('#si-code').focus();
  } catch (e) {
    toast(e.message);
  } finally {
    $('#si-send').disabled = false;
  }
});
$('#si-verify').addEventListener('click', async () => {
  const code = $('#si-code').value.replace(/\D/g, '');
  if (code.length < 6) { toast('Type the 6-digit code from the email'); return; }
  $('#si-verify').disabled = true;
  try {
    await verifyCode(signinEmail, code);
    startApp();
  } catch (e) {
    toast(/expired|invalid/i.test(e.message) ? 'That code is wrong or expired. Check the newest email.' : e.message);
  } finally {
    $('#si-verify').disabled = false;
  }
});
// Enter (or the keyboard's Send/Go key) does the same as the buttons.
$('#si-email').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#si-send').click(); } });
$('#si-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#si-verify').click(); } });
$('#si-back').addEventListener('click', () => { $('#si-step1').hidden = false; $('#si-step2').hidden = true; });

/* ───────── Account ───────── */
let profile = null;
async function renderAccount() {
  if (!session) return;
  $('#ac-email').textContent = session.user?.email || '';
  try { [profile] = await db(`profiles?id=eq.${session.user.id}&select=plan`); } catch { /* offline */ }
  const admin = store.get('meAdmin', false);
  const pro = admin || profile?.plan === 'pro';
  $('#ac-plan').textContent = admin ? 'Admin (everything unlocked)' : pro ? 'Pro' : 'Free';
  $('#ac-admin-help').hidden = !store.get('meAdmin', false);   // admin testing tools
  $('#ac-plan-note').textContent = pro
    ? 'Every lesson in full, new lessons and unlimited phrases. Thank you for supporting the app!'
    : `The first ${config.freeSentences || 5} sentences of every lesson and ${config.freePhrasesPerWeek || 3} phrases a week. Pro unlocks everything.`;
}
$('#ac-signout').addEventListener('click', () => { if (confirm('Sign out on this device?')) signOut(); });

/* ───────── Start ───────── */
async function startApp() {
  if (!session) { showScreen('signin'); return; }
  document.body.classList.remove('signed-out');
  const tab = store.get('tab', 'study');
  showScreen(['study', 'practice', 'explore', 'account'].includes(tab) ? tab : 'study');
  window.stRestorePages?.();   // reopen the page you were on, whichever tab it came from
  window.guide?.auto();        // first sign-in: the welcome tour
}

window.addEventListener('hashchange', () => { if (config) signInFromLink().then(startApp); });
loadConfig()
  .then(signInFromLink)
  .then(startApp)
  .catch(e => { $('#si-step1').innerHTML = `<p class="section-footer">${esc(e.message)}</p>`; showScreen('signin'); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
