# Implementation plan: Unhook Guard

Read `FINDINGS.md` first. Short version: Unhook's controls are a toolbar popup and its storage (`chrome.storage.sync`) cannot be read or written by another extension, so the guard cannot gate the toggle. It makes the toggle irrelevant instead.

## 1. Architecture decision

New standalone MV3 extension in `/Users/dishantg/Documents/Skills/unhook-guard/`. It:

1. Hides the home feed, other recommendation feeds, Shorts, watch-page related videos, end screens and pause overlays on youtube.com **by its own CSS, fail-closed**, regardless of Unhook's state.
2. Replaces blocked pages (home, feeds, Shorts) with a small overlay: "Feed is locked. Search for what you want to watch, or start an unlock." Unlock opens an interstitial extension page.
3. Grants a temporary unlock (10 min) only after the friction flow. After expiry it re-locks.
4. Protects its own settings with a 24h delay for any weakening change.
5. Does not touch Unhook, does not request `management`, does not use declarativeNetRequest, no web-accessible resources.

Why not the patched copy: EULA forbids modification, loses updates, minified code, new id/storage. Kept only as a documented fallback.

Decisions made on the user's behalf are listed in section 12.

## 2. File layout

```
unhook-guard/
  manifest.json
  README.md
  FINDINGS.md                      (already written)
  package.json                     (only {"private":true,"scripts":{"test":"node --test test/","check":"node scripts/check.js"}}; no dependencies)
  background/service-worker.js     (classic worker; importScripts('../lib/guard-logic.js'))
  lib/guard-logic.js               (pure logic, UMD, loads in worker, pages, content script, node)
  content/content.js               (route detection, attributes, overlay)
  content/content.css              (fail-closed hiding, keyed on html attributes)
  interstitial/interstitial.html
  interstitial/interstitial.js
  interstitial/interstitial.css
  options/options.html
  options/options.js
  options/options.css
  popup/popup.html                 (tiny status + "Lock now" + "Start unlock")
  popup/popup.js
  popup/popup.css
  icons/icon-16.png icon-32.png icon-48.png icon-128.png   (generated placeholders)
  scripts/make-icons.js            (node, writes plain PNGs with zlib; no deps)
  scripts/check.js                 (JSON.parse manifest, node --check every .js, verify files referenced by manifest exist)
  test/guard-logic.test.js         (node:test)
```

All JS is plain, no build step. No inline scripts (MV3 CSP).

## 3. Manifest and permissions

```json
{
  "manifest_version": 3,
  "name": "Unhook Guard",
  "version": "1.0.0",
  "minimum_chrome_version": "110",
  "description": "Adds deliberate friction before the YouTube feed can be shown. Companion to Unhook.",
  "permissions": ["storage", "alarms"],
  "background": { "service_worker": "background/service-worker.js" },
  "content_scripts": [{
    "matches": ["https://www.youtube.com/*", "https://m.youtube.com/*"],
    "js": ["lib/guard-logic.js", "content/content.js"],
    "css": ["content/content.css"],
    "run_at": "document_start",
    "all_frames": false
  }],
  "action": { "default_popup": "popup/popup.html", "default_title": "Unhook Guard" },
  "options_page": "options/options.html",
  "icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
}
```

| Permission | Why |
|---|---|
| `storage` | all state in `chrome.storage.local` |
| `alarms` | wake the worker at unlock expiry and at pending-change due time, to broadcast re-lock and apply settings. Expiry itself is checked from timestamps, so a missed alarm cannot keep the feed open. |
| content script match `https://www.youtube.com/*`, `https://m.youtube.com/*` | inject hiding CSS and the overlay. This is the only site access. |

Deliberately not requested: `tabs` (the worker uses `chrome.tabs.update(sender.tab.id, ...)` and `tabs.create`, which need no permission), `management`, `webRequest`, `declarativeNetRequest`, `scripting`, `notifications`, any `<all_urls>`. No `web_accessible_resources`: navigation to the interstitial is done by the worker with `tabs.update`, which is allowed for extension pages.

