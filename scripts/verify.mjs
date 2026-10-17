#!/usr/bin/env node
/**
 * The single `verify` gate.
 *
 * `09-CODEBASE-QUALITY.md`: "A single `verify` command runs everything — secret scan, config check,
 * unit, build, E2E — so 'done' is one command with a green exit, not a ritual of remembered steps."
 *
 * Two deliberate behaviours:
 *   - steps run in a fixed order, cheapest and most security-critical first, so a leaked key fails in
 *     two seconds rather than after a browser suite;
 *   - a step whose tooling is not installed yet is reported as `skipped`, not as a pass. A gate that
 *     silently counts absent work as success is how a suite becomes 95% green and 0% trusted.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const onlyStep = process.argv[2];

/** `requires` is a path that must exist for the step to be meaningful; absent → skipped, not passed. */
const STEPS = [
  { id: 'secrets', label: 'secret scan', command: ['node', 'scripts/check-secrets.mjs'] },
  { id: 'config', label: 'config check', command: ['node', 'scripts/check-config.mjs'] },
  {
    id: 'compositor',
    label: 'compositor cost check',
    command: ['node', 'scripts/check-compositor.mjs'],
  },
  { id: 'format', label: 'formatting', command: ['pnpm', 'exec', 'prettier', '--check', '.'] },
  { id: 'lint', label: 'lint', command: ['pnpm', 'exec', 'eslint', '.'] },
  { id: 'typecheck', label: 'typecheck', command: ['pnpm', '-r', 'typecheck'] },
  { id: 'unit', label: 'unit + integration tests', command: ['pnpm', 'exec', 'vitest', 'run'] },
  { id: 'build', label: 'build', command: ['pnpm', 'run', 'build'] },
  {
    id: 'e2e',
    label: 'end-to-end tests',
    command: ['pnpm', 'exec', 'playwright', 'test'],
    requires: 'playwright.config.ts',
  },
];

const run = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });

const exists = async (relative) => {
  try {
    await access(join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
};

const results = [];
let failed = false;

for (const step of STEPS) {
  if (onlyStep && step.id !== onlyStep) continue;

  if (step.requires && !(await exists(step.requires))) {
    results.push({ step, status: 'skipped', reason: `${step.requires} not present yet` });
    continue;
  }

  const started = Date.now();
  console.log(`\n── ${step.label} ──`);
  const [command, ...args] = step.command;
  const code = await run(command, args);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (code === 0) {
    results.push({ step, status: 'passed', seconds });
    continue;
  }

  results.push({ step, status: 'failed', seconds, code });
  failed = true;
  // Stop at the first failure: later steps would report the same root cause as new noise.
  break;
}

console.log('\n─── verify summary ───');
for (const result of results) {
  const mark = result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  const suffix = result.status === 'skipped' ? ` (${result.reason})` : ` (${result.seconds}s)`;
  console.log(`  ${mark}  ${result.step.label}${suffix}`);
}

const skipped = results.filter((r) => r.status === 'skipped').length;
if (skipped > 0) {
  console.log(`\n${skipped} step(s) skipped — they are not yet implemented, not yet passing.`);
}

if (failed) {
  console.error('\nverify FAILED\n');
  process.exit(1);
}

console.log('\nverify passed\n');
