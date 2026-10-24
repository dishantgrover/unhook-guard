'use strict';
// Run with: TZ=UTC node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../lib/guard-logic.js');

const S = L.DEFAULT_SETTINGS;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0); // 2026-01-15 10:00 UTC
const GOOD = 'the 3blue1brown video about neural networks';

function fresh(now) { return L.normalizeState(null, now, S).state; }

// Runs a full unlock at time `t`; returns { state, end }.
function unlockAt(state, t, intent) {
  const b = L.beginAttempt(state, S, t, 'a' + t);
  assert.equal(b.ok, true, 'begin should succeed');
  const wait = (b.attempt.countdownSec + b.attempt.breathingSec) * 1000;
  const c = L.completeAttempt(b.state, S, 'a' + t, intent, t + wait, []);
  return { c, end: t + wait };
}

test('dayKey rolls over at dayStartHour', () => {
  assert.equal(L.dayKey(Date.UTC(2026, 0, 15, 3, 59), 4), '2026-01-14');
  assert.equal(L.dayKey(Date.UTC(2026, 0, 15, 4, 0), 4), '2026-01-15');
  assert.equal(L.dayKey(Date.UTC(2026, 0, 15, 0, 0), 0), '2026-01-15');
});

test('daily unlock counting, limit refusal and day rollover', () => {
  let st = fresh(T0);
  let t = T0;
  const intents = ['first video about rust lifetimes', 'second talk on compiler design', 'third lecture on thermodynamics'];
  for (let i = 0; i < 3; i++) {
    const { c, end } = unlockAt(st, t, intents[i]);
    assert.equal(c.ok, true);
    assert.equal(c.state.unlocksUsed, i + 1);
    assert.equal(c.historyEntry.unlockIndex, i + 1);
    // let the unlock expire, then continue
    t = end + S.unlockMinutes * MIN + 1;
    st = L.normalizeState(c.state, t, S).state;
    assert.equal(st.unlockedUntil, 0);
  }
  assert.equal(st.unlocksUsed, 3);
  const refused = L.beginAttempt(st, S, t, 'x');
  assert.deepEqual([refused.ok, refused.reason], [false, 'limit']);
  assert.equal(L.getStatus(st, S, t).canUnlock, false);
  assert.equal(L.getStatus(st, S, t).unlocksLeft, 0);

  // Next day (04:00 boundary) resets the count.
  const nextDay = Date.UTC(2026, 0, 16, 4, 0, 0);
  const rolled = L.normalizeState(st, nextDay, S).state;
  assert.equal(rolled.unlocksUsed, 0);
  assert.equal(L.beginAttempt(rolled, S, nextDay, 'y').ok, true);
});

test('completeAttempt also refuses when limit already reached', () => {
  const st = fresh(T0);
  st.unlocksUsed = 3;
  st.attempt = { id: 'z', startedAt: T0, countdownSec: 30, breathingSec: 30, unlockIndex: 4 };
  const c = L.completeAttempt(st, S, 'z', GOOD, T0 + 10 * MIN, []);
  assert.deepEqual([c.ok, c.reason], [false, 'limit']);
});

test('abandoned attempt does not use up an unlock', () => {
  const st = fresh(T0);
  const b = L.beginAttempt(st, S, T0, 'a1');
  const ab = L.abandonAttempt(b.state, T0 + 5000);
  assert.equal(ab.ok, true);
  assert.equal(ab.historyEntry.type, 'abandoned');
  assert.equal(ab.state.unlocksUsed, 0);
  assert.equal(ab.state.attempt, null);
  // stale attempt is dropped by normalizeState and reported
  const n = L.normalizeState(b.state, T0 + 16 * MIN, S);
  assert.equal(n.state.attempt, null);
  assert.equal(n.abandonedAttempt.id, 'a1');
  assert.equal(n.state.unlocksUsed, 0);
});

test('escalating delay per unlock that day', () => {
  assert.equal(L.requiredCountdown(S, 0), 30);
  assert.equal(L.requiredCountdown(S, 1), 60);
  assert.equal(L.requiredCountdown(S, 2), 120);
  assert.equal(L.requiredCountdown(S, 9), 120);
  let st = fresh(T0);
  const first = L.beginAttempt(st, S, T0, 'p');
  assert.equal(first.attempt.countdownSec, 30);
  assert.equal(first.attempt.breathingSec, 30);
  st.unlocksUsed = 1;
  assert.equal(L.beginAttempt(st, S, T0, 'q').attempt.countdownSec, 60);
  st.unlocksUsed = 2;
  assert.equal(L.beginAttempt(st, S, T0, 'r').attempt.countdownSec, 120);
  assert.equal(L.getStatus(st, S, T0).nextCountdownSec, 120);
});