CSP: default MV3. No remote code, no `fetch`, no `XMLHttpRequest`, no network anywhere.

## 4. Friction policy (defaults)

All values live in settings and are editable only through the delayed-change rule in section 7.

| Item | Default |
|---|---|
| Daily unlock limit | 3 per day. The day rolls over at 04:00 local (`dayStartHour: 4`) so late-night sessions count on the same day. |
| Unlock duration | 10 minutes, then auto re-lock. No extension of a running unlock; a new one costs a new unlock. |
| Countdown, per unlock index of the day | 1st: 30 s, 2nd: 60 s, 3rd: 120 s (`countdownSeconds: [30,60,120]`). Index beyond the array uses the last value. |
| Countdown behavior | Not skippable. Only advances while the interstitial tab is visible (`document.visibilityState === 'visible'`); pauses when hidden. The worker also enforces a minimum elapsed wall-clock time before it accepts completion. |
| Intent prompt | "What are you here to watch? Type the exact title or topic." At least 12 characters and at least 2 words, trimmed; rejects text made of one repeated character or a recent intent copy-pasted verbatim (same normalized text within the last 24 h). Paste is allowed (a hard paste block is easy to dodge and annoying); the repeat check covers the lazy case. |
| Breathing step | 3 cycles of 4 s in / 6 s out (30 s total), animated circle, runs after the countdown. Not skippable. |
| Confirmation | Two screens. (1) "Is this on your list?" Shows the typed intent. Buttons: "Yes, this is on my list" / "No, close this". (2) "Final check. The feed will open for 10 minutes, then lock. Unlock N of 3 today." Buttons: "Open the feed" (small, grey) / "Never mind" (large, default focus). |
| Cancel path | "Never mind" at any step returns to youtube.com search; the attempt is discarded and does not use up an unlock. Only completed unlocks count. Abandoned attempts are logged as `abandoned` (shown in stats as "times you stopped yourself"). |
| After limit reached | Interstitial shows "No unlocks left today. Resets at 04:00." and a search box. No bypass inside the guard. |
| What an unlock grants | Home feed, subscriptions feed, trending/explore, watch-page sidebar/related, end screens. **Not** Shorts unless `shortsWithUnlock` is true (default false). |
| Direct watch URLs (`/watch?v=`, `youtu.be` redirected to watch, `/live/`, `/playlist?list=`) | Always allowed, no friction. Watch-page related column, end screens and pause overlay stay hidden while locked. The visit is logged as `{type:"watch", videoId}` (one log entry per video id per 10 min). |
| Searches (`/results?search_query=`) | Always allowed, no friction, including the YouTube masthead search box. Shorts shelves and horizontal shelves in results are hidden while locked. Searches typed in the guard overlay box are logged as `{type:"search", text}`. The masthead search is not logged (no safe hook, and not worth the permission). |
| Channel pages (`/@name`, `/channel/`, `/c/`), `/feed/history`, `/feed/library`, `/feed/you`, `/playlist` | Allowed. A user-chosen destination counts as "something in mind". Channel home recommendation shelves are not hidden in v1 (open question 6). |
| Blocked unless unlocked | `/` (home), `/feed/subscriptions` (setting `blockSubscriptions`, default true), `/feed/trending`, `/feed/explore`, `/gaming`, `/hashtag/*`. |
| Blocked, even when unlocked by default | `/shorts/*` (setting `blockShorts` true, `shortsWithUnlock` false). Lands on the overlay. |

## 5. Data model (`chrome.storage.local`)

```js
ug_schema: 1

ug_settings: {
  countdownSeconds: [30, 60, 120],
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
}

ug_state: {
  dayKey: "2026-01-31",        // dayKey(now, dayStartHour)
  unlocksUsed: 0,              // completed unlocks in dayKey
  unlockedUntil: 0,            // epoch ms; 0 = locked
  lastSeen: 0,                 // max Date.now() ever observed, guards against clock set-back
  attempt: null | { id, startedAt, countdownSec, breathingSec, unlockIndex }
}

ug_pending: [                  // delayed (weakening) settings changes
  { id, key, from, to, requestedAt, effectiveAt }
]

ug_history: [                  // newest last, capped by historyMax
  { ts, type: "unlock"|"abandoned"|"watch"|"search"|"relock", text?, videoId?, unlockIndex?, dayKey }
]
```

