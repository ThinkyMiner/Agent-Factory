#!/usr/bin/env node
// Screenshots and an accessibility scan of rendered pages, for the ui-reviewer.
//   node factory/scripts/ui-shots.mjs --out <dir> <url>...
// For each URL: full-page screenshots in light and dark (prefers-color-scheme) at desktop
// (1280x800) and phone (390x844) width, as <dir>/<page>-<scheme>-<device>.png, and an axe scan per
// colour scheme, all in <dir>/axe.json. Prints the files written and the violations by impact.
// <dir> must be inside this repository, without ..; URLs are http, https, or file inside the
// repository (so it never renders ~/.ssh or anything else outside it).
// States: when <dir>'s parent folder (the work folder) holds ui-states.txt, each line there is one
// more state of every page, shot and scanned the same way as <page>--<state>-<scheme>-<device>.png:
//   <name>: <step>; <step>...      name: a-z, 0-9 and -, up to 30; # starts a comment line
//   fill <label> = <text>   select <label> = <option text>   click <button name>
// Fields are found by their visible label, buttons by their accessible name, as a person would;
// when several buttons share the name (an Edit on every row), the first on the page is clicked.
// A state's steps run once, then the page is shot in each scheme and width as it stands, so a
// click that saves or deletes happens once. The product keeps its data from state to state, in
// file order: a later state can click Edit on a row an earlier state saved. A state no step can
// reach (rows the API refuses, a server error) is not for this tool: the ui-reviewer lists it under
// NOT VERIFIED with the test that covers it.
// ponytail: a step's text cannot hold ';'; add quoting if a spec ever needs one.
// Uses the product's own playwright and @axe-core/playwright, found from the current directory
// (or NODE_PATH). It installs nothing.
// Exit 0 when every page and state rendered (violations are reported, not judged), 1 when one
// failed to load or a step failed, 2 on a usage error (a bad ui-states.txt too) or missing tooling.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node factory/scripts/ui-shots.mjs --out <dir> <url>...';
const die = (msg, code = 2) => { console.error(`ui-shots: ${msg}`); process.exit(code); };
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const inside = (p) => p.startsWith(root + path.sep);

// real <path>: the path with every symlink resolved, for a path that may not exist yet (its
// deepest existing ancestor is resolved). A dangling symlink is refused: a write would follow it.
function real(p) {
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(p), ...rest); } catch {}
    if (fs.lstatSync(p, { throwIfNoEntry: false })) throw new Error(`${p} cannot be resolved`);
    rest.unshift(path.basename(p));
    const up = path.dirname(p);
    if (up === p) throw new Error('no existing ancestor');
    p = up;
  }
}

let out;
const urls = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i].startsWith('-')) die(`unknown option ${args[i]}\n${USAGE}`);
  else urls.push(args[i]);
}
if (!out || out.startsWith('-') || urls.length === 0) die(USAGE);
if (out.split(/[\\/]/).includes('..')) die(`--out ${out}: .. is not allowed`);
let outDir;
try { outDir = real(path.resolve(out)); } catch (e) { die(`--out ${out}: ${e.message}`); }
if (!inside(outDir)) die(`--out ${out} is outside the repository (${root})`);

// The states in ui-states.txt beside the output folder, checked before anything renders.
const states = [{ name: '', steps: [] }];
const statesFile = path.join(path.dirname(outDir), 'ui-states.txt');
const statesRel = path.relative(process.cwd(), statesFile);
const st = fs.lstatSync(statesFile, { throwIfNoEntry: false });
if (st) {
  if (!st.isFile()) die(`${statesRel} must be a plain file, not a link or folder`);
  if (st.size > 20000) die(`${statesRel} is over 20000 bytes`);
  const names = new Set();
  fs.readFileSync(statesFile, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const bad = (why) => die(`${statesRel}:${i + 1}: ${why}\n` +
      'a line is "<name>: <step>; <step>", a step is fill <label> = <text>, select <label> = <option text> or click <button name>');
    const m = /^([a-z0-9][a-z0-9-]{0,29}):(.*)$/.exec(line);
    if (!m) bad('not "<name>: <steps>" (name: a-z, 0-9 and -, up to 30)');
    if (names.has(m[1])) bad(`the state ${m[1]} is named twice`);
    names.add(m[1]);
    const steps = m[2].split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
      let k = /^(fill|select) (\S.{0,99}?) = (.{0,1000})$/.exec(x);
      if (k) return { op: k[1], target: k[2], value: k[3] };
      k = /^click (\S.{0,99})$/.exec(x);
      if (k) return { op: 'click', target: k[1] };
      bad(`not a step: ${x.slice(0, 80)}`);
    });
    if (!steps.length) bad(`the state ${m[1]} has no step`);
    states.push({ name: m[1], steps });
  });
  if (states.length > 21) die(`${statesRel}: at most 20 states`);
}