test('completion refused when too early, wrong id, or invalid intent', () => {
  const st = fresh(T0);
  const b = L.beginAttempt(st, S, T0, 'a1');
  const need = (30 + 30) * 1000;
  let c = L.completeAttempt(b.state, S, 'a1', GOOD, T0 + need - 1, []);
  assert.deepEqual([c.ok, c.reason], [false, 'too-early']);
  assert.equal(c.state.unlocksUsed, 0);
  c = L.completeAttempt(b.state, S, 'other', GOOD, T0 + need, []);
  assert.deepEqual([c.ok, c.reason], [false, 'no-attempt']);
  c = L.completeAttempt(b.state, S, 'a1', 'short', T0 + need, []);
  assert.deepEqual([c.ok, c.reason], [false, 'intent']);
  c = L.completeAttempt(b.state, S, 'a1', GOOD, T0 + need, []);
  assert.equal(c.ok, true);
  assert.equal(c.state.unlockedUntil, T0 + need + 10 * MIN);
  assert.equal(c.historyEntry.text, GOOD);
});

test('unlock expiry and auto-relock', () => {
  const { c, end } = unlockAt(fresh(T0), T0, GOOD);
  const until = c.state.unlockedUntil;
  assert.equal(until, end + 10 * MIN);
  assert.equal(L.isUnlocked(c.state, until - 1), true);
  assert.equal(L.isUnlocked(c.state, until), false);
  const n = L.normalizeState(c.state, until, S);
  assert.equal(n.state.unlockedUntil, 0);
  assert.equal(n.expiredUnlock, true);
  assert.equal(L.getStatus(c.state, S, until - 1).locked, false);
  assert.equal(L.getStatus(c.state, S, until).locked, true);
  // cannot start another unlock while one runs
  assert.equal(L.beginAttempt(c.state, S, until - 1, 'n').reason, 'already-unlocked');
});

test('unlock spanning day rollover stays active until expiry', () => {
  const start = Date.UTC(2026, 0, 16, 3, 55, 0);
  let st = fresh(start);
  st.unlockedUntil = start + 10 * MIN; // ends 04:05
  st.unlocksUsed = 2;
  const n = L.normalizeState(st, Date.UTC(2026, 0, 16, 4, 1, 0), S);
  assert.equal(n.state.unlocksUsed, 0);
  assert.equal(L.isUnlocked(n.state, n.now), true);
});

test('clock set-back neither extends an unlock nor reopens the day', () => {
  const st = fresh(T0);
  st.unlockedUntil = T0 + 5 * MIN;
  st.unlocksUsed = 3;
  const later = L.normalizeState(st, T0 + 6 * MIN, S).state; // expired, lastSeen advanced
  assert.equal(later.unlockedUntil, 0);
  const back = L.normalizeState(later, T0 - 2 * HOUR, S);
  assert.equal(back.now, T0 + 6 * MIN);
  assert.equal(back.state.unlockedUntil, 0);
  assert.equal(back.state.unlocksUsed, 3);
  // set back by a whole day: day key does not move back
  const dayBack = L.normalizeState(later, T0 - 30 * HOUR, S);
  assert.equal(dayBack.state.unlocksUsed, 3);
});

test('validateIntent rules', () => {
  assert.equal(L.validateIntent('too short', S, []).ok, false);
  assert.equal(L.validateIntent('averyveryverylongsingleword', S, []).ok, false);
  assert.equal(L.validateIntent('aaaaaa aaaaaa', S, []).ok, false);
  assert.equal(L.validateIntent('ab ab ab ab ab', S, []).ok, false);
  assert.equal(L.validateIntent('   ', S, []).ok, false);
  assert.equal(L.validateIntent(GOOD, S, []).ok, true);
  const dup = L.validateIntent('  The 3Blue1Brown   VIDEO about neural networks ', S, [GOOD]);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /24 hours/);
  assert.equal(L.validateIntent('a different lecture on topology', S, [GOOD]).ok, true);
});

test('recentIntents only returns unlock text from the last 24h', () => {
  const h = [
    { ts: T0 - 25 * HOUR, type: 'unlock', text: 'old one here ok' },
    { ts: T0 - HOUR, type: 'unlock', text: 'recent one here ok' },
    { ts: T0 - HOUR, type: 'search', text: 'not an intent' }
  ];
  assert.deepEqual(L.recentIntents(h, T0), ['recent one here ok']);
});