Only the service worker writes `ug_state`, `ug_pending`, `ug_history`, `ug_settings`. Content script, popup, options and interstitial read storage directly and send messages for writes. Reads in the content script use `chrome.storage.local.get` plus `storage.onChanged`.

## 6. Pure logic module: `lib/guard-logic.js`

Pattern (works as classic script, `importScripts`, content script, and `require`):

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UnhookGuardLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () { 'use strict'; /* ... */ return { ... }; }));
```

No `chrome.*`, no `Date.now()` calls inside; `now` is always a parameter. All functions are pure and return new objects.

API:

| Function | Contract |
|---|---|
| `DEFAULT_SETTINGS` | frozen object from section 5 |
| `PENDING_DELAY_MS` | `24*3600*1000` constant, not configurable |
| `dayKey(nowMs, dayStartHour)` | `YYYY-MM-DD` of the local time shifted back by `dayStartHour`. Uses local getters; tests run with `TZ=UTC`. |
| `normalizeState(state, now, settings)` | Fills defaults; applies `lastSeen = max(lastSeen, now)` and returns the effective `now`; if `dayKey` changed, resets `unlocksUsed` to 0 (does not clear an active `unlockedUntil` that spans the rollover); clears `unlockedUntil` if `<= effectiveNow`; drops attempts older than 15 min. |
| `isUnlocked(state, now)` | `state.unlockedUntil > now` |
| `requiredCountdown(settings, unlocksUsedToday)` | `countdownSeconds[min(i, len-1)]` |
| `getStatus(state, settings, now)` | `{ locked, unlockedUntil, remainingMs, unlocksUsed, unlocksLeft, canUnlock, nextCountdownSec, dayKey }`. `canUnlock` is false when `unlocksLeft <= 0` or currently unlocked. |
| `validateIntent(text, settings, recentIntents)` | `{ ok, reason }`; rules from section 4 |
| `beginAttempt(state, settings, now, id)` | refuses with `{ok:false, reason:'limit'\|'already-unlocked'}`; otherwise sets `attempt` with `countdownSec`, `breathingSec = cycles*10` |
| `completeAttempt(state, settings, attemptId, intent, now, recentIntents)` | checks the attempt id matches, `now - startedAt >= (countdownSec + breathingSec)*1000` (so the UI cannot be skipped by calling the worker directly), intent valid, limit not exceeded. On success: `unlocksUsed += 1`, `unlockedUntil = now + unlockMinutes*60000`, attempt cleared; returns `{ok, state, historyEntry}`. Otherwise `{ok:false, reason}` with no state change. |
| `abandonAttempt(state, now)` | clears attempt, returns `historyEntry` of type `abandoned` |
| `lockNow(state, now)` | sets `unlockedUntil = 0`; does not refund the unlock |
| `isWeakening(key, from, to)` | per-key rule: higher is stricter for `countdownSeconds` (elementwise), `intentMinChars`, `intentMinWords`, `breathingCycles`, `blockSubscriptions`, `blockShorts`; `historyMax` is neutral (applies immediately); lower is stricter for `dailyUnlockLimit`, `unlockMinutes`, `shortsWithUnlock`; `dayStartHour` and `logIntents` weakening = any change (treated as weakening to avoid gaming the rollover and hiding history); array length change counts as weakening if shorter |
| `requestSettingsChange(settings, pending, patch, now, id)` | splits `patch` into strengthening (applied now) and weakening (queued with `effectiveAt = now + PENDING_DELAY_MS`, replacing any earlier pending entry for the same key). Returns `{settings, pending}`. A patch that returns a key to its current value also removes its pending entry. |
| `applyDuePending(settings, pending, now)` | applies entries with `effectiveAt <= now`; returns `{settings, pending, applied}` |
| `cancelPending(pending, id)` | removes an entry (always allowed; cancelling only keeps the stricter current value) |
| `nextDueTime(state, pending)` | min of `unlockedUntil` (if >0) and pending `effectiveAt`, for alarm scheduling |
| `classifyUrl(urlString, settings)` | returns `{kind: 'home'\|'feed'\|'shorts'\|'watch'\|'search'\|'other', gated: 'feed'\|'shorts'\|null}` using `URL` parsing on `pathname`. Home = `/` or `/index`; feed = `/feed/subscriptions` (if `blockSubscriptions`), `/feed/trending`, `/feed/explore`, `/gaming`, `/hashtag/*`; shorts = `/shorts/*` (if `blockShorts`); watch = `/watch`, `/live/`, `/embed/`, `/playlist`; search = `/results`. Everything else `other` (allowed). |
| `shouldBlock(classification, state, settings, now)` | true when `gated==='feed'` and locked; true when `gated==='shorts'` and (not unlocked or not `shortsWithUnlock`) |
| `appendHistory(history, entry, settings)` | appends, trims to `historyMax`; dedups `watch` entries for same `videoId` within 10 min |
| `summarizeHistory(history, now, settings)` | `{ unlocksByDay: {key:count}, abandoned, last7Days, topIntentsToday }` for the options stats view |

## 7. Settings protection

- Options page shows current values, editable. Saving sends `ug:updateSettings` with the patch to the worker, which calls `requestSettingsChange`. Strengthening changes apply immediately; weakening changes show as "Pending: becomes active at <time>" with a Cancel button.
- Constants not user-editable: the 24h delay, `PENDING_DELAY_MS`.
- A weakening change requested while another is pending resets only that key's timer.
- Due changes are applied by the worker on startup, on every message, and by an alarm named `ug-due`. They are never applied just because the options page was opened.
- Clock set-back is neutralized by `lastSeen` (state) which the worker also uses as `now = max(Date.now(), lastSeen)`. Clock set-forward by 24 h would still apply pending changes; stated as a limitation.
- "Clear history" is allowed immediately (no delay). It records a `cleared` counter shown in stats so lapses cannot be hidden silently.

## 8. What is hidden when locked, and how

State exposed to CSS through attributes on `<html>`, set by `content.js`:
- `ug-state="locked"` or `"unlocked"` (default before storage loads: absent, and CSS treats absent as locked, so there is no flash of the feed).
- `ug-route="block"` when the current URL is gated and blocked, else `"ok"`.
- `ug-shorts="block"` when Shorts should be hidden everywhere (always true unless unlocked and `shortsWithUnlock`).

`content/content.css` (all `display:none!important`, kept in plain, readable selectors):

Route-level (robust to inner DOM changes): when `ug-route="block"` hide the whole page container so any recommendations markup is gone.
```
html:not([ug-state="unlocked"])[ug-route="block"] ytd-page-manager,
html:not([ug-state="unlocked"])[ug-route="block"] ytm-browse,
html:not([ug-state="unlocked"])[ug-route="block"] ytm-shorts-lockup-view-model-v2  /* only if present */
```
Until content.js has computed the route (first microtask at `document_start`), a conservative rule hides `ytd-browse[page-subtype="home"]` and `ytd-rich-grid-renderer` by default.

Component-level (locked state only, mirrors Unhook's selectors that were working in 1.6.9):
- Watch related column: `#secondary.ytd-watch-flexy`, `ytd-watch-next-secondary-results-renderer`, `#related`, `ytd-watch-grid #secondary`, mobile `ytm-item-section-renderer[section-identifier="related-items"]`.
- End screens and overlays: `.html5-endscreen`, `.ytp-endscreen-content`, `.ytp-ce-element`, `.ytp-fullscreen-grid`, `.ytp-pause-overlay`, `.ytp-videowall-still`, mobile `.ytp-mweb-endscreen-play-next`.
- Shorts everywhere when `ug-shorts="block"`: `ytd-reel-shelf-renderer`, `ytd-rich-shelf-renderer[is-shorts]`, `ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)`, `grid-shelf-view-model`, `ytd-video-renderer:has(a[href*="/shorts/"])`, `ytd-compact-video-renderer:has(a[href*="/shorts/"])`, `ytd-rich-item-renderer:has(a[href*="/shorts/"])`, `yt-chip-cloud-chip-renderer:has(yt-formatted-string[title="Shorts"])`, `ytd-guide-entry-renderer:has(a[title="Shorts"])`, `ytd-mini-guide-entry-renderer[aria-label="Shorts"]`, `a.yt-simple-endpoint[title="Shorts"]`, mobile `ytm-reel-shelf-renderer`, `ytm-pivot-bar-item-renderer:has(.pivot-shorts)`.
- Home-feed entry points in the nav: `ytd-guide-entry-renderer:has(a[href="/"])`, `ytd-mini-guide-entry-renderer[aria-label="Home"]` are left visible (they lead to the overlay, which is the point).