const pages = urls.map((s) => {
  let u;
  try { u = new URL(s); } catch { die(`not a URL: ${s}`); }
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) die(`${s}: only http, https and file URLs`);
  if (u.protocol === 'file:') {
    let f;
    try { f = real(fileURLToPath(u)); } catch (e) { die(`${s}: ${e.message}`); }
    if (!inside(f)) die(`${s} is outside the repository (${root})`);
  }
  return u;
});

const req = createRequire(path.join(process.cwd(), 'ui-shots.cjs'));
let chromium, AxeBuilder;
try {
  ({ chromium } = req('playwright'));
  AxeBuilder = req('@axe-core/playwright');
  AxeBuilder = AxeBuilder.default ?? AxeBuilder;
} catch (e) {
  die(`needs playwright and @axe-core/playwright from the product's node_modules (${e.code ?? e.message}).\n` +
    'Install them in the product (npm install --save-dev playwright @axe-core/playwright, then\n' +
    'npx playwright install chromium) and run this from the folder that has node_modules.');
}

fs.mkdirSync(outDir, { recursive: true });
if (!inside(fs.realpathSync(outDir))) die(`--out ${out} is outside the repository (${root})`);
// write <name> <data>: a new file in outDir; an old one (or a link planted there) is removed, not followed.
const written = [];
function write(name, data) {
  const f = path.join(outDir, name);
  fs.rmSync(f, { force: true });
  fs.writeFileSync(f, data, { flag: 'wx' });
  written.push(path.relative(process.cwd(), f));
}
function slug(u) {
  const p = u.protocol === 'file:' ? path.basename(u.pathname) : u.pathname;
  return p.replace(/\.html?$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'index';
}

// act <page> <step>: one step, as a person would do it; leaving the page is an error.
async function act(page, s) {
  const o = { timeout: 5000 };
  try {
    if (s.op === 'fill') await page.getByLabel(s.target, { exact: true }).fill(s.value, o);
    else if (s.op === 'select') await page.getByLabel(s.target, { exact: true }).selectOption({ label: s.value }, o);
    else await page.getByRole('button', { name: s.target, exact: true }).first().click(o);
  } catch (e) { throw new Error(`step "${s.op} ${s.target}": ${e.message.split('\n')[0]}`); }
}
const left = (now, u) => { const n = new URL(now); return n.protocol !== u.protocol || (u.protocol === 'file:' ? n.pathname !== u.pathname : n.origin !== u.origin); };

const devices = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
let browser;
try { browser = await chromium.launch(); } catch (e) {
  die(`could not start Chromium (${e.message.split('\n')[0]}). Install it in the product: npx playwright install chromium`);
}
const report = [];
const seen = new Map();
let failed = 0;
for (const u of pages) {
  let name = slug(u);
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  if (n > 1) name += `-${n}`;
  for (const { name: state, steps } of states) {
    const shot = state ? `${name}--${state}` : name;
    const context = await browser.newContext();     // AxeBuilder needs a page from its own context
    const page = await context.newPage();
    try {
      await page.setViewportSize(devices.desktop);
      const res = await page.goto(u.href, { waitUntil: 'load', timeout: 30000 });
      if (res && !res.ok()) throw new Error(`HTTP ${res.status()}`);
      for (const s of steps) await act(page, s);
      if (steps.length && left(page.url(), u)) throw new Error(`a step left the page for ${page.url()}`);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const [device, size] of Object.entries(devices)) {
          await page.setViewportSize(size);
          write(`${shot}-${scheme}-${device}.png`, await page.screenshot({ fullPage: true }));
          if (device !== 'desktop') continue;
          const { violations } = await new AxeBuilder({ page }).analyze();
          report.push({ url: u.href, page: name, state: state || undefined, scheme, violations: violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
            nodes: v.nodes.map((x) => ({ target: x.target, summary: x.failureSummary })) })) });
        }
      }
    } catch (e) {
      failed++;
      report.push({ url: u.href, page: name, state: state || undefined, error: e.message.split('\n')[0] });
      console.error(`ui-shots: ${u.href}${state ? ` state ${state}` : ''} failed: ${e.message.split('\n')[0]}`);
    }
    await context.close();
  }
}
await browser.close();
write('axe.json', JSON.stringify(report, null, 2) + '\n');

console.log(`ui-shots: wrote ${written.length} files`);
for (const f of written) console.log(`  ${f}`);
const impacts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
const lines = [];
for (const r of report) {
  const p = r.state ? `${r.page}--${r.state}` : r.page;
  if (r.error) { lines.push(`  ${p}: did not render (${r.error})`); continue; }
  for (const v of r.violations) impacts[v.impact ?? 'minor'] = (impacts[v.impact ?? 'minor'] ?? 0) + 1;
  if (r.violations.length) lines.push(`  ${p} ${r.scheme}: ` + r.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join(', '));
}
console.log('axe violations: ' + Object.entries(impacts).map(([k, v]) => `${v} ${k}`).join(', '));
for (const l of lines) console.log(l);
process.exit(failed ? 1 : 0);
