/*
 * Unhook Guard: pure friction/state logic.
 * No chrome.* calls, no Date.now(): `now` is always a parameter.
 * Loads as a classic script (importScripts, content script, extension page) and under node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UnhookGuardLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600 * 1000;
  var MINUTE = 60 * 1000;
  var PENDING_DELAY_MS = 24 * HOUR;
  var ATTEMPT_TTL_MS = 15 * MINUTE;
  var WATCH_DEDUP_MS = 10 * MINUTE;
  var RECENT_INTENT_MS = 24 * HOUR;

  var DEFAULT_SETTINGS = Object.freeze({
    countdownSeconds: Object.freeze([30, 60, 120]),
    intentMinChars: 12,
    intentMinWords: 2,
    breathingCycles: 3,
    dailyUnlockLimit: 3,
    unlockMinutes: 10,
    dayStartHour: 4,
    blockSubscriptions: true,
    blockShorts: true,
    shortsWithUnlock: false,
    logIntents: true,
    historyMax: 500
  });

  var SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

  // Direction of "stricter" per key. 'higher', 'lower', 'any' (any change counts as weakening), 'neutral'.
  var STRICTNESS = {
    countdownSeconds: 'higher',
    intentMinChars: 'higher',
    intentMinWords: 'higher',
    breathingCycles: 'higher',
    blockSubscriptions: 'higher',
    blockShorts: 'higher',
    dailyUnlockLimit: 'lower',
    unlockMinutes: 'lower',
    shortsWithUnlock: 'lower',
    dayStartHour: 'any',
    logIntents: 'any',
    historyMax: 'neutral'
  };

  var NUMBER_BOUNDS = {
    intentMinChars: [0, 200],
    intentMinWords: [0, 20],
    breathingCycles: [0, 20],
    dailyUnlockLimit: [0, 50],
    unlockMinutes: [1, 120],
    dayStartHour: [0, 23],
    historyMax: [50, 5000]
  };
  var BOOLEAN_KEYS = ['blockSubscriptions', 'blockShorts', 'shortsWithUnlock', 'logIntents'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mergeSettings(stored) {
    var out = clone(DEFAULT_SETTINGS);
    if (stored && typeof stored === 'object') {
      SETTING_KEYS.forEach(function (k) {
        var v = sanitizeSetting(k, stored[k]);
        if (v !== undefined) out[k] = v;
      });
    }
    return out;
  }

  // Returns a clean value or undefined when invalid.
  function sanitizeSetting(key, value) {
    if (SETTING_KEYS.indexOf(key) === -1) return undefined;
    if (key === 'countdownSeconds') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 6) return undefined;
      var arr = [];
      for (var i = 0; i < value.length; i++) {
        var n = value[i];
        if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > 3600) return undefined;
        arr.push(n);
      }
      return arr;
    }
    if (BOOLEAN_KEYS.indexOf(key) !== -1) return typeof value === 'boolean' ? value : undefined;
    var b = NUMBER_BOUNDS[key];
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) return undefined;
    if (value < b[0] || value > b[1]) return undefined;
    return value;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // YYYY-MM-DD of local time shifted back by dayStartHour.
  function dayKey(nowMs, dayStartHour) {
    var d = new Date(nowMs - (dayStartHour || 0) * HOUR);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function defaultState(now, settings) {
    return {
      dayKey: dayKey(now, settings.dayStartHour),
      unlocksUsed: 0,
      unlockedUntil: 0,
      lastSeen: now,
      clearedCount: 0,
      attempt: null
    };
  }

  /*
   * Returns { state, now, expiredUnlock, abandonedAttempt }.
   * `now` is the effective time: max(now, lastSeen), so setting the clock back changes nothing.
   */
  function normalizeState(state, now, settings) {
    var s = Object.assign(defaultState(now, settings), state && typeof state === 'object' ? clone(state) : {});
    var eff = Math.max(now, Number(s.lastSeen) || 0);
    s.lastSeen = eff;
    var expiredUnlock = false;
    var abandonedAttempt = null;

    var key = dayKey(eff, settings.dayStartHour);
    if (s.dayKey !== key) {
      // Only roll forward; a smaller key can only come from a bad stored value.
      s.dayKey = key;
      s.unlocksUsed = 0;
    }
    if (s.unlockedUntil > 0 && s.unlockedUntil <= eff) {
      s.unlockedUntil = 0;
      expiredUnlock = true;
    }
    if (s.attempt && eff - s.attempt.startedAt > ATTEMPT_TTL_MS) {
      abandonedAttempt = s.attempt;
      s.attempt = null;
    }
    return { state: s, now: eff, expiredUnlock: expiredUnlock, abandonedAttempt: abandonedAttempt };
  }

  function isUnlocked(state, now) {
    return state.unlockedUntil > now;
  }

  function requiredCountdown(settings, unlocksUsedToday) {
    var a = settings.countdownSeconds;
    var i = Math.max(0, Math.min(unlocksUsedToday, a.length - 1));
    return a[i];
  }

  function getStatus(state, settings, now) {
    var n = normalizeState(state, now, settings);
    var s = n.state;
    var unlocked = isUnlocked(s, n.now);
    var left = Math.max(0, settings.dailyUnlockLimit - s.unlocksUsed);
    return {
      locked: !unlocked,
      unlockedUntil: unlocked ? s.unlockedUntil : 0,
      remainingMs: unlocked ? s.unlockedUntil - n.now : 0,
      unlocksUsed: s.unlocksUsed,
      unlocksLeft: left,
      canUnlock: left > 0 && !unlocked,
      nextCountdownSec: requiredCountdown(settings, s.unlocksUsed),
      dayKey: s.dayKey
    };
  }

  function normalizeIntent(text) {
    return String(text == null ? '' : text).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function validateIntent(text, settings, recentIntents) {
    var t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (t.length < settings.intentMinChars) {
      return { ok: false, reason: 'Write at least ' + settings.intentMinChars + ' characters.' };
    }
    var words = t.length ? t.split(' ').length : 0;
    if (words < settings.intentMinWords) {
      return { ok: false, reason: 'Use at least ' + settings.intentMinWords + ' words. Name the title or topic.' };
    }
    var unique = {};
    t.toLowerCase().replace(/\s/g, '').split('').forEach(function (c) { unique[c] = true; });
    if (Object.keys(unique).length < 4) {
      return { ok: false, reason: 'That looks like filler text. Name something specific.' };
    }
    var norm = normalizeIntent(t);
    var recent = recentIntents || [];
    for (var i = 0; i < recent.length; i++) {
      if (normalizeIntent(recent[i]) === norm) {
        return { ok: false, reason: 'You used this exact text in the last 24 hours. Describe what you want to watch now.' };
      }
    }
    return { ok: true, reason: '' };
  }

  function beginAttempt(state, settings, now, id) {
    var n = normalizeState(state, now, settings);
    var s = n.state;
    if (isUnlocked(s, n.now)) return { ok: false, reason: 'already-unlocked' };
    if (s.unlocksUsed >= settings.dailyUnlockLimit) return { ok: false, reason: 'limit' };
    s.attempt = {
      id: id,
      startedAt: n.now,
      countdownSec: requiredCountdown(settings, s.unlocksUsed),
      breathingSec: settings.breathingCycles * 10,
      unlockIndex: s.unlocksUsed + 1
    };
    return { ok: true, state: s, attempt: s.attempt, abandonedAttempt: n.abandonedAttempt };
  }

  function completeAttempt(state, settings, attemptId, intent, now, recentIntents) {
    var n = normalizeState(state, now, settings);
    var s = n.state;
    var fail = function (reason) { return { ok: false, reason: reason, state: s }; };
    if (isUnlocked(s, n.now)) return fail('already-unlocked');
    if (s.unlocksUsed >= settings.dailyUnlockLimit) return fail('limit');
    var a = s.attempt;
    if (!a || a.id !== attemptId) return fail('no-attempt');
    var needMs = (a.countdownSec + a.breathingSec) * 1000;
    if (n.now - a.startedAt < needMs) return fail('too-early');
    var v = validateIntent(intent, settings, recentIntents);
    if (!v.ok) return fail('intent');
    s.unlocksUsed += 1;
    s.unlockedUntil = n.now + settings.unlockMinutes * MINUTE;
    s.attempt = null;
    var entry = { ts: n.now, type: 'unlock', unlockIndex: s.unlocksUsed, dayKey: s.dayKey };
    if (settings.logIntents) entry.text = String(intent).trim().replace(/\s+/g, ' ');
    return { ok: true, state: s, historyEntry: entry };
  }

  function abandonAttempt(state, now) {
    var s = clone(state);
    var a = s.attempt;
    s.attempt = null;
    if (!a) return { ok: false, state: s };
    return { ok: true, state: s, historyEntry: { ts: now, type: 'abandoned', unlockIndex: a.unlockIndex, dayKey: s.dayKey } };
  }

  function lockNow(state, now) {
    var s = clone(state);
    var was = s.unlockedUntil > now;
    s.unlockedUntil = 0;
    return { state: s, wasUnlocked: was };
  }

  function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function valuesEqual(a, b) {
    return Array.isArray(a) ? arraysEqual(a, b) : a === b;
  }

  function isWeakening(key, from, to) {
    var mode = STRICTNESS[key];
    if (mode === undefined) return false;
    if (valuesEqual(from, to)) return false;
    if (mode === 'neutral') return false;
    if (mode === 'any') return true;
    if (key === 'countdownSeconds') {
      if (!Array.isArray(to) || !Array.isArray(from) || to.length === 0 || from.length === 0) return true;
      // Compare effective values: indexes past the end reuse the last entry.
      var n = Math.max(from.length, to.length);
      for (var i = 0; i < n; i++) {
        if (to[Math.min(i, to.length - 1)] < from[Math.min(i, from.length - 1)]) return true;
      }
      return false;
    }
    var f = Number(from);
    var t = Number(to);
    return mode === 'higher' ? t < f : t > f;
  }

  function withoutKey(pending, key) {
    return pending.filter(function (p) { return p.key !== key; });
  }

  /*
   * Strengthening changes apply now. Weakening changes are queued for PENDING_DELAY_MS.
   * Invalid values are reported in `rejected` and ignored.
   */
  function requestSettingsChange(settings, pending, patch, now, id) {
    var st = clone(settings);
    var pe = clone(pending || []);
    var queued = [];
    var appliedNow = [];
    var rejected = [];
    Object.keys(patch || {}).forEach(function (key) {
      var v = sanitizeSetting(key, patch[key]);
      if (v === undefined) { rejected.push(key); return; }
      if (valuesEqual(st[key], v)) {
        pe = withoutKey(pe, key);
        return;
      }
      if (isWeakening(key, st[key], v)) {
        pe = withoutKey(pe, key);
        pe.push({ id: id + '-' + key, key: key, from: clone(st[key]), to: v, requestedAt: now, effectiveAt: now + PENDING_DELAY_MS });
        queued.push(key);
      } else {
        st[key] = v;
        pe = withoutKey(pe, key);
        appliedNow.push(key);
      }
    });
    return { settings: st, pending: pe, queued: queued, appliedNow: appliedNow, rejected: rejected };
  }

  function applyDuePending(settings, pending, now) {
    var st = clone(settings);
    var rest = [];
    var applied = [];
    (pending || []).slice().sort(function (a, b) { return a.effectiveAt - b.effectiveAt; }).forEach(function (p) {
      if (p.effectiveAt <= now) { st[p.key] = clone(p.to); applied.push(p); } else rest.push(p);
    });
    return { settings: st, pending: rest, applied: applied };
  }

  function cancelPending(pending, id) {
    return (pending || []).filter(function (p) { return p.id !== id; });
  }

  function nextDueTime(state, pending) {
    var times = [];
    if (state && state.unlockedUntil > 0) times.push(state.unlockedUntil);
    (pending || []).forEach(function (p) { times.push(p.effectiveAt); });
    return times.length ? Math.min.apply(null, times) : null;
  }

  function hostIsYoutube(host) {
    return host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtube.com';
  }

  function classifyUrl(urlString, settings) {
    var u;
    try { u = new URL(urlString); } catch (e) { return { kind: 'other', gated: null }; }
    if (!hostIsYoutube(u.hostname)) return { kind: 'other', gated: null };
    var p = u.pathname;
    if (p === '/' || p === '' || p === '/index') return { kind: 'home', gated: 'feed' };
    if (p.indexOf('/shorts') === 0 && (p === '/shorts' || p.charAt(7) === '/')) {
      return { kind: 'shorts', gated: settings.blockShorts ? 'shorts' : null };
    }
    if (p === '/feed/subscriptions' || p.indexOf('/feed/subscriptions/') === 0) {
      return { kind: 'feed', gated: settings.blockSubscriptions ? 'feed' : null };
    }
    if (p === '/feed/trending' || p === '/feed/explore' || p === '/gaming' || p.indexOf('/hashtag/') === 0) {
      return { kind: 'feed', gated: 'feed' };
    }
    if (p === '/watch' || p.indexOf('/live/') === 0 || p.indexOf('/embed/') === 0 || p === '/playlist') {
      return { kind: 'watch', gated: null };
    }
    if (p === '/results') return { kind: 'search', gated: null };
    return { kind: 'other', gated: null };
  }

  function shouldBlock(classification, state, settings, now) {
    var unlocked = isUnlocked(state, now);
    if (classification.gated === 'feed') return !unlocked;
    if (classification.gated === 'shorts') return !(unlocked && settings.shortsWithUnlock);
    return false;
  }

  function appendHistory(history, entry, settings) {
    var h = (history || []).slice();
    if (entry.type === 'watch' && entry.videoId) {
      for (var i = h.length - 1; i >= 0; i--) {
        if (entry.ts - h[i].ts > WATCH_DEDUP_MS) break;
        if (h[i].type === 'watch' && h[i].videoId === entry.videoId) return h;
      }
    }
    h.push(entry);
    var max = settings.historyMax;
    if (h.length > max) h = h.slice(h.length - max);
    return h;
  }

  function recentIntents(history, now) {
    return (history || []).filter(function (e) {
      return e.type === 'unlock' && e.text && now - e.ts <= RECENT_INTENT_MS;
    }).map(function (e) { return e.text; });
  }

  function summarizeHistory(history, now, settings) {
    var byDay = {};
    var abandoned = 0;
    var today = dayKey(now, settings.dayStartHour);
    var topToday = [];
    (history || []).forEach(function (e) {
      if (e.type === 'unlock') {
        byDay[e.dayKey] = (byDay[e.dayKey] || 0) + 1;
        if (e.dayKey === today && e.text) topToday.push(e.text);
      } else if (e.type === 'abandoned') abandoned += 1;
    });
    var last7 = 0;
    for (var i = 0; i < 7; i++) {
      last7 += byDay[dayKey(now - i * 24 * HOUR, settings.dayStartHour)] || 0;
    }
    return { unlocksByDay: byDay, abandoned: abandoned, last7Days: last7, topIntentsToday: topToday };
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTING_KEYS: SETTING_KEYS,
    PENDING_DELAY_MS: PENDING_DELAY_MS,
    ATTEMPT_TTL_MS: ATTEMPT_TTL_MS,
    mergeSettings: mergeSettings,
    sanitizeSetting: sanitizeSetting,
    dayKey: dayKey,
    defaultState: defaultState,
    normalizeState: normalizeState,
    isUnlocked: isUnlocked,
    requiredCountdown: requiredCountdown,
    getStatus: getStatus,
    validateIntent: validateIntent,
    beginAttempt: beginAttempt,
    completeAttempt: completeAttempt,
    abandonAttempt: abandonAttempt,
    lockNow: lockNow,
    isWeakening: isWeakening,
    requestSettingsChange: requestSettingsChange,
    applyDuePending: applyDuePending,
    cancelPending: cancelPending,
    nextDueTime: nextDueTime,
    classifyUrl: classifyUrl,
    shouldBlock: shouldBlock,
    appendHistory: appendHistory,
    recentIntents: recentIntents,
    summarizeHistory: summarizeHistory
  };
}));