Selector rules for robustness:
- Prefer custom element names and stable attributes (`page-subtype`, `href`, `aria-label`) over generated class names.
- Each selector in its own rule where possible, so one unsupported `:has()` (Chrome < 105) does not invalidate a whole comma list. Minimum Chrome is set to 110.
- Keep a comment block in the CSS with "last checked against YouTube on <date>" for the maintainer.

SPA navigation (`content.js`):
1. At `document_start`, compute the route from `location.href` with `classifyUrl`, set attributes immediately, then read storage and recompute.
2. Re-run on: `yt-navigate-start`, `yt-navigate-finish`, `yt-page-data-updated`, `popstate`, `hashchange` (document-level listeners, custom events are visible from the isolated world), plus a 500 ms `setInterval` comparing `location.href` as a safety net (cheap string compare). Also a `MutationObserver` on `document.documentElement` attributes is not needed.
3. On `storage.onChanged` (for `ug_state`, `ug_settings`) recompute attributes without reload. A `setTimeout` for `remainingMs` re-locks in the open tab even if the worker is asleep.
4. When the route is blocked, mount the overlay: a fixed, full-viewport element with a closed Shadow DOM (so YouTube CSS cannot affect it, and the page cannot be styled through it), `z-index: 2147483647`. Contents: heading "Your feed is locked", text input "Search YouTube for something specific" (submit navigates to `/results?search_query=...` via `location.assign`, logs a `search` entry via message), a button "Unlock the feed…" (sends `ug:openInterstitial` with `{reason:'feed', next: location.href}`; the worker does `tabs.update(sender.tab.id, {url: interstitialUrl})`), status line "Unlocks left today: N". Remove the overlay when the route is no longer blocked or the state becomes unlocked.
5. If a blocked page is reached by SPA navigation while the overlay exists, keep it (idempotent mount by element id `ug-overlay-host`).
6. The overlay is not a hard barrier against dev tools. Stated in README.