test('isWeakening per key', () => {
  assert.equal(L.isWeakening('dailyUnlockLimit', 3, 5), true);
  assert.equal(L.isWeakening('dailyUnlockLimit', 3, 2), false);
  assert.equal(L.isWeakening('unlockMinutes', 10, 15), true);
  assert.equal(L.isWeakening('unlockMinutes', 10, 5), false);
  assert.equal(L.isWeakening('countdownSeconds', [30, 60, 120], [30, 60, 100]), true);
  assert.equal(L.isWeakening('countdownSeconds', [30, 60, 120], [30, 60]), true);
  assert.equal(L.isWeakening('countdownSeconds', [30, 60, 120], [40, 60, 120, 200]), false);
  assert.equal(L.isWeakening('countdownSeconds', [30], [30, 0, 0]), true);
  assert.equal(L.isWeakening('countdownSeconds', [30], [30, 0]), true);
  assert.equal(L.isWeakening('countdownSeconds', [30], [30, 60]), false);
  assert.equal(L.isWeakening('countdownSeconds', [30, 60, 120], [30, 60, 120, 5]), true);
  assert.equal(L.isWeakening('intentMinChars', 12, 6), true);
  assert.equal(L.isWeakening('breathingCycles', 3, 4), false);
  assert.equal(L.isWeakening('blockShorts', true, false), true);
  assert.equal(L.isWeakening('blockShorts', false, true), false);
  assert.equal(L.isWeakening('shortsWithUnlock', false, true), true);
  assert.equal(L.isWeakening('shortsWithUnlock', true, false), false);
  assert.equal(L.isWeakening('dayStartHour', 4, 5), true);
  assert.equal(L.isWeakening('logIntents', true, false), true);
  assert.equal(L.isWeakening('historyMax', 500, 100), false);
  assert.equal(L.isWeakening('dailyUnlockLimit', 3, 3), false);
});

test('settings changes: strengthening now, weakening after 24h, same-key replacement', () => {
  const r = L.requestSettingsChange(S, [], { dailyUnlockLimit: 5, unlockMinutes: 5, historyMax: 300 }, T0, 'c1');
  assert.equal(r.settings.dailyUnlockLimit, 3, 'weakening not applied');
  assert.equal(r.settings.unlockMinutes, 5, 'strengthening applied');
  assert.equal(r.settings.historyMax, 300);
  assert.deepEqual(r.queued, ['dailyUnlockLimit']);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].effectiveAt, T0 + 24 * HOUR);
  assert.equal(L.PENDING_DELAY_MS, 24 * HOUR);

  // same key again resets only that key's timer
  const r2 = L.requestSettingsChange(r.settings, r.pending, { dailyUnlockLimit: 8 }, T0 + HOUR, 'c2');
  assert.equal(r2.pending.length, 1);
  assert.equal(r2.pending[0].to, 8);
  assert.equal(r2.pending[0].effectiveAt, T0 + 25 * HOUR);

  // returning to the current value clears the pending entry
  const r3 = L.requestSettingsChange(r2.settings, r2.pending, { dailyUnlockLimit: 3 }, T0 + 2 * HOUR, 'c3');
  assert.equal(r3.pending.length, 0);

  // invalid values are rejected
  const r4 = L.requestSettingsChange(S, [], { dailyUnlockLimit: -1, bogus: 1, countdownSeconds: 'x' }, T0, 'c4');
  assert.deepEqual(r4.rejected.sort(), ['bogus', 'countdownSeconds', 'dailyUnlockLimit']);
  assert.equal(r4.pending.length, 0);
});

test('applyDuePending and cancelPending', () => {
  const r = L.requestSettingsChange(S, [], { dailyUnlockLimit: 5, unlockMinutes: 20 }, T0, 'c');
  assert.equal(r.pending.length, 2);
  const before = L.applyDuePending(r.settings, r.pending, T0 + 24 * HOUR - 1);
  assert.equal(before.settings.dailyUnlockLimit, 3);
  assert.equal(before.applied.length, 0);
  const after = L.applyDuePending(r.settings, r.pending, T0 + 24 * HOUR);
  assert.equal(after.settings.dailyUnlockLimit, 5);
  assert.equal(after.settings.unlockMinutes, 20);
  assert.equal(after.pending.length, 0);
  const cancelled = L.cancelPending(r.pending, r.pending[0].id);
  assert.equal(cancelled.length, 1);
  assert.equal(L.nextDueTime({ unlockedUntil: T0 + MIN }, r.pending), T0 + MIN);
  assert.equal(L.nextDueTime({ unlockedUntil: 0 }, []), null);
});

