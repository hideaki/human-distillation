#!/usr/bin/env node
// Everything that can be checked without a browser, in one command:
//
//     node live/test/run.js          (or: npm test)
//
//   1. the parsing tests (parse.test.js), the Notion tests
//      (notion.test.js), the web tests (web.test.js) and the inbox tests
//      (inbox.test.js), which need nothing but Node;
//   2. the static check: ESLint with two rules, a name that hides an outer
//      name (no-shadow) and a name used before it is defined
//      (no-use-before-define). It runs if an ESLint is found, in
//      node_modules or on the PATH, and is reported as skipped if not.
//
// The flow tests need a browser: see live/TESTING.md.

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const rel = p => path.relative(ROOT, p);
const results = [];

function step(name, fn) {
  console.log(`\n== ${name} ==`);
  const out = fn();
  results.push({ name, ...out });
}

for (const [name, file] of [['Parsing tests', 'parse.test.js'], ['Notion tests', 'notion.test.js'], ['Web tests', 'web.test.js'], ['Inbox tests', 'inbox.test.js']]) {
  step(name, () => {
    const r = spawnSync(process.execPath, ['--test', path.join(__dirname, file)], { cwd: ROOT, stdio: 'inherit' });
    return { ok: r.status === 0 };
  });
}

function findEslint() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'eslint');
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'eslint');
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

step('Static check (shadowing, use before definition)', () => {
  const eslint = findEslint();
  if (!eslint) {
    console.log('SKIPPED: no ESLint found in node_modules or on the PATH. See live/TESTING.md.');
    return { ok: true, skipped: true };
  }
  const live = path.resolve(__dirname, '..');
  const files = [
    ...fs.readdirSync(live).filter(f => f.endsWith('.js')).map(f => path.join(live, f)),
    ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => path.join(__dirname, f)),
  ];
  const version = spawnSync(eslint, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`${eslint} ${version}\n${files.map(rel).join('  ')}`);
  // The rules are in the older "eslintrc" form, which ESLint 7 and 8 read as
  // it is and ESLint 9 reads with this variable set.
  const r = spawnSync(eslint, ['--no-eslintrc', '--config', path.join(__dirname, 'eslintrc.json'), ...files], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ESLINT_USE_FLAT_CONFIG: 'false' },
  });
  if (r.status === 0) console.log('No name hides another, and none is used before it is defined.');
  return { ok: r.status === 0 };
});

console.log('\n== Summary ==');
for (const r of results) console.log(`${r.skipped ? 'SKIPPED' : r.ok ? 'PASSED ' : 'FAILED '}  ${r.name}`);
console.log('Not run here: the flow tests. Open http://localhost:4174/test with the preview server running (live/TESTING.md).');
process.exit(results.every(r => r.ok) ? 0 : 1);