Autoplay and annotations remain Unhook's job. The guard hides end screens only.

## 9. Interstitial flow (`interstitial/*`)

URL: `interstitial/interstitial.html?next=<encoded>&reason=feed|shorts`. `next` is validated as an https youtube.com URL before use (open redirect guard). Steps, a single page with a step state machine:

1. **Status**: unlocks used today, countdown that will be required. If the limit is reached, show the no-unlocks screen with a search box.
2. **Intent**: textarea and live validation message. "Continue" stays disabled until `validateIntent` passes. Recent-intent list is fetched from `ug_history` for the repeat check.
3. **Countdown**: worker `ug:begin` is called when this step starts (returns `attempt`). Display remaining seconds, paused when the tab is hidden. "Never mind" button is large and focused.
4. **Breathing**: 3 cycles.
5. **Confirm 1 / Confirm 2** as in section 4.
6. **Done**: sends `ug:complete {attemptId, intent}`. On `ok`, navigates the tab to `next` (default `https://www.youtube.com/`). On a refusal (too early, limit, invalid), shows the reason and a restart button.

The worker is the authority; the page only renders. Closing the tab mid-flow leaves an attempt that expires after 15 min and logs `abandoned` on next `normalizeState`.

## 10. Gating Unhook's settings, with honest limits

