'use strict';
// Runtime check in a throwaway Chromium profile (never Arc). Uses only node built-ins and raw CDP.
// Maps www.youtube.com to a local HTTPS fixture server so the content script runs without any network access.
const { spawn, execFileSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXT = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
const CHROME = process.env.CHROME_BIN;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-rt-'));
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail: detail || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture server ----
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', TMP + '/k.pem', '-out', TMP + '/c.pem',
  '-days', '1', '-subj', '/CN=www.youtube.com', '-addext', 'subjectAltName=DNS:www.youtube.com'], { stdio: 'ignore' });
const server = https.createServer({ key: fs.readFileSync(TMP + '/k.pem'), cert: fs.readFileSync(TMP + '/c.pem') }, (req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>fixture ' + req.url + '</title><body>' +
    '<ytd-app><ytd-page-manager><ytd-browse page-subtype="home"><div id="feed">THE FEED</div></ytd-browse></ytd-page-manager></ytd-app>' +
    '<ytd-watch-flexy><div id="secondary" class="ytd-watch-flexy">RELATED</div><div id="player">PLAYER</div></ytd-watch-flexy>' +
    '<ytd-search><ytd-reel-shelf-renderer id="reel">SHORTS SHELF</ytd-reel-shelf-renderer><div id="result">RESULT</div></ytd-search></body>');
});

// ---- minimal CDP client ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (m) => { const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result); }
      else this.handlers.forEach((h) => h(d)); }; }
  send(method, params, sessionId) { const id = ++this.id; const msg = { id, method, params: params || {} }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(msg)); }); }
}

