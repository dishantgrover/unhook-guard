# Unhook Guard

## Why this exists

I built this to add more friction to my own YouTube addiction. Unhook hides the feed, but bringing it back is one tap, and I kept doing that out of habit. This extension puts a deliberate pause in front of the feed, so I open YouTube when I have something specific to watch and not because the algorithm is leading me. It is a personal tool shared as is, and it is not affiliated with Unhook.

## What it is

A small Manifest V3 companion to the Unhook extension. It adds friction (ScreenZen style) before the YouTube feed can be shown, so YouTube is used when you have something specific to watch.

It is friction against impulse, not a lock. You can always disable or remove it in `arc://extensions`. See "Known limitations".

## What Unhook does

Unhook is a browser extension that removes distracting parts of YouTube, such as the home feed, Shorts, recommended videos and end-screen suggestions. See FINDINGS.md for more detail.

- Settings live in `chrome.storage.sync` under keys such as `yt_on` (main switch), `hide_feed`, `hide_shorts`, `hide_recommended`, `hide_endscreen`.
- Its content script copies each `hide_*` value onto `<html>` as an attribute; static CSS keyed on those attributes hides elements. When `yt_on` turns false it removes the attributes.
- All controls are in a toolbar popup with no options page. One checkbox click (`#yt_on` or `#hide_feed`) brings the feed back, with no confirmation.
- Another extension cannot read or write Unhook's storage and cannot intercept a toolbar popup. Unhook's EULA also forbids modifying it. So the toggle itself cannot be gated.

## Architecture and why

A separate guard extension that hides the feed by its own CSS regardless of Unhook's state, and owns the only path back. Tapping Unhook's toggle then changes nothing on its own. Unhook is untouched, keeps updating, and keeps doing the rest (autoplay, comments, and so on). A patched copy of Unhook was rejected (EULA, no updates, minified code, new extension id).

Parts:
- `lib/guard-logic.js`: pure friction/state logic (also runs under node for tests).
- `background/service-worker.js`: the only writer of state; enforces timing server-side.
- `content/`: hides feed, Shorts, related videos and end screens; shows the lock overlay.
- `interstitial/`: intent, countdown, breathing, two confirms.
- `options/`: settings, pending changes, stats, history. `popup/`: status, start unlock, lock now.

## Behavior (defaults)

- Blocked while locked: home, subscriptions, trending/explore, gaming, hashtag pages, Shorts. Watch-page related column, end screens and pause overlays are hidden. Shorts shelves are hidden in results.
- Always allowed without friction: direct video links, searches (including the YouTube search box), channel pages, history and library. Watch visits and overlay searches are logged.
- Unlock flow: intent ("What are you here to watch?", at least 12 characters and 2 words, not filler, not identical to one used in the last 24 h) then countdown (30 s, then 60 s, then 120 s for the 1st, 2nd and 3rd unlock of the day; pauses while the tab is hidden) then 30 s breathing then "Is this on your list?" then "Final check" (the "Never mind" button is large and focused).
- 3 unlocks per day (day resets at 04:00 local). Each unlock lasts 10 minutes, then re-locks, even in tabs that are already open. Stopping at any step costs nothing and is counted as "times you stopped yourself".
- Shorts stay blocked even during an unlock.
- The worker rejects completion before the countdown plus breathing time has passed, so the page cannot be skipped by calling the worker directly.
- Settings protection: changes that make the guard stricter apply at once. Changes that weaken it (higher limit, longer unlock, shorter countdown, and so on) wait 24 hours and can be cancelled. The 24 h delay itself is not configurable. Clearing history is allowed but counted in the stats.

## Install

Works in Chromium-based desktop browsers (Arc, Chrome, Edge, Brave). It is not on the Chrome Web Store, so you load it as an unpacked extension. It does not sync between devices, so repeat these steps on each one.

1. Get the code:
   ```
   git clone https://github.com/dishantgrover/unhook-guard.git
   ```
   Or use "Code > Download ZIP" on GitHub and unzip it. Keep the folder somewhere permanent, because the browser loads the extension from it.
2. Open the extensions page: `arc://extensions`, `chrome://extensions`, `edge://extensions` or `brave://extensions`.
3. Turn on Developer mode (toggle at the top right in Chrome, Edge and Brave).
4. Click Load unpacked and choose the `unhook-guard` folder (the one containing `manifest.json`).
5. Confirm the Unhook Guard card shows no errors. Pin it from the puzzle-piece menu if you want the toolbar icon.
6. Reload any YouTube tabs that were already open. Extensions are not added to tabs that were open before install.
7. Recommended: on the extension's Details page, turn on "Allow in Incognito" (or the private-window option), otherwise a private window bypasses it.
8. Optional: in Unhook's popup, turn off "Hide Home Feed", so the feed shows during an unlock.

