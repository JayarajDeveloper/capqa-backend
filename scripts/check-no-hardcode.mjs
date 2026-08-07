#!/usr/bin/env node
/**
 * Zero-hardcode gate.
 *
 * INVARIANT: the Cap QA engine must contain no knowledge of any target
 * application. Target knowledge belongs in (a) the target's own source, read at
 * runtime, or (b) module doc files on disk. Never in engine code.
 *
 * The forbidden vocabulary is NOT hand-written — that would itself be a
 * hardcode, and it would go stale the moment the target adds a module. It is
 * DERIVED by scanning the target: Feature/entity folder names on the API side,
 * page folder names on the UI side, plus distinctive compound property names.
 * Point this at a different target and the banned list changes with it.
 *
 *   node scripts/check-no-hardcode.mjs            # report
 *   node scripts/check-no-hardcode.mjs --update   # write the current count as the budget
 *
 * Exits non-zero when the count exceeds .hardcode-budget.json. The budget only
 * ever ratchets DOWN — that is what stops the number creeping back up.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUDGET_FILE = path.join(ROOT, '.hardcode-budget.json');

/** Below this, the target source clearly was not read — treat as a broken run, not a pass. */
const MIN_VOCAB = 50;

/** The target application's own name(s), matched case-insensitively — irregular
 *  capitalisation (CapBO, capbo, CAPBO) must all be caught by one rule. */
const TARGET_NAMES = new Set();

const API_ROOT = (process.env.CAPQA_LOCAL_API_ROOT || '').replace(/\/+$/, '');
const UI_ROOT = (process.env.CAPQA_LOCAL_UI_ROOT || '').replace(/\/+$/, '');

/** Engine source that must stay target-agnostic. Adapters/tests are exempt. */
const SCAN_DIRS = ['src'];
const EXEMPT = [
  /\.test\.js$/,
  /[/\\]adapters[/\\]/,      // declarative framework packs live here (see below)
  /[/\\]node_modules[/\\]/,
];

// ── Derive the target's domain vocabulary ────────────────────────────────────

const listDirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
};

function readIfExists(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/**
 * Cap QA's OWN vocabulary — derived from its Prisma schema and its dependency
 * list. Any word the product legitimately owns (user, project, report,
 * createdAt, playwright, …) is excluded from the ban, even when the target
 * happens to use the same word for one of its modules. Both sides of this
 * comparison are derived; neither is a hand-maintained list.
 */
function ownVocabulary() {
  const own = new Set();
  const schema = readIfExists(path.join(ROOT, 'prisma', 'schema.prisma'));
  const addWithSegments = (w) => {
    const lower = w.toLowerCase();
    own.add(lower);
    own.add(lower.endsWith('s') ? lower.slice(0, -1) : lower + 's');
    // TestReport -> test, report, reports.  Cap QA owns every segment it names itself with.
    for (const seg of w.split(/(?=[A-Z])|[_-]/).filter(Boolean)) {
      const sl = seg.toLowerCase();
      if (sl.length < 3) continue;
      own.add(sl);
      own.add(sl.endsWith('s') ? sl.slice(0, -1) : sl + 's');
    }
  };
  for (const m of schema.matchAll(/^\s*(?:model|enum)\s+(\w+)/gm)) addWithSegments(m[1]);
  for (const m of schema.matchAll(/^\s{2,}(\w+)\s+\w/gm)) addWithSegments(m[1]);

  // Cap QA's own module layout — directory and file names under src/.
  const walkNames = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      addWithSegments(e.name.replace(/\.(js|mjs|test\.js)$/, ''));
      if (e.isDirectory()) walkNames(path.join(dir, e.name), depth + 1);
    }
  };
  walkNames(path.join(ROOT, 'src'));

  const pkg = readIfExists(path.join(ROOT, 'package.json'));
  try {
    const j = JSON.parse(pkg || '{}');
    for (const d of Object.keys({ ...j.dependencies, ...j.devDependencies })) {
      for (const part of d.replace(/^@/, '').split(/[/-]/)) own.add(part.toLowerCase());
    }
  } catch { /* ignore */ }

  // THIS LIST IS THE GATE'S OWN RESIDUAL HARDCODE. Everything else here is derived;
  // these are ordinary English / web / framework words that collide with a target
  // module name and would otherwise drown the real signal. Keep it SHORT, and add a
  // word only with a demonstrated false positive — never to make the number look better.
  //   group  -> Angular `fb.group({` and the English verb (formSchema.js:208, llm.js:98)
  //   chat   -> the OpenAI-compatible `/chat/completions` path (llm.js:115, agent/loop.js:48)
  for (const w of ['auth', 'authorization', 'token', 'session', 'request', 'response',
                   'error', 'status', 'result', 'value', 'field', 'label', 'category',
                   'attribute', 'document', 'element', 'content', 'source', 'target',
                   'index', 'search', 'filter', 'action', 'options', 'params', 'headers',
                   'group', 'chat']) own.add(w);
  return own;
}