What the guard does:
- Makes Unhook's feed toggle powerless while locked, by hiding the feed itself.
- Puts the only path to the feed behind the interstitial.
- Opens and protects its own settings via the 24h delay.

What it cannot do (to be written verbatim in README):
- It cannot block or delay clicks inside Unhook's popup. Toolbar popups cannot be intercepted by other extensions and Unhook's storage is not readable.
- During an unlock window the feed is only visible if Unhook's feed hiding is also off. If Unhook's hiding is on, he still needs to tap Unhook's toggle (no friction there), so the unlock window is slightly weaker than intended. Recommended: keep Unhook on for autoplay, annotations, comments; consider turning Unhook's "Hide Home Feed" off permanently once the guard is in place, because the guard now owns that job. This is a user choice (open question 7).
- He can disable or remove the guard in `arc://extensions`, change the system clock forward 24h, use another browser or the YouTube app, or open a private window (extensions do not run in Incognito unless "Allow in Incognito" is enabled for the guard, so Incognito is an open bypass by default; enabling that setting closes it).
- Optional stronger steps for the README: ask a friend to set the Mac Screen Time passcode or an admin password, and to block `chrome://extensions`/`arc://extensions` through Screen Time web content limits.

## 11. Service worker responsibilities (`background/service-worker.js`)

- `importScripts('../lib/guard-logic.js')`.
- Message handlers: `ug:getStatus`, `ug:openInterstitial`, `ug:begin`, `ug:complete`, `ug:abandon`, `ug:lockNow`, `ug:updateSettings`, `ug:cancelPending`, `ug:logSearch`, `ug:logWatch`, `ug:clearHistory`. Validate `sender.id === chrome.runtime.id` and the message shape; ignore everything else. Content-script messages are accepted only for `openInterstitial`, `logSearch`, `logWatch`, `getStatus`.
- Serialize storage writes through a promise queue so concurrent messages do not lose updates.
- `chrome.runtime.onInstalled`: write defaults if missing (never overwrite existing).
- Alarms: schedule `ug-due` at `nextDueTime`; on fire, normalize state, apply due pending, append `relock` history entry, reschedule.
- Badge: optional text "ON" with a green background while unlocked, cleared when locked (`chrome.action.setBadgeText`, no extra permission).

## 12. Decisions the user should confirm

1. Daily unlock limit 3, duration 10 min, countdowns 30/60/120 s, breathing 30 s. Too strict or too soft?
2. Direct watch links and searches have no friction at all (only logged). Want a light 10 s pause on the first watch of a session instead?
3. Subscriptions feed blocked (`blockSubscriptions: true`). It is chosen by him rather than recommended; some people want it open.
4. Shorts blocked even during an unlock (`shortsWithUnlock: false`).
5. 24h delay for weakening settings. Accept, or require the full interstitial instead?
6. Channel pages and `/feed/history` stay open and their recommendation shelves are not hidden in v1.
7. Whether to turn Unhook's own "Hide Home Feed" off once the guard is installed (removes the double-switch gap).
8. Day rollover at 04:00 local.
9. Whether to allow the extension in Incognito (default no; stays a known bypass).
10. Whether to add a v2 `management` permission to auto-disable Unhook while locked. Not planned.

## 13. Test plan

