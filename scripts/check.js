'use strict';
// Static checks: JSON.parse every .json, node --check every .js, verify manifest-referenced files exist,
// verify PNG signatures. Run: node scripts/check.js
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.agents', '.git']);
let failures = 0;
const fail = (m) => { failures++; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(root, []);
const rel = (p) => path.relative(root, p);

for (const f of files.filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); ok('JSON.parse ' + rel(f)); } catch (e) { fail('JSON ' + rel(f) + ': ' + e.message); }
}
for (const f of files.filter((f) => f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status === 0) ok('node --check ' + rel(f)); else fail('syntax ' + rel(f) + ': ' + r.stderr);
}

const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const refs = [];
if (m.background && m.background.service_worker) refs.push(m.background.service_worker);
(m.content_scripts || []).forEach((c) => refs.push(...(c.js || []), ...(c.css || [])));
if (m.action && m.action.default_popup) refs.push(m.action.default_popup);
if (m.options_page) refs.push(m.options_page);
Object.values(m.icons || {}).forEach((i) => refs.push(i));
refs.forEach((r) => (fs.existsSync(path.join(root, r)) ? ok('manifest ref exists ' + r) : fail('missing manifest ref ' + r)));

// Local files referenced from our HTML pages must exist.
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(f, 'utf8');
  for (const mm of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const target = path.resolve(path.dirname(f), mm[1]);
    fs.existsSync(target) ? ok(rel(f) + ' -> ' + mm[1]) : fail(rel(f) + ' references missing ' + mm[1]);
  }
}

for (const i of refs.filter((r) => r.endsWith('.png'))) {
  const b = fs.readFileSync(path.join(root, i));
  b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? ok('PNG signature ' + i) : fail('bad PNG ' + i);
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