async function main() {
  await new Promise((r) => server.listen(8443, '127.0.0.1', r));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + TMP + '/profile',
    '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
    '--host-resolver-rules=MAP www.youtube.com 127.0.0.1:8443', '--ignore-certificate-errors',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });
  try {
    let ver;
    for (let i = 0; i < 50; i++) { try { ver = await (await fetch('http://127.0.0.1:9333/json/version')).json(); break; } catch (e) { await sleep(200); } }
    if (!ver) throw new Error('browser did not start');
    console.log('browser: ' + ver.Browser);
    const cdp = new CDP(new WebSocket(ver.webSocketDebuggerUrl));
    await new Promise((r) => { cdp.ws.onopen = r; });

    // extension id from its service worker target
    let extId = null;
    for (let i = 0; i < 50 && !extId; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background/service-worker.js'));
      if (i === 49) console.log(JSON.stringify(targetInfos.map((t) => [t.type, t.url])));
      if (sw) extId = new URL(sw.url).host; else await sleep(200);
    }
    rec('extension loaded (service worker target found)', !!extId, extId || 'none');
    if (!extId) throw new Error('extension not loaded');

    async function open(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: url.startsWith('chrome-extension:') ? url : 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
      if (!url.startsWith('chrome-extension:')) await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(1500);
      const ev = async (expr) => { const r = await cdp.send('Runtime.evaluate', { expression: '(async()=>(' + expr + '))()', awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
      const shot = async (name) => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
      const pierceText = async () => { const r = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId); return JSON.stringify(r); };
      return { targetId, sessionId, ev, shot, pierceText };
    }
    const attrs = (p) => p.ev('JSON.stringify({s:document.documentElement.getAttribute("ug-state"),r:document.documentElement.getAttribute("ug-route"),sh:document.documentElement.getAttribute("ug-shorts")})').then(JSON.parse);
    const disp = (p, sel) => p.ev('(()=>{const e=document.querySelector(' + JSON.stringify(sel) + ');return e?getComputedStyle(e).display:"missing"})()');

    // 1. extension pages first (initialises storage defaults)
    const opt = await open('chrome-extension://' + extId + '/options/options.html');
    await sleep(500);
    const optText = await opt.ev('document.body.innerText');
    rec('options page renders settings and 3 default unlocks', /Daily unlock limit/.test(optText) && /Unlocks used today: 0 of 3/.test(optText), optText.slice(0, 120).replace(/\n/g, ' | '));
    await opt.shot('rt-options.png');

    // 2. home page locked: overlay, hidden feed
    const home = await open('https://www.youtube.com/');
    await sleep(500);
    let a = await attrs(home);
    rec('home route: ug-route=block, ug-state=locked', a.r === 'block' && a.s === 'locked', JSON.stringify(a));
    rec('home route: feed container hidden', (await disp(home, 'ytd-page-manager')) === 'none');
    rec('home route: overlay present in closed shadow root', (await home.pierceText()).includes('Your feed is locked'));
    await home.shot('rt-home-locked.png');

    // 3. watch page and search page
    const watch = await open('https://www.youtube.com/watch?v=abcdefghijk');
    a = await attrs(watch);
    rec('watch route not blocked', a.r === 'ok', JSON.stringify(a));
    rec('watch page: related column hidden while locked', (await disp(watch, '#secondary')) === 'none');
    rec('watch page: player visible', (await disp(watch, '#player')) !== 'none');
    const search = await open('https://www.youtube.com/results?search_query=test');
    a = await attrs(search);
    rec('search route not blocked, shorts shelf hidden', a.r === 'ok' && (await disp(search, '#reel')) === 'none', JSON.stringify(a));
    const shorts = await open('https://www.youtube.com/shorts/abcdefghijk');
    a = await attrs(shorts);
    rec('shorts route blocked', a.r === 'block', JSON.stringify(a));

    // 4. tighten timing so the flow takes ~15 s, then run the interstitial
    await opt.ev(`chrome.storage.local.set({ug_settings: Object.assign({}, (await chrome.storage.local.get('ug_settings')).ug_settings, {countdownSeconds:[2,2,2], breathingCycles:1})})`);
    const it = await open('chrome-extension://' + extId + '/interstitial/interstitial.html?reason=feed&next=' + encodeURIComponent('https://www.youtube.com/'));
    const vis = () => it.ev('Array.from(document.querySelectorAll("section[data-step]")).filter(s=>!s.hidden).map(s=>s.dataset.step).join(",")');
    rec('interstitial starts at status step', (await vis()) === 'status', await vis());
    await it.ev('document.getElementById("status-continue").click()');
    rec('intent step shown, continue disabled', (await vis()) === 'intent' && (await it.ev('document.getElementById("intent-continue").disabled')) === true);
    const setIntent = (t) => it.ev('(()=>{const i=document.getElementById("intent");i.value=' + JSON.stringify(t) + ';i.dispatchEvent(new Event("input"));return document.getElementById("intent-continue").disabled})()');
    rec('short intent keeps continue disabled', (await setIntent('short')) === true);
    rec('valid intent enables continue', (await setIntent('the lecture on how transformers work')) === false);
    await it.ev('document.getElementById("intent-continue").click()');
    await sleep(400);
    rec('countdown step shown after intent', (await vis()) === 'countdown', await vis());
    await it.shot('rt-interstitial-countdown.png');
    // completing early through the worker must be refused
    const early = await it.ev('(async()=>{const s=await chrome.runtime.sendMessage({type:"ug:getStatus"});return JSON.stringify(await chrome.runtime.sendMessage({type:"ug:complete",attemptId:s.attempt.id,intent:"the lecture on how transformers work"}))})()');
    rec('worker refuses early completion', JSON.parse(early).reason === 'too-early', early);
    for (let i = 0; i < 40 && (await vis()) !== 'breathing'; i++) await sleep(250);
    rec('breathing step reached after countdown', (await vis()) === 'breathing', await vis());
    for (let i = 0; i < 60 && (await vis()) !== 'confirm1'; i++) await sleep(250);
    rec('confirm 1 reached after breathing', (await vis()) === 'confirm1', await vis());
    await it.ev('document.getElementById("confirm1-yes").click()');
    rec('confirm 2 shown', (await vis()) === 'confirm2');
    await it.shot('rt-interstitial-confirm2.png');
    await it.ev('document.getElementById("confirm2-go").click()');
    await sleep(2000);
    const stAfter = await opt.ev('JSON.stringify((await chrome.storage.local.get("ug_state")).ug_state)').then(JSON.parse);
    rec('unlock recorded (unlocksUsed=1, unlockedUntil in future)', stAfter.unlocksUsed === 1 && stAfter.unlockedUntil > Date.now(), JSON.stringify({ u: stAfter.unlocksUsed, rem: Math.round((stAfter.unlockedUntil - Date.now()) / 1000) }));
    const hist = await opt.ev('JSON.stringify((await chrome.storage.local.get("ug_history")).ug_history)').then(JSON.parse);
    rec('intent logged with text', hist.some((h) => h.type === 'unlock' && /transformers/.test(h.text)), JSON.stringify(hist.map((h) => h.type)));

    // 5. unlocked: an already-open home tab flips live, then auto re-locks
    a = await attrs(home);
    rec('open home tab updates live to unlocked / route ok', a.s === 'unlocked' && a.r === 'ok', JSON.stringify(a));
    rec('feed container visible while unlocked', (await disp(home, 'ytd-page-manager')) !== 'none');
    await home.shot('rt-home-unlocked.png');
    await opt.ev('chrome.storage.local.set({ug_state: Object.assign((await chrome.storage.local.get("ug_state")).ug_state, {unlockedUntil: Date.now()+3000})})');
    await sleep(500);
    rec('still unlocked 0.5 s before expiry', (await attrs(home)).s === 'unlocked');
    await sleep(3500);
    a = await attrs(home);
    rec('auto re-lock in the open tab after expiry', a.s === 'locked' && a.r === 'block', JSON.stringify(a));
    rec('overlay back after re-lock', (await home.pierceText()).includes('Your feed is locked'));

    // 6. settings protection
    const upd = await opt.ev('JSON.stringify(await chrome.runtime.sendMessage({type:"ug:updateSettings",patch:{dailyUnlockLimit:9,unlockMinutes:5}}))').then(JSON.parse);
    rec('weakening queued, strengthening applied', upd.queued.includes('dailyUnlockLimit') && upd.appliedNow.includes('unlockMinutes'), JSON.stringify(upd));
    const pend = await opt.ev('JSON.stringify((await chrome.storage.local.get(["ug_pending","ug_settings"])))').then(JSON.parse);
    rec('pending entry is ~24h out and limit unchanged', pend.ug_pending.length === 1 && Math.abs(pend.ug_pending[0].effectiveAt - Date.now() - 86400000) < 60000 && pend.ug_settings.dailyUnlockLimit === 3);

    // 7. messages from a web page / content script cannot do privileged things
    const bad = await home.ev('(async()=>{try{return JSON.stringify(await chrome.runtime.sendMessage("' + extId + '",{type:"ug:lockNow"}))}catch(e){return "error:"+e.message}})()');
    rec('page cannot message the worker (no externally_connectable)', /error|undefined/.test(String(bad)) || bad == null, String(bad).slice(0, 100));

    fs.writeFileSync(path.join(OUT, 'runtime-results.json'), JSON.stringify({ browser: ver.Browser, results }, null, 2));
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}
main().then(() => { const f = results.filter((r) => !r.pass); console.log(f.length ? f.length + ' FAILED' : 'ALL PASSED (' + results.length + ')'); process.exit(f.length ? 1 : 0); },
  (e) => { console.log('ERROR ' + e.message); fs.writeFileSync(path.join(OUT, 'runtime-results.json'), JSON.stringify({ error: e.message, results }, null, 2)); try { server.close(); } catch (x) {} process.exit(2); });
