'use strict';
// Unhook Guard service worker. The only writer of ug_state, ug_settings, ug_pending and ug_history.
importScripts('../lib/guard-logic.js');

const L = self.UnhookGuardLogic;
const K = { SCHEMA: 'ug_schema', SETTINGS: 'ug_settings', STATE: 'ug_state', PENDING: 'ug_pending', HISTORY: 'ug_history' };
const ALARM = 'ug-due';
const INTERSTITIAL_PATH = 'interstitial/interstitial.html';

// Messages that content scripts running on youtube.com may send.
const CONTENT_ALLOWED = new Set(['ug:getStatus', 'ug:openInterstitial', 'ug:logSearch', 'ug:logWatch']);

let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(() => fn());
  queue = p.catch(() => {});
  return p;
}

function newId() {
  const a = new Uint32Array(3);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => n.toString(36)).join('');
}

// Loads storage, normalizes it against the effective clock and applies due settings changes.
async function load() {
  const raw = await chrome.storage.local.get([K.SETTINGS, K.STATE, K.PENDING, K.HISTORY]);
  let settings = L.mergeSettings(raw[K.SETTINGS]);
  let pending = Array.isArray(raw[K.PENDING]) ? raw[K.PENDING] : [];
  let history = Array.isArray(raw[K.HISTORY]) ? raw[K.HISTORY] : [];
  const real = Date.now();

  const n0 = L.normalizeState(raw[K.STATE], real, settings);
  const due = L.applyDuePending(settings, pending, n0.now);
  settings = due.settings;
  pending = due.pending;
  // If dayStartHour changed through a due pending entry, re-normalize with the new settings.
  const n = L.normalizeState(n0.state, n0.now, settings);
  const ctx = { settings, pending, history, state: n.state, now: n.now, appliedPending: due.applied };

  if (n0.expiredUnlock) {
    ctx.history = L.appendHistory(ctx.history, { ts: n.now, type: 'relock', dayKey: ctx.state.dayKey }, settings);
  }
  const abandoned = n0.abandonedAttempt;
  if (abandoned) {
    ctx.history = L.appendHistory(ctx.history, {
      ts: n.now, type: 'abandoned', unlockIndex: abandoned.unlockIndex, dayKey: ctx.state.dayKey
    }, settings);
  }
  return ctx;
}

async function save(ctx) {
  await chrome.storage.local.set({
    [K.SCHEMA]: 1,
    [K.SETTINGS]: ctx.settings,
    [K.STATE]: ctx.state,
    [K.PENDING]: ctx.pending,
    [K.HISTORY]: ctx.history
  });
}

async function schedule(ctx) {
  const t = L.nextDueTime(ctx.state, ctx.pending);
  if (t === null) { await chrome.alarms.clear(ALARM); return; }
  // `when` must be in the future; the alarm only wakes the worker. Expiry itself is judged from timestamps.
  chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, t + 500) });
}

async function updateBadge(ctx) {
  const unlocked = L.isUnlocked(ctx.state, ctx.now);
  await chrome.action.setBadgeText({ text: unlocked ? 'ON' : '' });
  if (unlocked) await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
}

// Runs `mutator(ctx)` under the write queue, then persists, schedules and updates the badge.
function withCtx(mutator) {
  return serial(async () => {
    const ctx = await load();
    const result = await mutator(ctx);
    await save(ctx);
    await schedule(ctx);
    await updateBadge(ctx);
    return result;
  });
}

