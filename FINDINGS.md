# Findings: how Unhook works and what a separate guard extension can do

Investigated read-only. Unhook was not modified.

## 1. Where the extension actually is

The path in the brief does not exist. The real location is the `Profile 1` directory:

`/Users/dishantg/Library/Application Support/Arc/User Data/Profile 1/Extensions/khncfooichmfjbepaaaebmommgaepoid/1.6.9_0/`

(Arc's `Profile` folder has no `extensions` dir; the folder is `Extensions`, capital E, under `Profile 1`.) Only one version exists: **1.6.9**. Unhook's settings are also under `Profile 1/Sync Extension Settings/` and `Local Extension Settings/` (see storage below).

Files (all minified except HTML/CSS): `manifest.json`, `popup.html`, `donate.html`, `troubleshoot.html`, `js/background.js`, `js/content.js`, `js/unhook-yt.js`, `js/popup.js`, `js/info-popup.js`, `css/content.css`, `css/popup.css`, `css/info-popup.css`, `LICENSE.txt`.

## 2. Unhook structure (evidence)

### manifest.json
- `manifest_version: 3`; `permissions: ["storage","webRequest"]`; `host_permissions`: `https://www.youtube.com/*`, `https://m.youtube.com/*`.
- `action.default_popup: "popup.html"`. **There is no options page** (no `options_page` / `options_ui`). All controls live in the toolbar popup.
- `background.service_worker: /js/background.js`.
- One content script on `www.youtube.com` and `m.youtube.com`: `js/content.js` + `css/content.css`, `run_at: document_start`, `all_frames: true`.
- `web_accessible_resources`: only `/js/unhook-yt.js`, only to the two YouTube origins. So `popup.html` is not web accessible.
- Has a pinned `key`, so the id is stable: `khncfooichmfjbepaaaebmommgaepoid`.
- `LICENSE.txt` is an EULA that says you may not modify or create derivative works of the Software.

### Settings storage (js/popup.js, js/content.js, js/background.js)
Every file opens with the same helper: `e=t.storage.local; "object"==typeof t.storage.sync && (e=t.storage.sync)`. In Chromium `storage.sync` always exists, so **settings live in `chrome.storage.sync`**; `storage.local` is only a fallback when a sync call errors (`runtime.lastError`). That matches the `Sync Extension Settings/khncfooichmfjbepaaaebmommgaepoid` directory.

Keys (defaults object `r` in `background.js`):

| Key | Default | Meaning |
|---|---|---|
| `yt_on` | true | main on/off switch |
| `hide_feed` | true | hide home feed |
| `hide_redirect_home` | false | redirect home to /feed/subscriptions |
| `hide_sidebar`, `hide_recommended` | true, true | watch-page sidebar / related |
| `hide_chat`, `hide_playlists`, `hide_donate`, `hide_merch`, `hide_notifs`, `hide_moreyt` | true | misc |
| `hide_endscreen`, `hide_cards`, `hide_autoplay`, `hide_annotations` | true | end screen, cards, autoplay, annotations |
| `hide_shorts` | **false** | Shorts are NOT hidden by default |
| `hide_comments`, `hide_prof`, `hide_mix`, `hide_meta`, `hide_bar`, `hide_channel`, `hide_desc`, `hide_header`, `hide_trending`, `hide_subs` | false | |
| `hide_search` | true | hide shelves in search results |
| `popup_settings` | object | `dark_mode`, `sidebar_tree`, `comment_tree`, `meta_tree`, `header_tree` (UI state only) |

### How hiding is applied
1. `content.js` (run at `document_start`) reads all storage; if `yt_on === true` it sets each `hide_*` key as an **attribute on `<html>`** (`r.setAttribute(t,e[t])`, e.g. `hide_feed="true"`). It also injects `js/unhook-yt.js` as a page script.
2. `css/content.css` is static CSS keyed on those attributes, e.g. `html[hide_feed=true] ytd-browse[page-subtype=home] .ytd-rich-grid-renderer{...display:none!important}`, `html[hide_recommended=true] #items.ytd-watch-next-secondary-results-renderer`, `html[hide_shorts=true] ytd-reel-shelf-renderer`, `html[hide_endscreen=true] .html5-endscreen`.
3. `content.js` listens to `storage.onChanged`: when `yt_on` flips to false it **removes all `hide_*` attributes** (`u()` function); otherwise it sets the changed attribute. The page updates live.
4. `unhook-yt.js` (page world) handles behavior CSS cannot: toggles autoplay/annotations off in the player, strips `(N)` from the tab title, and rewrites the logo link when `hide_redirect_home` is on.
5. `background.js` uses `webRequest.onBeforeRequest` (read-only, no `webRequestBlocking`) plus `tabs.update` to redirect trending/subscriptions/home pages when those options are set.

### The toggle that restores the feed
In `popup.js`:
- Main switch: `#yt_on` checkbox `change` → `f(bool)` → `o({yt_on:e})` = `storage.set`. The big `#off` panel (shown by CSS when `yt_on=false`) also does `p.click()` to turn it back on.
- Per option: every `.check` checkbox `change` → `u()` → `h()` → computes diffs and `storage.set(diff)`. The `hide_feed` checkbox is "Hide Home Feed".

So re-enabling the feed is one click on `#yt_on` or `#hide_feed` in the toolbar popup. Writing storage is immediate; content scripts react through `storage.onChanged`. No confirmation, no delay.

## 3. Feasibility of each option

| # | Option | Verdict | Evidence / reasoning |
|---|---|---|---|
| a | Content script on youtube.com that detects Unhook being disabled and re-enforces it | **Detection feasible, re-enforcement of Unhook itself not.** | The guard can observe `<html>` attributes (`hide_feed`, `yt_on`-driven) from its isolated world; the DOM is shared. But it cannot write Unhook's storage, so it cannot "turn it back on". Observing attributes is also fragile (they are an internal detail of 1.6.9). Not needed if (d) is done. |
| b | Overlay / interstitial on youtube.com home, feeds, Shorts, recommendations | **Feasible, strong.** | Our own content script and CSS at `document_start`, fail-closed. Works whatever Unhook's state is. |
| c | Intercept the Unhook popup/options page via DNR / webNavigation redirect | **Not feasible for the real UI.** | The controls are in a **toolbar popup** (`default_popup`), not a tab; a popup is opened by the browser and is not a navigation any extension can redirect. Other extensions also cannot intercept requests to `chrome-extension://` URLs through DNR/webRequest (those schemes are not visible to them). `popup.html` is not web accessible. Even if a user opens `chrome-extension://khncfooichmfjbepaaaebmommgaepoid/popup.html` in a tab, I could not confirm without a browser whether `webNavigation` events fire for it; treat as unreliable. |
| d | Read another extension's `chrome.storage` | **Not possible** (confirmed from Chromium's storage model: per-extension). | So the guard cannot see or set `yt_on`/`hide_feed`. |
| e | `chrome.management` | **Possible but rejected.** | `management` permission lets the guard list extensions and call `setEnabled(unhookId, bool)`. Costs: a scary install warning ("manage your apps, extensions, and themes"); a very broad permission for a self-control tool; `setEnabled` may require a user gesture and may show a native confirmation (I could not confirm without running it); disabling Unhook would not help since the problem is Unhook being turned *off inside its UI*, not uninstalled. It could be a v2 idea (force-disable Unhook when the guard locks, so there are never two sources of truth) but does not gate the toggle. |
| f | Patched copy of Unhook | **Feasible technically, rejected as first choice.** | See section 5. |