### Update

```
git pull
```
Then click the reload icon on the Unhook Guard card in the extensions page.

### Phones and other browsers

Chrome on Android and iOS cannot run extensions. Firefox and Safari need a ported manifest and are not supported yet.

Recommended: in `arc://extensions` > Unhook Guard > Details, turn on "Allow in Incognito" (and Arc's equivalent for private windows), otherwise a private window bypasses it.

## Configure

Click the toolbar icon > Settings and history (or Details > Extension options). Fields are explained on the page.

## Uninstall

`arc://extensions` > Unhook Guard > Remove. Unhook is unaffected.

## Permissions (all justified)

| Permission | Why |
|---|---|
| `storage` | All data in `chrome.storage.local`. |
| `alarms` | Wakes the worker at unlock expiry and when a delayed settings change is due. Expiry is judged from timestamps, so a missed alarm cannot keep the feed open. |
| Content script on `https://www.youtube.com/*` and `https://m.youtube.com/*` | Hiding CSS and the overlay. The only site access. |

Not requested: `tabs`, `management`, `webRequest`, `declarativeNetRequest`, `scripting`, `<all_urls>`. No remote code, no network calls, no analytics, no build step.

## Known limitations

- You can disable or remove the extension in `arc://extensions`. Optionally ask a friend to set the Mac login or Screen Time passcode so that you cannot do it on impulse.
- The guard cannot block taps inside Unhook's popup. During a 10 minute unlock the feed appears only if Unhook's own "Hide Home Feed" is also off. Consider turning that off for good, since the guard now does that job.
- Moving the system clock forward 24 h makes pending weakening changes take effect. Moving it back does nothing (the guard remembers the latest time it saw).
- Other browsers, the YouTube app and a private window (unless allowed, see above) are not covered.
- Dev tools can remove the overlay on a page. YouTube's DOM changes often, so selectors in `content/content.css` may need maintenance. They were copied from Unhook 1.6.9's working CSS and were not checked against live YouTube. Channel-page recommendation shelves are not hidden.
- The YouTube masthead search is not logged.

## Tests

- `npm test` (or `TZ=UTC node --test test/*.test.js`): logic unit tests.
- `node scripts/check.js`: JSON parse, syntax check, manifest references.
- `node scripts/make-icons.js`: regenerates placeholder icons.
- `.agents/tasks/runtime-check.js`: headless Chromium run against a local fixture (see `.agents/tasks/verification.md`).

## Manual test checklist for Arc

1. Load unpacked; no errors on the card.
2. Open youtube.com: overlay appears, no feed flash.
3. Search from the overlay: results load; no Shorts shelf.
4. Open a `watch?v=` link: video plays, no related column or end-screen cards.
5. Press "Unlock the feed...": short text is rejected; the countdown pauses on another tab; breathing and both confirms appear; "Never mind" returns to YouTube and uses no unlock.
6. Complete an unlock: the feed route opens (with Unhook hiding on it may still look empty). After 10 minutes the overlay returns without reload.
7. Use 3 unlocks: the 4th attempt shows "No unlocks left today".
8. Options: raise the daily limit, see "Waiting 24 hours" and a Cancel button. Lower it, see it apply now.
9. Toggle Unhook off and on while locked: nothing changes on youtube.com.
10. From a watch page click the YouTube logo: overlay appears without reload.
11. Click a Short: blocked page.
12. Disable the guard: Unhook behaves as before.

## Defaults to confirm

1. 3 unlocks per day, 10 minutes each, countdown 30/60/120 s, 30 s breathing.
2. Direct video links and searches have no friction.
3. Subscriptions feed is locked.
4. Shorts stay blocked even during an unlock.
5. 24 h delay for weakening settings (versus requiring the full flow).
6. Channel pages and history stay open.
7. Whether to turn off Unhook's own "Hide Home Feed".
8. Day resets at 04:00.
9. Private windows: allow the extension there (recommended) or not.
10. Intent minimum: 12 characters, 2 words.


## Test status

Tested only in headless Chrome for Testing against a local fixture, plus unit tests under node. It has not been run in Arc or against the real youtube.com. See `.agents/tasks/verification.md`.
