'use strict';
(function () {
  var L = self.UnhookGuardLogic;
  var data = null;

  // key, label, type, help
  var FIELDS = [
    ['dailyUnlockLimit', 'Daily unlock limit', 'number', 'Completed unlocks allowed per day. Lower is stricter.'],
    ['unlockMinutes', 'Unlock duration (minutes)', 'number', 'The feed re-locks after this long. Lower is stricter.'],
    ['countdownSeconds', 'Countdown seconds per unlock', 'list', 'Comma separated, one value per unlock of the day (for example 30, 60, 120). The last value repeats. Higher is stricter.'],
    ['breathingCycles', 'Breathing cycles', 'number', 'Each cycle is 10 seconds. Higher is stricter.'],
    ['intentMinChars', 'Intent minimum characters', 'number', 'Higher is stricter.'],
    ['intentMinWords', 'Intent minimum words', 'number', 'Higher is stricter.'],
    ['dayStartHour', 'Day starts at hour (0-23)', 'number', 'The daily count resets at this local hour. Any change takes 24 hours.'],
    ['blockSubscriptions', 'Lock the subscriptions feed', 'bool', 'On is stricter.'],
    ['blockShorts', 'Block Shorts', 'bool', 'On is stricter.'],
    ['shortsWithUnlock', 'Allow Shorts during an unlock', 'bool', 'Off is stricter.'],
    ['logIntents', 'Log intents and searches', 'bool', 'Turning this off takes 24 hours.'],
    ['historyMax', 'History size (entries)', 'number', 'Applies immediately.']
  ];
  var inputs = {};

  function $(id) { return document.getElementById(id); }
  function send(msg) { return chrome.runtime.sendMessage(msg).catch(function () { return null; }); }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildForm() {
    var form = $('settings-form');
    FIELDS.forEach(function (f) {
      var wrap = el('div', { class: 'field' });
      wrap.appendChild(el('label', { for: 'f-' + f[0] }, f[1]));
      var input;
      if (f[2] === 'bool') input = el('input', { type: 'checkbox', id: 'f-' + f[0] });
      else if (f[2] === 'list') input = el('input', { type: 'text', id: 'f-' + f[0] });
      else input = el('input', { type: 'number', id: 'f-' + f[0], step: '1' });
      inputs[f[0]] = input;
      wrap.appendChild(input);
      wrap.appendChild(el('small', {}, f[3]));
      form.appendChild(wrap);
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  function fill(settings) {
    FIELDS.forEach(function (f) {
      var i = inputs[f[0]];
      var v = settings[f[0]];
      if (f[2] === 'bool') i.checked = !!v;
      else if (f[2] === 'list') i.value = v.join(', ');
      else i.value = String(v);
    });
  }

  function readInput(f) {
    var i = inputs[f[0]];
    if (f[2] === 'bool') return i.checked;
    if (f[2] === 'list') {
      var parts = i.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      return parts.map(function (s) { return /^\d+$/.test(s) ? Number(s) : NaN; });
    }
    return i.value.trim() === '' ? NaN : Number(i.value);
  }

  function fmtTime(ts) { return new Date(ts).toLocaleString(); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function render() {
    var st = data.status;
    $('today').textContent = (st.locked ? 'Locked. ' : 'Unlocked until ' + fmtTime(st.unlockedUntil) + '. ') +
      'Unlocks used today: ' + st.unlocksUsed + ' of ' + data.settings.dailyUnlockLimit + '.';
    fill(data.settings);

    var ul = $('pending');
    ul.textContent = '';
    data.pending.forEach(function (p) {
      var li = el('li', {}, p.key + ': ' + JSON.stringify(p.from) + ' becomes ' + JSON.stringify(p.to) + ' at ' + fmtTime(p.effectiveAt) + ' ');
      var b = el('button', { type: 'button' }, 'Cancel');
      b.addEventListener('click', function () { send({ type: 'ug:cancelPending', id: p.id }).then(load); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    $('pending-empty').hidden = data.pending.length > 0;

    var sum = L.summarizeHistory(data.history, data.now, data.settings);
    $('stats').textContent = 'Unlocks in the last 7 days: ' + sum.last7Days + '. Times you stopped yourself: ' + sum.abandoned +
      '. History cleared: ' + data.cleared + ' time(s).' +
      (sum.topIntentsToday.length ? ' Today you said: ' + sum.topIntentsToday.join(' | ') : '');

    var tbody = $('history').querySelector('tbody');
    tbody.textContent = '';
    data.history.slice().reverse().slice(0, 100).forEach(function (e) {
      var tr = el('tr');
      var detail = e.text || e.videoId || (e.unlockIndex ? 'unlock #' + e.unlockIndex : '');
      [fmtTime(e.ts), e.type, detail].forEach(function (c) { tr.appendChild(el('td', {}, c)); });
      tbody.appendChild(tr);
    });
  }

  function load() {
    return Promise.all([send({ type: 'ug:getStatus' }), chrome.storage.local.get(['ug_history', 'ug_state'])]).then(function (r) {
      if (!r[0]) { $('save-msg').textContent = 'The guard service worker did not respond.'; return; }
      data = r[0];
      data.history = Array.isArray(r[1].ug_history) ? r[1].ug_history : [];
      data.cleared = (r[1].ug_state && r[1].ug_state.clearedCount) || 0;
      render();
    });
  }

  $('save').addEventListener('click', function () {
    var msg = $('save-msg');
    msg.className = 'msg';
    var patch = {};
    var invalid = [];
    FIELDS.forEach(function (f) {
      var v = readInput(f);
      if (L.sanitizeSetting(f[0], v) === undefined) { invalid.push(f[1]); return; }
      if (!same(v, data.settings[f[0]])) patch[f[0]] = v;
    });
    if (invalid.length) { msg.className = 'msg error'; msg.textContent = 'Invalid value for: ' + invalid.join(', '); return; }
    if (!Object.keys(patch).length) { msg.textContent = 'Nothing changed.'; return; }
    send({ type: 'ug:updateSettings', patch: patch }).then(function (r) {
      if (!r || !r.ok) { msg.className = 'msg error'; msg.textContent = 'Could not save.'; return; }
      var parts = [];
      if (r.appliedNow.length) parts.push('Applied now: ' + r.appliedNow.join(', ') + '.');
      if (r.queued.length) parts.push('Waiting 24 hours: ' + r.queued.join(', ') + '.');
      msg.textContent = parts.join(' ');
      load();
    });
  });

  $('clear').addEventListener('click', function () {
    send({ type: 'ug:clearHistory' }).then(load);
  });

  buildForm();
  load();
})();
