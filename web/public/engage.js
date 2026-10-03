'use strict';

/* Daily goal, streak, XP and progress: the habit loop that brings people back.
 *   - XP: +1 for each new sentence heard, +3 for saving a word or sentence,
 *     +2 per review card, +20 for finishing a lesson (90% of it heard).
 *   - Daily goal (10 / 30 / 50 XP); meeting it keeps the 🔥 streak going.
 *   - Posters show how much of each lesson you've heard.
 * Stored per user in Supabase (user_stats) and locally. Uses core.js helpers. */

const engage = (() => {
  const today = () => new Date().toLocaleDateString('en-CA');          // YYYY-MM-DD, local time
  const dayBefore = d => { const t = new Date(`${d}T12:00:00`); t.setDate(t.getDate() - 1); return t.toLocaleDateString('en-CA'); };
  let stats = Object.assign({ goal: 30, days: {}, total: 0, heard: {}, done: {}, best: 0, updated: 0, hidden: {}, guide: {} }, store.get('stats', {}));
  stats.hidden ||= {};
  stats.guide ||= {};
  const heardSets = {};   // lessonId → Set of sentence indices (built lazily)

  const todayXp = () => stats.days[today()] || 0;
  function streak() {
    let d = today(), n = 0;
    if ((stats.days[d] || 0) < stats.goal) d = dayBefore(d);     // today still to do: count from yesterday
    while ((stats.days[d] || 0) >= stats.goal) { n++; d = dayBefore(d); }
    return n;
  }

  function save() {
    stats.updated = Date.now();
    stats.best = Math.max(stats.best || 0, streak());
    store.set('stats', stats);
    clearTimeout(save.t);
    save.t = setTimeout(push, 4000);
  }

  function xp(n) {
    const before = todayXp();
    stats.days[today()] = before + n;
    stats.total = (stats.total || 0) + n;
    save();
    render();
    if (before < stats.goal && before + n >= stats.goal) setTimeout(() => celebrate('goal'), 400);
  }

  function heard(lessonId, i, count) {
    const set = heardSets[lessonId] ||= new Set(stats.heard[lessonId] || []);
    if (set.has(i)) return;
    set.add(i);
    stats.heard[lessonId] = [...set];
    xp(1);
    if (count && !stats.done[lessonId] && set.size >= Math.ceil(count * 0.9)) {
      stats.done[lessonId] = today();
      xp(20);
      setTimeout(() => celebrate('lesson'), 600);
    }
  }

  const progress = id => {
    const l = (typeof lessons !== 'undefined' ? lessons : []).find(x => x.id === id);
    const n = (stats.heard[id] || []).length, total = l?.meta?.count || 0;
    return total ? Math.min(1, n / total) : 0;
  };
  const progressBar = id => {
    const p = progress(id);
    return p > 0 ? `<span class="poster-progress"><i style="width:${Math.max(4, Math.round(p * 100))}%"></i></span>` : '';
  };

  /* ───────── Top of the Learn tab: 🔥 streak + today's goal ring ───────── */
  function render() {
    const el = $('#st-streak');
    if (!el) return;
    const x = todayXp(), g = stats.goal, s = streak();
    const pct = Math.min(1, x / g), C = 2 * Math.PI * 15;
    const html = `
      <button class="streak${x >= g ? ' lit' : ''}" data-e="stats">
        <span class="flame">🔥</span><b>${s}</b><span class="streak-l">day${s === 1 ? '' : 's'}</span>
      </button>
      <button class="goal" data-e="stats" aria-label="Today's goal">
        <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="goal-bg"/>
          <circle cx="18" cy="18" r="15" class="goal-fg" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - pct)}"/></svg>
        <span><b>${Math.min(x, g)}</b>/${g}</span>
      </button>`;
    if (el._html !== html) { el._html = html; el.innerHTML = html; }   // unchanged: leave it (no blink)
  }

  function statsSheet() {
    const days = [];
    for (let d = today(), k = 0; k < 7; k++, d = dayBefore(d)) days.unshift(d);
    const max = Math.max(stats.goal, ...days.map(d => stats.days[d] || 0));
    const words = Object.values(cards).filter(c => !c.deleted && c.kind === 'word' && cardState(c) === 'review').length;
    const sentences = Object.values(stats.heard).reduce((a, b) => a + b.length, 0);
    openSheet('Your progress', `
      <div class="stat-row">
        <div><b>🔥 ${streak()}</b><span>day streak</span></div>
        <div><b>${words}</b><span>words learned</span></div>
        <div><b>${sentences}</b><span>sentences heard</span></div>
      </div>
      <div class="week">${days.map(d => {
        const v = stats.days[d] || 0;
        return `<div class="wk${v >= stats.goal ? ' met' : ''}"><i style="height:${Math.round((v / max) * 100)}%"></i><span>${new Date(`${d}T12:00:00`).toLocaleDateString('en', { weekday: 'narrow' })}</span></div>`;
      }).join('')}</div>
      <p class="sheet-label">Daily goal</p>
      <div class="goal-pick">${[[10, 'Casual'], [30, 'Regular'], [50, 'Serious']].map(([v, n]) =>
        `<button data-e="goal" data-v="${v}" class="${stats.goal === v ? 'on' : ''}"><b>${n}</b><span>${v} XP a day</span></button>`).join('')}</div>
      <p class="section-footer">Earn XP by listening to new sentences (+1), saving words and sentences (+3), reviewing cards (+2) and finishing lessons (+20). Best streak: ${stats.best || streak()} day${(stats.best || streak()) === 1 ? '' : 's'}.</p>`);
  }

  /* ───────── Celebrations ───────── */
  function celebrate(kind) {
    confetti();
    const s = streak();
    const [big, small] = kind === 'lesson'
      ? ['Lesson complete! 🎬', '+20 XP. On to the next one?']
      : [`Daily goal reached!`, `🔥 ${s} day streak${s >= (stats.best || 0) && s > 1 ? ' · your best yet' : ''}`];
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.innerHTML = `<div class="cel-card"><b>${big}</b><span>${small}</span></div>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 2600);
    navigator.vibrate?.(30);
  }
  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = ['#ffb020', '#ff6b3d', '#ffe08a', '#ffffff', '#ff9f0a'];
    for (let k = 0; k < 70; k++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[k % colors.length];
      p.style.animationDelay = `${Math.random() * 0.4}s`;
      p.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
      p.style.setProperty('--x', `${(Math.random() - 0.5) * 160}px`);
      p.style.setProperty('--r', `${Math.random() * 720}deg`);
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3400);
  }

  /* ───────── Sync (table user_stats) ───────── */
  function merge(remote) {
    if (!remote) return;
    for (const [d, v] of Object.entries(remote.days || {})) stats.days[d] = Math.max(stats.days[d] || 0, v);
    for (const [id, arr] of Object.entries(remote.heard || {})) {
      stats.heard[id] = [...new Set([...(stats.heard[id] || []), ...arr])];
      delete heardSets[id];
    }
    Object.assign(stats.done, remote.done || {});
    for (const [k, v] of Object.entries(remote.hidden || {})) {      // newest choice wins
      if (!stats.hidden[k] || v.t > stats.hidden[k].t) stats.hidden[k] = v;
    }
    for (const [k, v] of Object.entries(remote.guide || {})) {       // tour / tips seen (newest wins)
      if (!stats.guide[k] || v.t > stats.guide[k].t) stats.guide[k] = v;
    }
    stats.total = Math.max(stats.total || 0, remote.total || 0);
    stats.best = Math.max(stats.best || 0, remote.best || 0);
    if ((remote.updated || 0) > (stats.updated || 0) && remote.goal) stats.goal = remote.goal;
  }
  let pulledAt = 0, pulling = null;
  async function pull(force = false) {
    if (pulling) return pulling;
    if (!session || !config || (!force && Date.now() - pulledAt < 60e3)) return;
    pulledAt = Date.now();
    pulling = pullNow().finally(() => { pulling = null; });
    return pulling;
  }
  async function pullNow() {
    try {
      const [row] = await db('user_stats?select=data');
      merge(row?.data);
      store.set('stats', stats);
      render();
      push();
    } catch (e) { console.warn('stats pull', e); }
  }
  async function push() {
    if (!session) return;
    try {
      await db('user_stats?on_conflict=user_id', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
        body: { user_id: session.user.id, data: stats, updated_at: new Date().toISOString() } });
    } catch (e) { console.warn('stats push', e); }
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-e]');
    if (!el) return;
    if (el.dataset.e === 'stats') statsSheet();
    if (el.dataset.e === 'goal') { stats.goal = Number(el.dataset.v); save(); render(); statsSheet(); }
  });

  /* Versions of a "Say it like a native" phrase (or deck items) the learner removed.
     Key "<phrase id>:<i>" → { h: removed?, t: when }, so the latest choice syncs. */
  const isHidden = (pid, i) => !!stats.hidden[`${pid}:${i}`]?.h;
  function setHidden(pid, i, h) { stats.hidden[`${pid}:${i}`] = { h, t: Date.now() }; save(); }

  /* Welcome tour and per-screen tips (guide.js): key → { s: seen?, t: when }. */
  const guideSeen = k => !!stats.guide[k]?.s;
  function guideMark(k) { stats.guide[k] = { s: true, t: Date.now() }; save(); }
  function guideReset() {
    for (const k of Object.keys(stats.guide)) if (k.startsWith('tip:')) stats.guide[k] = { s: false, t: Date.now() };
    save();
  }

  // Admin testing: forget the tour and every tip, as for a brand-new user.
  function guideResetAll() {
    for (const k of Object.keys(stats.guide)) stats.guide[k] = { s: false, t: Date.now() };
    save();
  }

  return { xp, heard, render, progressBar, pull, streak, isHidden, setHidden, guideSeen, guideMark, guideReset, guideResetAll };
})();
window.engage = engage;
engage.render();