Automated (no browser):
1. `node scripts/check.js`: `JSON.parse` of `manifest.json`; verify each referenced path (service worker, content scripts, css, popup, options_page, icons) exists; `node --check` on every `.js` file under the project (excluding `node_modules`, `.agents`).
2. `node --test test/` with `TZ=UTC` (set in `package.json` script: `TZ=UTC node --test test/`) covering `lib/guard-logic.js`:
   - `dayKey` rollover around `dayStartHour` (03:59 vs 04:00), DST-free under TZ=UTC.
   - Daily unlock counting: three completed unlocks succeed, fourth refused with `limit`; abandoned attempt does not count; new day resets count.
   - Escalating delay: `requiredCountdown` 30/60/120 and clamping past the array.
   - Completion refused if elapsed < countdown + breathing; accepted after; refused with wrong attempt id; refused for invalid intent.
   - Auto-relock: `isUnlocked` true at `until-1`, false at `until`; `normalizeState` clears expired unlock; an unlock spanning the day rollover stays active until expiry.
   - Clock set-back: `now` earlier than `lastSeen` does not extend an unlock or reopen the day.
   - `isWeakening` per key; `requestSettingsChange` applies strengthening immediately and queues weakening with `effectiveAt = now + 24h`; same-key replacement; returning to the current value removes pending; `applyDuePending` before and after due time; `cancelPending`.
   - `classifyUrl` and `shouldBlock` table: `/`, `/?foo=1`, `/feed/subscriptions`, `/feed/trending`, `/shorts/abc`, `/watch?v=x`, `/results?search_query=y`, `/@chan`, `/feed/history`, `m.youtube.com/`.
   - `validateIntent`: too short, one word, repeated chars, duplicate of a recent intent, valid.
   - `appendHistory` cap and watch dedup.
   - UMD load: `require('../lib/guard-logic.js')` works and `new Function` evaluation in a `self`-only context sets `UnhookGuardLogic` (simulates the worker/content script).
3. `node scripts/make-icons.js` runs and produces four PNGs with valid PNG signatures.

Runtime (try, report honestly):
- Chrome 155 is installed (`/Applications/Google Chrome.app`). Branded Chrome has restricted `--load-extension`; try `--headless=new --disable-extensions-except=... --load-extension=... --user-data-dir=<tmp>` and, if it is ignored, `--disable-features=DisableLoadExtensionCommandLineSwitch`. If the extension loads, drive `chrome-extension://<id>/interstitial/interstitial.html` through the DevTools protocol or `--screenshot`/`--dump-dom` and check the DOM. YouTube selectors cannot be verified headless without network; test the content script against a local static fixture page served from a file, with the `matches` temporarily not applicable, so this is limited to the interstitial and options pages. If it cannot load, state that no runtime verification happened. Do not install Puppeteer or Chrome for Testing system-wide.
- Never claim it works in Arc unless it was run in Arc.

Manual checklist for Arc (put in README):
1. `arc://extensions` → Developer mode → Load unpacked → select `unhook-guard`. Confirm no errors on the card.
2. Open `https://www.youtube.com/`: overlay appears, no feed flashes.
3. Search from the overlay: results load, Shorts shelf and sidebar are absent.
4. Open a `watch?v=` link: video plays, no related column, no end-screen cards.
5. Press "Unlock the feed…": intent fields reject short text; countdown pauses when switching tabs; breathing and both confirms appear; "Never mind" returns to search.
6. Complete the unlock: feed route opens (with Unhook's hiding on it will still look empty; toggle Unhook if you want to see it). After 10 minutes the overlay returns without reload.
7. Use up 3 unlocks: the fourth shows "No unlocks left".
8. Options: lower the daily limit to 5 → "Pending, active in 24h"; raise to 2 → immediate. Cancel a pending change.
9. Toggle Unhook off and on while locked: nothing changes on youtube.com.
10. SPA check: click YouTube's Home logo from a watch page: overlay appears without a page reload.
11. Disable the guard: confirm Unhook behaves as before.

## 14. Order of work for the implementer

1. `lib/guard-logic.js` + `test/guard-logic.test.js` (run `TZ=UTC node --test test/`).
2. `manifest.json`, `scripts/check.js`, `scripts/make-icons.js`, icons.
3. `background/service-worker.js`.
4. `content/content.css` + `content/content.js`.
5. `interstitial/*`.
6. `options/*` and `popup/*`.
7. `README.md` (Unhook findings summary, architecture, install in Arc, configure, uninstall via `arc://extensions` → Remove, known limitations from section 10, manual checklist).
8. Run `node scripts/check.js` and the tests; attempt the runtime check; report what was and was not verified.

Inclusive language: use "allowlist/denylist" (or "blocked/allowed") and avoid primary/replica alternatives other than the neutral wording; never the non-inclusive terms in code, comments or docs.