/**
 * The target's domain vocabulary. Two high-confidence classes only:
 *   1. MODULE names   — Feature/ dirs (API) and pages/ dirs (UI)
 *   2. COMPOUND props — multi-segment entity properties (shortDesignation,
 *                       roundingIncrement, calculation_mode)
 * Bare single-word properties (name, code, value) are deliberately excluded:
 *   they are ambiguous with ordinary English and would drown the signal.
 */
function targetVocabulary() {
  const own = ownVocabulary();
  const words = new Set();

  for (const d of listDirs(path.join(API_ROOT, 'src', 'Features'))) words.add(d);
  for (const base of [path.join(UI_ROOT, 'src', 'app', 'pages'), path.join(UI_ROOT, 'app', 'pages')]) {
    for (const d of listDirs(base)) words.add(d);
  }

  // A compound property counts only when its FIRST segment names a target module
  // (partnerType, articleEcotaxes, retailChains). Generic compounds that merely
  // happen to appear in the target — failedStep, errorMessage, fieldName — do not.
  const moduleStems = new Set([...words].map((w) => w.toLowerCase().replace(/[-_]/g, '')));
  const isModuleStem = (seg) => {
    const s2 = seg.toLowerCase();
    return moduleStems.has(s2) || moduleStems.has(s2 + 's') || moduleStems.has(s2.replace(/s$/, ''));
  };
  for (const mod of listDirs(path.join(API_ROOT, 'src', 'Features'))) {
    const dir = path.join(API_ROOT, 'src', 'Features', mod, 'Entity');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.php')); } catch { continue; }
    for (const f of files) {
      const txt = readIfExists(path.join(dir, f));
      for (const m of txt.matchAll(/(?:private|protected|public)(?:\s+readonly)?\s+[^$;]*\$([a-z]+(?:[A-Z]\w+)+)/g)) {
        const first = m[1].match(/^[a-z]+/)[0];
        if (isModuleStem(first)) words.add(m[1]);
      }
    }
  }

  const forms = new Set();
  const add = (v) => {
    if (v.length < 4) return;
    const stem = v.toLowerCase().replace(/[-_]/g, '');
    if (own.has(v.toLowerCase()) || own.has(stem)) return;   // Cap QA owns this word
    forms.add(v);
  };
  for (const w of words) {
    if (w.length < 4) continue;
    const kebab = w.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    for (const v of [w, kebab, kebab.replace(/-/g, '_'), w.toLowerCase()]) {
      add(v);
      if (v.endsWith('ies')) add(v.slice(0, -3) + 'y');
      else if (v.endsWith('s')) add(v.slice(0, -1));
      else add(v + 's');
    }
  }
  // The target's own name, derived from the root folder (capbo-backend -> capbo)
  // rather than written here. This file should name no application.
  for (const root of [API_ROOT, UI_ROOT]) {
    const base = path.basename(root || '').replace(/-(backend|frontend|api|ui|app|server|client)$/i, '');
    if (base.length >= 4) TARGET_NAMES.add(base.toLowerCase());
  }
  return [...forms];
}

