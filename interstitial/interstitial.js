'use strict';
// Unhook Guard interstitial. The service worker is the authority; this page renders the steps.
(function () {
  var L = self.UnhookGuardLogic;
  var params = new URLSearchParams(location.search);
  var next = safeNext(params.get('next'));
  var HOME = 'https://www.youtube.com/';

  var data = null;     // payload from ug:getStatus
  var attempt = null;  // from ug:begin
  var intentText = '';
  var activeTimer = null;

  function $(id) { return document.getElementById(id); }

  function safeNext(v) {
    try {
      var u = new URL(v);
      if (u.protocol === 'https:' && (u.hostname === 'www.youtube.com' || u.hostname === 'm.youtube.com')) return u.href;
    } catch (e) { /* fall through */ }
    return 'https://www.youtube.com/';
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(function () { return { ok: false, reason: 'worker-unavailable' }; });
  }

  function show(name) {
    document.querySelectorAll('section[data-step]').forEach(function (s) { s.hidden = s.getAttribute('data-step') !== name; });
  }

  function stopTimer() {
    if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
  }

  // Counts down `seconds`, advancing only while the tab is visible.
  function runTimer(seconds, onTick, onDone) {
    stopTimer();
    var remaining = seconds;
    var last = performance.now();
    onTick(remaining);
    activeTimer = setInterval(function () {
      var now = performance.now();
      var dt = Math.min(1, (now - last) / 1000);
      last = now;
      if (document.visibilityState !== 'visible') return;
      remaining -= dt;
      if (remaining <= 0) { stopTimer(); onTick(0); onDone(); return; }
      onTick(remaining);
    }, 200);
  }

  function leaveToSearch() {
    stopTimer();
    var done = function () { location.replace(HOME); };
    if (attempt) send({ type: 'ug:abandon' }).then(done, done); else done();
  }

  function refresh() {
    return send({ type: 'ug:getStatus' }).then(function (d) {
      data = d;
      return d;
    });
  }

  function start() {
    refresh().then(function (d) {
      if (!d || !d.status) { fail('The guard service worker did not respond. Reload this page.'); return; }
      var st = d.status;
      if (!st.locked) {
        var mins = Math.ceil(st.remainingMs / 60000);
        $('already-text').textContent = 'About ' + mins + ' minute(s) remain before it locks again.';
        show('already');
        return;
      }
      if (st.unlocksLeft <= 0) {
        $('limit-text').textContent = 'You used all ' + d.settings.dailyUnlockLimit + ' unlocks. The count resets at ' +
          String(d.settings.dayStartHour).padStart(2, '0') + ':00. Search for what you want instead.';
        show('limit');
        return;
      }
      $('status-text').textContent = 'Unlock ' + (st.unlocksUsed + 1) + ' of ' + d.settings.dailyUnlockLimit +
        ' today. You will wait ' + st.nextCountdownSec + ' seconds, then breathe for ' + (d.settings.breathingCycles * 10) +
        ' seconds. The feed stays open for ' + d.settings.unlockMinutes + ' minutes.';
      show('status');
    });
  }

  function fail(text) {
    stopTimer();
    $('error-text').textContent = text;
    show('error');
  }

  var REASONS = {
    'limit': 'No unlocks are left today.',
    'already-unlocked': 'The feed is already unlocked.',
    'no-attempt': 'This attempt expired or was replaced.',
    'too-early': 'The required waiting time had not passed yet.',
    'intent': 'The intent text was not accepted.',
    'worker-unavailable': 'The guard service worker did not respond.'
  };

  // ---- Step wiring ----
  $('status-continue').addEventListener('click', function () { show('intent'); $('intent').focus(); validate(); });

  function validate() {
    var r = L.validateIntent($('intent').value, data.settings, data.recentIntents);
    $('intent-continue').disabled = !r.ok;
    $('intent-msg').textContent = $('intent').value.trim() ? r.reason : '';
    return r.ok;
  }
  $('intent').addEventListener('input', validate);

  $('intent-continue').addEventListener('click', function () {
    if (!validate()) return;
    intentText = $('intent').value.trim();
    send({ type: 'ug:begin' }).then(function (r) {
      if (!r || !r.ok) { fail(REASONS[r && r.reason] || 'Could not start the unlock.'); return; }
      attempt = r.attempt;
      show('countdown');
      $('countdown-note').textContent = 'Unlock ' + attempt.unlockIndex + ' of ' + data.settings.dailyUnlockLimit + ' today.';
      runTimer(attempt.countdownSec, function (s) { $('countdown-num').textContent = String(Math.ceil(s)); }, startBreathing);
    });
  });

  function startBreathing() {
    var cycles = data.settings.breathingCycles;
    if (cycles <= 0) { showConfirm1(); return; }
    show('breathing');
    var total = cycles * 10;
    var circle = $('breath-circle');
    runTimer(total, function (remaining) {
      var elapsed = total - remaining;
      var inCycle = elapsed % 10;
      var breathingIn = inCycle < 4;
      $('breath-label').textContent = breathingIn ? 'Breathe in' : 'Breathe out';
      var want = breathingIn ? 'in' : 'out';
      if (circle.getAttribute('data-phase') !== want) {
        circle.setAttribute('data-phase', want);
        void circle.offsetWidth; // force reflow so the CSS transition restarts
        circle.className = 'circle ' + want;
      }
      $('breath-note').textContent = Math.ceil(remaining) + ' seconds left';
    }, showConfirm1);
  }

  function showConfirm1() {
    $('confirm1-intent').textContent = intentText;
    show('confirm1');
    $('confirm1-yes').focus();
  }
  $('confirm1-yes').addEventListener('click', function () {
    $('confirm2-text').textContent = 'The feed will open for ' + data.settings.unlockMinutes +
      ' minutes, then lock again. This is unlock ' + attempt.unlockIndex + ' of ' + data.settings.dailyUnlockLimit + ' today.';
    show('confirm2');
    $('confirm2-cancel').focus();
  });

  $('confirm2-go').addEventListener('click', function () {
    send({ type: 'ug:complete', attemptId: attempt.id, intent: intentText }).then(function (r) {
      if (r && r.ok) { attempt = null; location.replace(next); return; }
      fail(REASONS[r && r.reason] || 'The unlock was refused.');
    });
  });

  $('error-restart').addEventListener('click', function () {
    attempt = null;
    intentText = '';
    $('intent').value = '';
    show('loading');
    start();
  });

  document.querySelectorAll('[data-action="cancel"]').forEach(function (b) { b.addEventListener('click', leaveToSearch); });
  $('already-go').addEventListener('click', function () { location.replace(next); });
  $('limit-search').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('limit-query').value.trim();
    if (!q) return;
    send({ type: 'ug:logSearch', text: q }).then(function () {
      location.replace('https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
    });
  });

  start();
})();