function statusPayload(ctx) {
  return {
    status: L.getStatus(ctx.state, ctx.settings, ctx.now),
    settings: ctx.settings,
    pending: ctx.pending,
    recentIntents: L.recentIntents(ctx.history, ctx.now),
    attempt: ctx.state.attempt,
    now: ctx.now
  };
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Only https youtube.com targets are accepted as a post-unlock destination.
function safeNext(next) {
  try {
    const u = new URL(next);
    if (u.protocol === 'https:' && (u.hostname === 'www.youtube.com' || u.hostname === 'm.youtube.com')) return u.href;
  } catch (e) { /* fall through */ }
  return 'https://www.youtube.com/';
}

async function openInterstitial(msg, sender) {
  const reason = msg.reason === 'shorts' ? 'shorts' : 'feed';
  const next = reason === 'shorts' ? 'https://www.youtube.com/' : safeNext(msg.next);
  const url = chrome.runtime.getURL(INTERSTITIAL_PATH) + '?reason=' + reason + '&next=' + encodeURIComponent(next);
  if (sender.tab && sender.tab.id !== undefined) await chrome.tabs.update(sender.tab.id, { url });
  else await chrome.tabs.create({ url });
  return { ok: true };
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'ug:getStatus':
      return withCtx(async (ctx) => statusPayload(ctx));

    case 'ug:openInterstitial':
      return openInterstitial(msg, sender);

    case 'ug:begin':
      return withCtx(async (ctx) => {
        const r = L.beginAttempt(ctx.state, ctx.settings, ctx.now, newId());
        if (!r.ok) return { ok: false, reason: r.reason };
        ctx.state = r.state;
        return { ok: true, attempt: r.attempt };
      });

    case 'ug:complete':
      return withCtx(async (ctx) => {
        const recent = L.recentIntents(ctx.history, ctx.now);
        const r = L.completeAttempt(ctx.state, ctx.settings, String(msg.attemptId), String(msg.intent || ''), ctx.now, recent);
        ctx.state = r.state;
        if (!r.ok) return { ok: false, reason: r.reason };
        ctx.history = L.appendHistory(ctx.history, r.historyEntry, ctx.settings);
        return { ok: true, unlockedUntil: r.state.unlockedUntil };
      });

    case 'ug:abandon':
      return withCtx(async (ctx) => {
        const r = L.abandonAttempt(ctx.state, ctx.now);
        ctx.state = r.state;
        if (r.ok) ctx.history = L.appendHistory(ctx.history, r.historyEntry, ctx.settings);
        return { ok: true };
      });

    case 'ug:lockNow':
      return withCtx(async (ctx) => {
        const r = L.lockNow(ctx.state, ctx.now);
        ctx.state = r.state;
        if (r.wasUnlocked) ctx.history = L.appendHistory(ctx.history, { ts: ctx.now, type: 'relock', dayKey: ctx.state.dayKey }, ctx.settings);
        return { ok: true };
      });

    case 'ug:updateSettings':
      return withCtx(async (ctx) => {
        const r = L.requestSettingsChange(ctx.settings, ctx.pending, msg.patch || {}, ctx.now, newId());
        ctx.settings = r.settings;
        ctx.pending = r.pending;
        if (r.appliedNow.indexOf('dayStartHour') !== -1) ctx.state.dayKey = L.dayKey(ctx.now, ctx.settings.dayStartHour);
        return { ok: true, queued: r.queued, appliedNow: r.appliedNow, rejected: r.rejected };
      });

    case 'ug:cancelPending':
      return withCtx(async (ctx) => {
        ctx.pending = L.cancelPending(ctx.pending, String(msg.id));
        return { ok: true };
      });

    case 'ug:logSearch':
      return withCtx(async (ctx) => {
        const text = cleanText(msg.text, 200);
        if (text && ctx.settings.logIntents) {
          ctx.history = L.appendHistory(ctx.history, { ts: ctx.now, type: 'search', text, dayKey: ctx.state.dayKey }, ctx.settings);
        }
        return { ok: true };
      });

    case 'ug:logWatch':
      return withCtx(async (ctx) => {
        const videoId = cleanText(msg.videoId, 20);
        if (/^[\w-]{6,20}$/.test(videoId) && ctx.settings.logIntents) {
          ctx.history = L.appendHistory(ctx.history, { ts: ctx.now, type: 'watch', videoId, dayKey: ctx.state.dayKey }, ctx.settings);
        }
        return { ok: true };
      });

    case 'ug:clearHistory':
      return withCtx(async (ctx) => {
        ctx.history = [];
        ctx.state.clearedCount = (ctx.state.clearedCount || 0) + 1;
        return { ok: true };
      });

    default:
      return { ok: false, reason: 'unknown-message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string' || msg.type.indexOf('ug:') !== 0) return false;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.indexOf(chrome.runtime.getURL('')) === 0;
  if (!fromExtensionPage && !CONTENT_ALLOWED.has(msg.type)) {
    sendResponse({ ok: false, reason: 'not-allowed' });
    return false;
  }
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e && e.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) withCtx(async () => {}).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { withCtx(async () => {}).catch(() => {}); });

chrome.runtime.onInstalled.addListener(() => {
  // load() merges defaults; withCtx writes them. Existing values are kept.
  withCtx(async () => {}).catch(() => {});
});
