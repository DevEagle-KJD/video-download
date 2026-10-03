'use strict';

/* Help for people who have never used an app like this:
 *   1. Welcome tour: shown once after the first sign-in (replay: Account).
 *   2. A tip card the first time each screen is opened (✕ hides it for good).
 *   3. "How to use Nativnik": a step-by-step page (Account, or ? on any screen).
 * What's been seen is stored with the user's stats (engage.js), so it follows
 * them to other devices. Uses core.js / study.js helpers: $, esc, showScreen,
 * stOpenPage, closeSheet. */

const guide = (() => {
  const seen = k => window.engage?.guideSeen(k);
  const mark = k => window.engage?.guideMark(k);
  let touring = false;

  /* Little pictures of the real buttons, used in the tour and the help page. */
  const pic = {
    play: '<span class="gp gp-play"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>',
    bigplay: '<span class="gp gp-bigplay"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg></span>',
    star: '<span class="gp gp-star">☆</span>',
    starOn: '<span class="gp gp-star on">★</span>',
    word: w => `<span class="gp-word">${w}</span>`,
    chip: t => `<span class="gp-chip">${t}</span>`,
    chipOn: t => `<span class="gp-chip on">${t}</span>`,
    x: '<span class="gp gp-x">✕</span>',
  };

  /* ───────── 1. Welcome tour ───────── */
  const STEPS = [
    { title: 'Welcome to Nativnik 👋', text: 'Learn Russian from real videos of real people. This quick tour shows you around (about 1 minute).<br><br>You can watch it again any time from <b>Account</b>.' },
    { screen: 'explore', target: () => (!$('#ex-channels-box').hidden ? '#ex-channels-box' : '.tab[data-screen="explore"]'), title: 'Step 1 · Find a video',
      text: 'Start in <b>Explore</b>. Tap a channel (like <b>Easy Russian</b>) to see all its videos, or tap a lesson under <b>Ready to study</b> to open it.' },
    { screen: 'study', target: '.tab[data-screen="study"]', title: 'Step 2 · Your lessons',
      text: 'Lessons you add show up here in <b>Learn</b>. Tap one to study it. Your daily goal 🔥 is at the top.' },
    { title: 'Step 3 · Listen one sentence at a time', demo: () => demoSentence(),
      text: `In a lesson, tap the orange ${pic.play} next to a sentence. The video jumps there and plays it. With <b>Pause each</b> on (it is when a lesson opens), it <b>stops after that sentence</b>, so you can repeat it.` },
    { title: 'Step 4 · Tap any word', demo: () => demoSentence('word'),
      text: `Every word with a ${pic.word('dotted orange line')} can be tapped: hear it (slowly too), see what it means, and save it.` },
    { title: 'Step 5 · Save what you want to remember', demo: () => demoSentence('star'),
      text: `Tap ${pic.star} next to a sentence to save it as a flashcard. It turns into ${pic.starOn}.` },
    { screen: 'practice', target: '#mc-review', title: 'Step 6 · Practice',
      text: 'Everything you save comes back here in <b>Review</b>, right before you’d forget it. A few minutes a day is enough.' },
    { screen: 'practice', target: '#screen-practice [data-s="open-phrases"]', title: 'Step 7 · Say it like a native',
      text: 'Type anything in English, like “Can I get the check?”, and see how Russians really say it: to friends, to strangers, to a man or a woman.' },
    { screen: 'account', target: '#ac-help', title: 'Step 8 · Help is always here',
      text: 'Tap <b>How to use Nativnik</b> for step-by-step help with every button. Or tap the <b>?</b> at the top of any screen.' },
    { title: 'You’re ready! 🎉', text: 'Go to <b>Explore</b>, pick a video, and tap the orange ▶ on the first sentence.<br><br>Удачи! (Good luck!)', last: true },
  ];

  // A real, tappable example: ▶ plays the sentence, a word plays that word, ☆ fills in.
  function demoSentence(focus) {
    let k = 0;
    const w = (t, g) => `<span class="tok" data-t="demo-word" data-k="${++k}"><b>${t}</b><i>${g}</i></span>`;
    const tryIt = { word: '👆 Try it: tap any word', star: '👆 Try it: tap the ☆' }[focus] || '👆 Try it: tap the orange ▶';
    return `<div class="tour-demo${focus ? ` focus-${focus}` : ''}"><span class="tour-try">${tryIt}</span>
      <div class="sent demo-sent">
        <div class="sent-main"><div class="il">${w('Приве́т,', 'hi')}${w('как', 'how')}${w('дела́?', 'things')}</div>
          <p class="en">Hi, how are you?</p></div>
        <div class="sent-side"><span class="replay" data-t="demo-play"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg></span>
          <span class="star" data-t="demo-star"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg></span></div>
      </div></div>`;
  }

  // Natural-voice recordings of the example (audio/tour-*.mp3).
  const demoAudio = new Audio();
  function demoSay(name, hl) {
    demoAudio.pause();
    demoAudio.src = `audio/tour-${name}.mp3?v=2`;
    demoAudio.play().catch(() => {});
    el?.querySelectorAll('.tour-demo .now, .tour-demo .hl').forEach(x => x.classList.remove('now', 'hl'));
    hl?.classList.add(hl.classList.contains('sent') ? 'now' : 'hl');
    demoAudio.onended = () => hl?.classList.remove('now', 'hl');
  }

  let step = 0, el = null;
  function start() {
    if (touring) return;
    touring = true;
    closeSheet?.();
    if (document.body.classList.contains('in-page')) { document.body.classList.remove('in-page'); }
    el = document.createElement('div');
    el.className = 'tour';
    el.innerHTML = '<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-live="polite"></div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'next') go(step + 1);
      if (b.dataset.t === 'back') go(step - 1);
      if (b.dataset.t === 'skip') finish();
      if (b.dataset.t === 'explore') { finish(); showScreen('explore'); }
      if (b.dataset.t === 'demo-play') demoSay('sent', b.closest('.sent'));
      if (b.dataset.t === 'demo-word') demoSay(`w${b.dataset.k}`, b);
      if (b.dataset.t === 'demo-star') { const on = b.classList.toggle('on'); b.closest('.sent').classList.toggle('starred', on); }
    });
    go(0);
  }
  function go(n) {
    if (n >= STEPS.length) { finish(); return; }
    step = Math.max(0, n);
    const s = STEPS[step];
    const switching = s.screen && !$(`#screen-${s.screen}`).classList.contains('active');
    if (switching) showScreen(s.screen);
    const card = el.querySelector('.tour-card'), hole = el.querySelector('.tour-hole');
    card.innerHTML = `
      <div class="tour-count">${step === 0 || s.last ? '' : `${step} of ${STEPS.length - 2}`}</div>
      <b class="tour-title">${s.title}</b>
      ${s.demo ? s.demo() : ''}
      <p class="tour-text">${s.text}</p>
      <div class="tour-btns">
        ${s.last ? '<button class="tour-skip" data-t="next">Close</button><button class="tour-next" data-t="explore">Go to Explore</button>'
          : `<button class="tour-skip" data-t="${step ? 'back' : 'skip'}">${step ? 'Back' : 'Skip tour'}</button>
             <button class="tour-next" data-t="next">${step ? 'Next' : 'Show me around'}</button>`}
      </div>
      ${step && !s.last ? '<button class="tour-x" data-t="skip" aria-label="Close the tour">Skip</button>' : ''}`;
    // A screen that was just opened may still be loading (e.g. Explore's channels): wait a moment.
    hole.style.display = 'none';
    setTimeout(() => requestAnimationFrame(() => {
      if (!el || STEPS[step] !== s) return;
      const sel = typeof s.target === 'function' ? s.target() : s.target;
      const target = sel && document.querySelector(sel);
      if (target) {
        target.scrollIntoView?.({ block: 'center' });
        const r = target.getBoundingClientRect(), pad = 6;
        Object.assign(hole.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
        // Card on the side of the screen away from the highlighted thing.
        card.classList.toggle('top', r.top > innerHeight / 2);
        card.classList.toggle('bottom', r.top <= innerHeight / 2);
        el.classList.remove('dim');
      } else {
        hole.style.display = 'none';
        card.classList.remove('top', 'bottom');
        el.classList.add('dim');
      }
    }), switching ? 600 : 0);
  }
  function finish() {
    mark('tour');
    touring = false;
    el?.remove();
    el = null;
    showTip(currentScreen());
  }

  /* ───────── 2. One tip per screen, the first time ───────── */
  const TIPS = {
    study: ['📚 Learn', 'Your lessons live here. Tap a lesson to study it. New here? Go to <b>Explore</b> to pick your first video.', 'start'],
    explore: ['🧭 Explore', 'Tap a <b>channel</b> to see all its videos, or a lesson under <b>Ready to study</b> to open it right away.', 'find'],
    practice: ['🔁 Practice', '<b>Review</b> quizzes you on what you saved. <b>Say it like a native</b> turns English into natural Russian. <b>Saved</b> lists everything you kept.', 'review'],
    lesson: ['🎧 How this page works', `Tap the orange ${pic.play} to hear one sentence (it stops after it). Tap an underlined word for its meaning. ${pic.star} saves the sentence.`, 'lesson'],
    saved: ['⭐ Saved', 'Everything you saved. Switch between <b>Words</b> and <b>Sentences</b> at the top. Tap one to hear it, review it, or open it in its lesson.', 'saved'],
    phrases: ['💬 Say it like a native', 'Type what you want to say, in English or Russian, and tap <b>Show Me</b>. In a minute or two you’ll get the natural ways Russians say it.', 'phrases'],
    channel: ['📺 Channel', 'All of this channel’s videos. Tap one to study it. ✓ means it’s already in your lessons.', 'find'],
    review: ['🔁 Review', 'Try to remember, then tap <b>Show</b>. Be honest: <b>Again</b> if you forgot, <b>Good</b> if you got it. The app decides when you see it next.', 'review'],
  };
  const currentScreen = () => document.querySelector('.screen.active')?.id.replace('screen-', '');
  function showTip(name) {
    if (touring || !name || !TIPS[name] || seen(`tip:${name}`)) return;
    if (!seen('tour')) return;                          // the tour comes first
    const scr = $(`#screen-${name}`);
    if (!scr || scr.querySelector('.tip-card')) return;
    const [title, text, sec] = TIPS[name];
    const card = document.createElement('div');
    card.className = 'tip-card';
    card.innerHTML = `<button class="tip-x" data-tip="close" aria-label="Got it">✕</button>
      <b>${title}</b><p>${text}</p>
      <div class="tip-btns"><button data-tip="close" class="tip-ok">Got it</button><button data-s="help" data-sec="${sec}" class="tip-more">More help</button></div>`;
    card.addEventListener('click', e => {
      if (e.target.closest('[data-tip="close"]') || e.target.closest('[data-s="help"]')) { mark(`tip:${name}`); card.remove(); }
    });
    mark(`tip:${name}`);   // shown once per person (it stays until you leave or close it)
    const where = name === 'lesson' ? $('#ls-transcript') : scr.querySelector('.content, .review-body');
    if (name === 'lesson') where?.before(card);
    else if (where) {
      const title = where.querySelector('.large-title, .learn-top');
      if (title) title.after(card); else where.prepend(card);
    }
  }

  /* ───────── 3. "How to use Nativnik" ───────── */
  const HELP = [
    ['start', '🚀 Getting started', `
      <ol>
        <li><b>Sign in:</b> type your email and tap the button. We email you a <b>6-digit code</b>. Type it in. No password needed. (No email? Check your spam folder and wait a minute.)</li>
        <li><b>Put Nativnik on your Home Screen</b> so it opens like an app:
          <ul><li><b>iPhone:</b> in Safari, tap the <b>Share</b> button (square with an arrow ↑), scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li><b>Android:</b> in Chrome, tap <b>⋮</b> (top right), then <b>Add to Home screen</b>.</li></ul></li>
        <li><b>The four buttons at the bottom:</b>
          <ul><li><b>Learn</b>: your lessons and your daily goal.</li>
          <li><b>Practice</b>: review flashcards, “Say it like a native”, and everything you saved.</li>
          <li><b>Explore</b>: find videos to learn from.</li>
          <li><b>Account</b>: your plan, this help, and sign out.</li></ul></li>
        <li><b>The app updates itself.</b> If something looks old, close the app and open it again.</li>
      </ol>`],
    ['find', '🧭 Finding a video', `
      <ol>
        <li>Tap <b>Explore</b> at the bottom.</li>
        <li>Under <b>Channels</b>, tap a channel (for example <b>Easy Russian</b>). You’ll see all of its videos.</li>
        <li>Tap a video:
          <ul><li><b>✓</b> = already in your lessons. It opens.</li>
          <li><b>+</b> = a finished lesson. It’s added to your lessons right away.</li>
          <li><b>PRO</b> = not made yet. Making new lessons is part of Pro.</li></ul></li>
        <li>Lessons under <b>Ready to study</b> (on Explore) are finished and open instantly.</li>
        <li>A brand-new lesson takes about 10 minutes the first time. You can keep studying meanwhile; it appears in <b>Learn</b> when it’s ready.</li>
      </ol>`],
    ['lesson', '🎧 Studying a lesson', `
      <p>The video is at the top. Under it are the buttons, then every sentence of the video.</p>
      <ol>
        <li><b>Hear one sentence:</b> tap the orange ${pic.play} next to it. The video jumps there and plays it. With <b>Pause each</b> on, it stops after that sentence; tap ${pic.play} again to hear it again. With Pause each off, it keeps playing from there.</li>
        <li><b>The big button</b> ${pic.bigplay} plays/pauses. With <b>Pause each</b> on, every tap plays the <b>next</b> sentence.</li>
        <li><b>|◀ and ▶|</b> go to the previous / next sentence.</li>
        <li>${pic.chip('1×')} changes the speed: 1× (normal), 0.75×, 0.5× (slow). The voice doesn’t change.</li>
        <li>${pic.chip('Loop')} repeats one sentence over and over. Great for saying it along with the speaker. Tap ▶ to stop.</li>
        <li>${pic.chipOn('Pause each')} (orange = on, the way every lesson starts) stops after every sentence. Turn it off to watch normally.</li>
        <li>Speed always starts at <b>1×</b> when you open the app.</li>
        <li>${pic.chipOn('Literal')} shows the word-by-word meaning under each Russian word. ${pic.chipOn('English')} shows the full translation. Turn them off to test yourself.</li>
        <li>${pic.chipOn('Follow')} keeps the sentence being spoken at the top as the video plays.</li>
        <li><b>Tap a word</b> with a ${pic.word('dotted orange line')} to hear it, see its meaning and save it.</li>
        <li>A <span class="gp-word unsure">wavy red line</span> means the checks weren’t sure that word is right. Tap it to see why.</li>
        <li>${pic.star} saves the whole sentence as a flashcard. Tap ${pic.starOn} again to un-save it.</li>
        <li>If you see a big <b>“Tap to play”</b> over the video, tap it once. (iPhones only start a video right after a tap.)</li>
        <li><b>⋯</b> (top right) shows details about the lesson, opens it on YouTube, or removes it from your lessons.</li>
      </ol>`],
    ['words', '🔤 Words', `
      <ol>
        <li>Tap any underlined word in a lesson or phrase. A card opens.</li>
        <li>The big word is split into syllables; the <b>orange</b> part is where the stress goes (say that part louder).</li>
        <li><b>🔊 Normal</b> and <b>🐢 Slowly</b> say the word.</li>
        <li><b>Dictionary form</b> is how you’d look the word up (e.g. <i>спал</i> → <i>спать</i>, “to sleep”).</li>
        <li><b>In your videos</b> lists other sentences with this word. Tap one (${pic.play}) to watch that moment.</li>
        <li><b>☆ Save Word</b> adds it to your flashcards.</li>
      </ol>`],
    ['saved', '⭐ Saved words and sentences', `
      <ol>
        <li>Go to <b>Practice</b> → <b>Saved</b>.</li>
        <li>Switch between <b>Words</b> and <b>Sentences</b> at the top. Use the search box to find one.</li>
        <li>Tap one to open it: <b>Open in Lesson</b> jumps to it in the video, <b>Review It Now</b> quizzes you on it, <b>Remove</b> deletes it.</li>
      </ol>`],
    ['review', '🔁 Review (flashcards)', `
      <ol>
        <li>Go to <b>Practice</b> → <b>Review</b>. The number shows how many cards are ready.</li>
        <li>Read or listen, and try to remember the meaning (or say it in Russian).</li>
        <li>Tap <b>Show</b> to see the answer.</li>
        <li>Be honest and tap one:
          <ul><li><b>Again</b>: you forgot. It comes back in a few minutes.</li>
          <li><b>Hard</b>: you barely got it.</li>
          <li><b>Good</b>: you got it.</li>
          <li><b>Easy</b>: too easy. You’ll see it much later.</li></ul>
          The small time on each button shows when you’ll see the card again.</li>
        <li>Made a mistake? Tap <b>Undo</b> at the top.</li>
        <li>A few minutes every day works better than a lot once a week.</li>
      </ol>`],
    ['phrases', '💬 Say it like a native', `
      <ol>
        <li>Go to <b>Practice</b> → <b>Say it like a native</b>.</li>
        <li>Type what you want to say, in English (or your Russian, to check it), and tap <b>Show Me</b>. It takes a minute or two.</li>
        <li>You get several versions. The orange label says when to use each: <b>anywhere</b>, <b>with friends</b>, <b>with strangers</b>. Some say <b>to a man / to a woman</b> or <b>if you’re a man / a woman</b>, because Russian changes with that.</li>
        <li><b>🔊 Normal / 🐢 Slowly</b> say it. Tap any word for its meaning.</li>
        <li><b>🎬 Heard in real videos</b>: tap one to watch a real person say it.</li>
        <li>${pic.star} saves a version as a flashcard. ${pic.x} removes a version you don’t want (tap “Show removed” to bring it back).</li>
        <li>Tap the phrase’s title to fold it closed or open it. The grey ✕ at the top right deletes the whole phrase.</li>
      </ol>`],
    ['goal', '🔥 Daily goal and streak', `
      <ol>
        <li>You earn points for listening to sentences, saving and reviewing.</li>
        <li>Reach your daily goal (the ring at the top of <b>Learn</b>) to keep your 🔥 streak going.</li>
        <li>Tap the ring to change your goal or see your week.</li>
      </ol>`],
    ['pro', '⭐ Free and Pro', `
      <ul>
        <li><b>Free:</b> the first 5 sentences of every lesson, lessons already in Explore, and 3 “Say it like a native” phrases a week. Saving and review are unlimited.</li>
        <li><b>Pro:</b> every sentence of every lesson, new lessons from any video on approved channels, and unlimited phrases.</li>
      </ul>`],
    ['trouble', '🛟 Something not working?', `
      <ul>
        <li><b>The video won’t start:</b> tap the orange ▶ (or “Tap to play”) once more.</li>
        <li><b>No sound:</b> check the volume and your iPhone’s silent switch.</li>
        <li><b>Something looks old or stuck:</b> close the app completely and open it again (or pull down on the page to refresh).</li>
        <li><b>The sign-in code didn’t arrive:</b> check spam, wait a minute, then ask for a new code.</li>
      </ul>`],
  ];

  // Scroll a topic to just under the top bar (with its title showing).
  function jumpTo(target) {
    const scr = $('#screen-help');
    const banner = scr.querySelector('.help-banner');
    // Below the top bar, and below the "Showing:" banner when it's there (it sticks under the bar).
    const barBottom = scr.querySelector('.page-bar').getBoundingClientRect().bottom + (banner && !banner.hidden ? banner.offsetHeight + 8 : 0);
    scr.scrollTop += target.getBoundingClientRect().top - barBottom - 12;
  }

  function openHelp(sec) {
    const box = $('#help-body');
    if (!box.dataset.built) {
      box.innerHTML = `<div class="help-index">${HELP.map(([id, title]) => `<button data-s="help-jump" data-sec="${id}">${title}</button>`).join('')}</div>
        ${HELP.map(([id, title, body]) => `<section class="help-sec" id="help-${id}"><div class="help-h"><h2>${title}</h2><button class="help-top" data-s="help-top">↑ All topics</button></div>${body}</section>`).join('')}
        <button class="primary-button" data-s="tour-replay" style="margin:8px 0 28px">▶ Replay the welcome tour</button>`;
      box.dataset.built = '1';
      // Opened partway down (from a ?): a banner says there's more above.
      const banner = document.createElement('button');
      banner.className = 'help-banner'; banner.dataset.s = 'help-top'; banner.hidden = true;
      $('#screen-help .page-bar').after(banner);
      $('#screen-help').addEventListener('scroll', () => {
        const idx = $('#help-body .help-index');
        if (!banner.hidden && idx.getBoundingClientRect().bottom > $('#screen-help .page-bar').getBoundingClientRect().bottom) banner.hidden = true;
      }, { passive: true });
    }
    stOpenPage('help', sec || null);
    const banner = $('#screen-help .help-banner');
    const target = sec && $(`#help-${sec}`);
    banner.hidden = !target;
    if (target) banner.innerHTML = `<span>Showing: <b>${HELP.find(h => h[0] === sec)[1]}</b></span><em>↑ See all topics</em>`;
    requestAnimationFrame(() => {
      if (target) {
        jumpTo(target);
        target.classList.remove('glow'); void target.offsetWidth; target.classList.add('glow');
      } else $('#screen-help').scrollTop = 0;
    });
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-s="help"], [data-s="help-top"], [data-s="help-jump"], [data-s="tour-replay"], [data-s="tips-reset"], [data-s="guide-reset-all"]');
    if (!b) return;
    if (b.dataset.s === 'help') { closeSheet?.(); openHelp(b.dataset.sec); }
    if (b.dataset.s === 'help-top') { $('#screen-help .help-banner').hidden = true; $('#screen-help').scrollTo({ top: 0, behavior: 'smooth' }); }
    if (b.dataset.s === 'help-jump') { const t = $(`#help-${b.dataset.sec}`); if (t) jumpTo(t); }
    if (b.dataset.s === 'tour-replay') { document.body.classList.remove('in-page'); showScreen('study'); setTimeout(start, 300); }
    if (b.dataset.s === 'tips-reset') { window.engage?.guideReset(); toast('Tips will show again on each screen'); }
    if (b.dataset.s === 'guide-reset-all') {
      window.engage?.guideResetAll();
      document.querySelectorAll('.tip-card').forEach(c => c.remove());
      document.body.classList.remove('in-page');
      showScreen('study');
      setTimeout(start, 300);
    }
  });

  // First sign-in: the tour, once (after the stats arrive, so it doesn't repeat on a new device).
  async function auto() {
    try { await window.engage?.pull(true); } catch { /* offline */ }
    if (seen('tour') || touring) return;
    setTimeout(() => { if (!seen('tour') && !document.body.classList.contains('signed-out')) start(); }, 700);
  }

  return { start, showTip, openHelp, auto, get touring() { return touring; } };
})();
window.guide = guide;