Not confirmable without running Arc: whether Arc exposes `storage.sync` per extension in the same way (the `Sync Extension Settings` folder says yes), exact YouTube DOM today (selectors below are taken from Unhook 1.6.9's own CSS, which is a working reference as of its release).

## 4. Recommended architecture

**A new, separate MV3 "guard" extension that enforces its own feed hiding on youtube.com and owns the only unlock path.**

Reasoning:
- The user's real problem is the habit of tapping Unhook's toggle. Unhook's popup cannot be gated from outside. But the toggle only matters because it controls what YouTube shows. If the guard hides the feed, related videos, end screens and Shorts by itself, fail-closed, then toggling Unhook off no longer shows anything. The tap becomes harmless.
- The only way to see the feed is the guard's interstitial (intent text, countdown, breathing, confirm, daily limit, auto-relock). That is the ScreenZen pattern applied where it can actually be enforced.
- No edits to Unhook, so the EULA ("may not modify or create derivative works") is respected, Web Store updates keep working, and both extensions can stay installed. Unhook keeps doing what the guard does not (autoplay off, annotations off, comments, etc.).
- Small permission set: `storage`, `alarms`, and youtube.com content-script matches. No `management`, no `tabs`, no `webRequest`.

Residual gap, stated honestly: when the guard is unlocked for 10 minutes, the feed shows only if Unhook's own hiding is also off. Tapping Unhook's toggle during an unlock window is still free, and tapping it outside a window changes nothing visible. The guard cannot stop him from disabling the guard itself in `arc://extensions`.

## 5. Fallback: patched copy of Unhook (not recommended)

Put a copy in the workspace, rename, change `key` (new id), add the gate in `popup.js` at `#yt_on` change, `.check` change, and `#off` click handlers, and disable the original.

Tradeoffs:
- The Unhook EULA prohibits modification and derivative works; sharing or long-term use is on the user's side of that risk.
- Loses Web Store auto-updates, so YouTube DOM breakage (selectors in `content.css`) needs manual patching.
- New id means new storage: settings do not carry over; a duplicate hides things twice unless the original is disabled.
- Code is minified; patching means editing generated one-line files.
- It still can be bypassed: remove the patched copy, or re-enable the original in `arc://extensions`.
- The only advantage is that the popup toggle itself is gated.

## 6. Open questions (also listed in plan.md)
See "Decisions to confirm" in `.agents/tasks/plan.md`.

## 7. What was and was not verified
- Verified by reading: everything in sections 1 and 2.
- Implementation findings: the guard loads and runs in Chrome for Testing 156 (headless, throwaway profile) and works against a local fixture that imitates YouTube's element names. Branded Chrome was not needed. Details in `.agents/tasks/verification.md`.
- Not run: Arc, and the real YouTube DOM or network. Guard selectors come from Unhook 1.6.9's CSS and are unchecked against live YouTube.
