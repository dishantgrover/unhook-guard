'use strict';
// Unhook Guard content script: route detection, <html> attributes for content.css, and the lock overlay.
(function () {
  var L = self.UnhookGuardLogic;
  if (!L) return;

  var html = document.documentElement;
  var HOST_ID = 'ug-overlay-host';
  var settings = L.mergeSettings(null);
  var rawState = null;
  var loaded = false;
  var lastHref = '';
  var lastWatchId = '';
  var expiryTimer = null;
  var overlayRoot = null;
  var overlayKey = '';

  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return Promise.resolve(null);
      return chrome.runtime.sendMessage(msg).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function effectiveState() {
    var now = Date.now();
    return L.normalizeState(rawState, now, settings);
  }

  function setAttr(name, value) {
    if (value === null) { if (html.hasAttribute(name)) html.removeAttribute(name); }
    else if (html.getAttribute(name) !== value) html.setAttribute(name, value);
  }

  function compute() {
    var href = location.href;
    lastHref = href;
    var cls = L.classifyUrl(href, settings);
    var n = effectiveState();
    var unlocked = loaded && L.isUnlocked(n.state, n.now);
    // Fail closed: before storage is read, any gated route counts as blocked.
    var block = loaded ? L.shouldBlock(cls, n.state, settings, n.now) : cls.gated !== null;
    var shortsBlock = settings.blockShorts && !(unlocked && settings.shortsWithUnlock);

    setAttr('ug-state', loaded ? (unlocked ? 'unlocked' : 'locked') : null);
    setAttr('ug-route', block ? 'block' : 'ok');
    setAttr('ug-shorts', shortsBlock ? 'block' : 'ok');

    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    if (unlocked) {
      var ms = Math.max(250, n.state.unlockedUntil - n.now + 50);
      expiryTimer = setTimeout(compute, Math.min(ms, 2147483647));
    }

    if (block && loaded) mountOverlay(cls, n.state);
    else unmountOverlay();

    if (block) pauseMedia();

    if (cls.kind === 'watch') {
      var id = '';
      try { id = new URL(href).searchParams.get('v') || ''; } catch (e) { id = ''; }
      if (id && id !== lastWatchId) { lastWatchId = id; send({ type: 'ug:logWatch', videoId: id }); }
    } else if (cls.kind !== 'watch') {
      lastWatchId = '';
    }
  }

  // A hidden Shorts or home-preview player can keep playing audio.
  function pauseMedia() {
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      try { if (!vids[i].paused) vids[i].pause(); } catch (e) { /* ignore */ }
    }
  }

  // ---- Overlay (closed shadow root so page CSS cannot reach it) ----
  var OVERLAY_CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;inset:0;z-index:2147483647;background:#101418;color:#e8eaed;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.card{width:min(520px,90vw);text-align:center}',
    'h1{font-size:28px;margin:0 0 8px;font-weight:600}',
    'p{margin:0 0 20px;color:#aab0b7}',
    'form{display:flex;gap:8px;margin-bottom:20px}',
    'input{flex:1;padding:12px 14px;font-size:16px;border-radius:8px;border:1px solid #3c4650;background:#1b2128;color:#e8eaed}',
    'button{padding:12px 16px;font-size:15px;border-radius:8px;border:1px solid #3c4650;background:#2b3540;color:#e8eaed;cursor:pointer}',
    'button.link{background:none;border:none;color:#8ab4f8;text-decoration:underline;padding:6px}',
    '.small{font-size:13px;color:#8b939b;margin-top:12px}'
  ].join('');

  function el(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') e.textContent = props[k]; else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function mountOverlay(cls, state) {
    var left = Math.max(0, settings.dailyUnlockLimit - state.unlocksUsed);
    var isShorts = cls.gated === 'shorts';
    var canUnlock = !isShorts || settings.shortsWithUnlock;
    var key = [isShorts, canUnlock, left].join('|');
    var host = document.getElementById(HOST_ID);
    if (host && overlayRoot && overlayKey === key) return;
    if (host) host.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    var root = host.attachShadow({ mode: 'closed' });
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.appendChild(el('style', { text: OVERLAY_CSS }));
    }

    var input = el('input', { type: 'text', placeholder: 'Search YouTube for something specific', 'aria-label': 'Search YouTube', autocomplete: 'off' });
    var form = el('form', {}, [input, el('button', { type: 'submit', text: 'Search' })]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      send({ type: 'ug:logSearch', text: q });
      setTimeout(function () { location.assign('/results?search_query=' + encodeURIComponent(q)); }, 60);
    });

    var kids = [
      el('h1', { text: isShorts ? 'Shorts are blocked' : 'Your feed is locked' }),
      el('p', { text: 'Search for what you came to watch, or open a video you already have in mind.' }),
      form
    ];
    if (canUnlock) {
      var btn = el('button', { type: 'button', text: left > 0 ? 'Unlock the feed...' : 'No unlocks left today' });
      if (left > 0) {
        btn.addEventListener('click', function () {
          send({ type: 'ug:openInterstitial', reason: isShorts ? 'shorts' : 'feed', next: location.href });
        });
      } else btn.disabled = true;
      kids.push(btn);
      kids.push(el('div', { class: 'small', text: 'Unlocks left today: ' + left }));
    }
    var wrap = el('div', { class: 'wrap' }, [el('div', { class: 'card' }, kids)]);
    root.appendChild(wrap);
    html.appendChild(host);
    overlayRoot = root;
    overlayKey = key;
    setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  function unmountOverlay() {
    var host = document.getElementById(HOST_ID);
    if (host) host.remove();
    overlayRoot = null;
    overlayKey = '';
  }

  // ---- Storage ----
  function readStorage() {
    try {
      chrome.storage.local.get(['ug_settings', 'ug_state']).then(function (r) {
        settings = L.mergeSettings(r.ug_settings);
        rawState = r.ug_state || null;
        loaded = true;
        compute();
      }, function () { /* stay fail-closed */ });
    } catch (e) { /* extension context invalidated: stay fail-closed */ }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.ug_settings || changes.ug_state) {
        if (changes.ug_settings) settings = L.mergeSettings(changes.ug_settings.newValue);
        if (changes.ug_state) rawState = changes.ug_state.newValue || null;
        loaded = true;
        compute();
      }
    });
  } catch (e) { /* ignore */ }

  // ---- SPA navigation ----
  ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'].forEach(function (name) {
    document.addEventListener(name, compute, true);
  });
  window.addEventListener('popstate', compute);
  window.addEventListener('hashchange', compute);
  setInterval(function () {
    if (location.href !== lastHref) compute();
    else if (html.getAttribute('ug-route') === 'block') pauseMedia();
  }, 500);

  compute(); // immediate, fail-closed
  readStorage();
})();