test('classifyUrl and shouldBlock', () => {
  const locked = { unlockedUntil: 0 };
  const open = { unlockedUntil: T0 + MIN };
  const cases = [
    ['https://www.youtube.com/', 'home', 'feed'],
    ['https://www.youtube.com/?foo=1', 'home', 'feed'],
    ['https://m.youtube.com/', 'home', 'feed'],
    ['https://www.youtube.com/feed/subscriptions', 'feed', 'feed'],
    ['https://www.youtube.com/feed/trending', 'feed', 'feed'],
    ['https://www.youtube.com/shorts/abc', 'shorts', 'shorts'],
    ['https://www.youtube.com/watch?v=x', 'watch', null],
    ['https://www.youtube.com/results?search_query=y', 'search', null],
    ['https://www.youtube.com/@chan', 'other', null],
    ['https://www.youtube.com/feed/history', 'other', null],
    ['https://example.com/', 'other', null],
    ['not a url', 'other', null]
  ];
  for (const [url, kind, gated] of cases) {
    const c = L.classifyUrl(url, S);
    assert.deepEqual([url, c.kind, c.gated], [url, kind, gated]);
  }
  const home = L.classifyUrl('https://www.youtube.com/', S);
  assert.equal(L.shouldBlock(home, locked, S, T0), true);
  assert.equal(L.shouldBlock(home, open, S, T0), false);
  const sh = L.classifyUrl('https://www.youtube.com/shorts/abc', S);
  assert.equal(L.shouldBlock(sh, open, S, T0), true, 'shorts blocked even when unlocked by default');
  assert.equal(L.shouldBlock(sh, open, Object.assign({}, S, { shortsWithUnlock: true }), T0), false);
  assert.equal(L.shouldBlock(sh, locked, Object.assign({}, S, { shortsWithUnlock: true }), T0), true);
  const noSubs = Object.assign({}, S, { blockSubscriptions: false });
  assert.equal(L.classifyUrl('https://www.youtube.com/feed/subscriptions', noSubs).gated, null);
  assert.equal(L.shouldBlock(L.classifyUrl('https://www.youtube.com/watch?v=x', S), locked, S, T0), false);
});

test('appendHistory cap and watch dedup', () => {
  const small = Object.assign({}, S, { historyMax: 3 });
  let h = [];
  for (let i = 0; i < 5; i++) h = L.appendHistory(h, { ts: T0 + i, type: 'search', text: 's' + i }, small);
  assert.deepEqual(h.map((e) => e.text), ['s2', 's3', 's4']);
  let w = L.appendHistory([], { ts: T0, type: 'watch', videoId: 'v1' }, S);
  w = L.appendHistory(w, { ts: T0 + 5 * MIN, type: 'watch', videoId: 'v1' }, S);
  assert.equal(w.length, 1);
  w = L.appendHistory(w, { ts: T0 + 11 * MIN, type: 'watch', videoId: 'v1' }, S);
  assert.equal(w.length, 2);
  w = L.appendHistory(w, { ts: T0 + 11 * MIN, type: 'watch', videoId: 'v2' }, S);
  assert.equal(w.length, 3);
});

test('summarizeHistory', () => {
  const h = [
    { ts: T0, type: 'unlock', text: 'a b c d e f', dayKey: '2026-01-15' },
    { ts: T0, type: 'unlock', text: 'g h i j k l', dayKey: '2026-01-14' },
    { ts: T0, type: 'abandoned', dayKey: '2026-01-15' }
  ];
  const s = L.summarizeHistory(h, T0, S);
  assert.equal(s.abandoned, 1);
  assert.equal(s.last7Days, 2);
  assert.deepEqual(s.topIntentsToday, ['a b c d e f']);
  assert.equal(s.unlocksByDay['2026-01-14'], 1);
});

test('mergeSettings falls back to defaults on invalid stored values', () => {
  const m = L.mergeSettings({ dailyUnlockLimit: 'x', unlockMinutes: 15 });
  assert.equal(m.dailyUnlockLimit, 3);
  assert.equal(m.unlockMinutes, 15);
});

test('UMD: loads in a self-only (worker / content script) context', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'guard-logic.js'), 'utf8');
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.equal(typeof sandbox.UnhookGuardLogic.getStatus, 'function');
});
