// npm run verify: every check this repo promises, as one pass/fail table. Exit code 1 if any check fails.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SEED_SHA256 = '3db8ec22f9c84965'; // first 16 hex chars of the provided database.sql
const MAX_SRC_LINES = 600;
const MAX_README_WORDS = 800;
const FORBIDDEN_DEPS = /redis|kafka|bull|amqp|rabbit|cqrs|prisma/;

const run = (cmd) => {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return [true, ''];
  } catch (e) {
    return [false, String(e.stdout || e.message).split('\n').filter((l) => /✕|FAIL|error/.test(l)).slice(0, 3).join(' | ')];
  }
};
const files = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const srcFiles = files('src').filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
const read = (f) => readFileSync(f, 'utf8');

const checks = [
  ['typecheck', () => run('npx tsc --noEmit -p tsconfig.json')],
  ['unit tests (pure money logic)', () => run('npx jest --selectProjects unit')],
  ['e2e tests (HTTP + real Postgres)', () => run('npx jest --selectProjects e2e --runInBand')],
  ['no float parsing of money in src', () => {
    const hits = srcFiles.filter((f) => /parseFloat|\bNumber\(/.test(read(f)));
    return [hits.length === 0, hits.join(', ')];
  }],
  ['no Redis / queues / CQRS deps', () => {
    const deps = Object.keys(JSON.parse(read('package.json')).dependencies ?? {});
    const bad = deps.filter((d) => FORBIDDEN_DEPS.test(d));
    return [bad.length === 0, bad.join(', ')];
  }],
  [`src ≤ ${MAX_SRC_LINES} lines (no tests)`, () => {
    const n = srcFiles.reduce((sum, f) => sum + read(f).split('\n').filter((l) => l.trim()).length, 0);
    return [n <= MAX_SRC_LINES, `${n} lines`];
  }],
  [`README ≤ ${MAX_README_WORDS} words`, () => {
    const n = read('README.md').replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
    return [n <= MAX_README_WORDS, `${n} words (code blocks excluded)`];
  }],
  ['each decision has alternative + scale', () => {
    const sections = read('DECISIONS.md').split(/^## /m).slice(1).filter((s) => /^D-\d+/.test(s));
    const bad = sections.filter((s) => !/\*\*Alternativa/.test(s) || !/\*\*A escala/.test(s)).map((s) => s.split(' ')[0]);
    return [sections.length > 0 && bad.length === 0, bad.length ? `missing in ${bad.join(', ')}` : `${sections.length} decisions`];
  }],
  ['provided seed unchanged', () => {
    const sha = createHash('sha256').update(readFileSync('db/database.sql')).digest('hex');
    return [sha.startsWith(SEED_SHA256), sha.slice(0, 16)];
  }],
  ['no DB credentials in tracked files', () => {
    const hits = execSync('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && f !== 'scripts/verify.mjs')
      .filter((f) => /neon\.tech|npg_/i.test(read(f)));
    return [hits.length === 0, hits.join(', ')];
  }],
];

let failed = 0;
console.log('\n  check                                  result');
for (const [name, check] of checks) {
  const [ok, note] = check();
  if (!ok) failed++;
  console.log(`  ${name.padEnd(38)} ${ok ? 'PASS' : 'FAIL'}  ${note}`);
}
console.log(failed ? `\n  ${failed} check(s) failed\n` : '\n  all checks passed\n');
process.exit(failed ? 1 : 0);