// ── Scan engine source ───────────────────────────────────────────────────────

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) yield p;
  }
}

/** Strip comments so documentation prose is not counted as a hardcode. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l.replace(/\s\/\/.*$/, '')))
    .join('\n');
}

const vocab = targetVocabulary();

// A gate that cannot see the target must FAIL, never report a comfortable number.
// Without this, missing roots produced "2 target-derived terms / TOTAL 4" and exit 0
// while checking essentially nothing.
const featuresDir = path.join(API_ROOT, ...['src', 'Features']);
const problems = [];
if (!API_ROOT) problems.push('CAPQA_LOCAL_API_ROOT is not set (checked the shell and .env)');
else if (!fs.existsSync(featuresDir)) problems.push(`CAPQA_LOCAL_API_ROOT does not contain ${path.join('src', 'Features')}: ${API_ROOT}`);
if (!UI_ROOT) problems.push('CAPQA_LOCAL_UI_ROOT is not set (checked the shell and .env)');
else if (!fs.existsSync(UI_ROOT)) problems.push(`CAPQA_LOCAL_UI_ROOT does not exist: ${UI_ROOT}`);
if (vocab.length < MIN_VOCAB) problems.push(`only ${vocab.length} target terms derived (expected at least ${MIN_VOCAB}) — the target source was not readable`);

if (problems.length) {
  console.error('\nZero-hardcode gate CANNOT RUN — refusing to report a pass:\n');
  for (const p2 of problems) console.error(`  - ${p2}`);
  console.error('\nSet CAPQA_LOCAL_API_ROOT / CAPQA_LOCAL_UI_ROOT (in .env or the shell) and re-run.\n');
  process.exit(2);
}
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rx = new RegExp(`\\b(${vocab.map(esc).join('|')})\\b`, 'g');
const rxName = TARGET_NAMES.size
  ? new RegExp(`\\b(${[...TARGET_NAMES].map(esc).join('|')})\\b`, 'gi')
  : null;

const findings = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    if (EXEMPT.some((r) => r.test(rel))) continue;
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(rx)) {
        findings.push({ file: rel, line: i + 1, token: m[1], text: line.trim().slice(0, 110) });
      }
      if (rxName) for (const m of line.matchAll(rxName)) {
        findings.push({ file: rel, line: i + 1, token: m[1], text: line.trim().slice(0, 110) });
      }
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const byFile = new Map();
for (const f of findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);

const budget = fs.existsSync(BUDGET_FILE)
  ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')).max
  : Infinity;

console.log(`\nZero-hardcode gate — ${vocab.length} target-derived terms\n`);
for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${file}`);
}
const tokens = [...findings.reduce((m, f) => m.set(f.token, (m.get(f.token) || 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`\n  top terms: ${tokens.map(([t, n]) => `${t}(${n})`).join(' ')}`);
console.log(`\n  TOTAL ${findings.length}   BUDGET ${budget === Infinity ? '(unset)' : budget}\n`);

if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(ROOT, 'hardcode-report.json'), JSON.stringify(findings, null, 2));
  console.log('  wrote hardcode-report.json\n');
}

if (process.argv.includes('--update')) {
  const prev = budget === Infinity ? Infinity : budget;
  if (findings.length > prev) {
    console.error(`  refusing to raise the budget (${prev} -> ${findings.length}). It only ratchets down.\n`);
    process.exit(1);
  }
  fs.writeFileSync(BUDGET_FILE, JSON.stringify({ max: findings.length, note: 'Ratchets down only. Goal: 0.' }, null, 2) + '\n');
  console.log(`  budget set to ${findings.length}\n`);
  process.exit(0);
}

if (findings.length > budget) {
  console.error(`  FAIL: ${findings.length - budget} new target-specific reference(s) in engine code.\n`);
  process.exit(1);
}
process.exit(0);
