/**
 * Secret-scanner contract tests.
 *
 * The property under pin: a real environment file is itself the finding, independent of its
 * contents. `deploy.env` is named in `.gitignore` precisely so `git add .` cannot stage it — which
 * is exactly why a scanner that walked git's view would never look at the one file that rule exists
 * for. The scan therefore walks the filesystem with skip-lists, and a file *named* like a deploy env
 * is flagged whatever it holds, including nothing at all. Until now that behaviour was exercised
 * only by a live-shaped credential sitting in the working tree — a coincidence, not a test: delete
 * the file and the coverage vanished silently. These fixtures carry no real credential anywhere.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scan } from './check-secrets.mjs';

/** One throwaway root per test file, in the OS temp dir — never inside the repo tree. */
let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'edu3d-secret-scan-'));
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

/**
 * Scans a throwaway directory holding exactly `files`, so a case can pass or fail on its own
 * fixtures without another case's files leaking into its findings.
 */
async function scanFiles(files: Record<string, string>) {
  const dir = join(fixtureRoot, randomUUID());
  await mkdir(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return scan(dir);
}

/**
 * Same, but the fixture is a real git repository — the only place where "ignored" means something
 * git itself has verified. `forceAdd` stages past the ignore rule and commits, to build the
 * ignored-but-tracked leak state that a name-based or ignore-blind check cannot distinguish.
 */
async function scanInGitRepo(options: {
  gitignore: string;
  files: Record<string, string>;
  forceAdd?: boolean;
}) {
  const { execFileSync } = await import('node:child_process');
  const dir = join(fixtureRoot, randomUUID());
  await mkdir(dir);
  await writeFile(join(dir, '.gitignore'), options.gitignore);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  const names = Object.keys(options.files);
  for (const [name, body] of Object.entries(options.files)) {
    await writeFile(join(dir, name), body);
  }
  // Ignored paths are staged only under forceAdd — plain `git add` refuses them, which is exactly
  // the guarantee "ignored and untracked" rests on. The non-force fixture stages the gitignore
  // alone and leaves the env files untracked in the tree.
  git('add', ...(options.forceAdd ? names.map((n) => ['-f', n]).flat() : ['.gitignore']));
  git('commit', '-qm', 'fixture');
  return scan(dir);
}

describe('the secret scanner', () => {
  it('flags a file named deploy.env even when it is empty', async () => {
    // The load-bearing case: the finding is the filename, not the contents. An empty file holds no
    // credential, yet a deploy env present in a tree is wrong on its face — this is what makes the
    // check content-independent and immune to being blinded through gitignore.
    const findings = await scanFiles({ 'deploy.env': '' });
    expect(findings).toEqual([
      { file: 'deploy.env', line: 0, name: 'environment file committed', text: '' },
    ]);
  });

  it('flags .env by name the same way', async () => {
    // The other member of the env-file set. Dropping it from that set would leave the deploy.env
    // case green, so the set's full contents get pinned, not just the headline member.
    const findings = await scanFiles({ '.env': '' });
    expect(findings).toEqual([
      { file: '.env', line: 0, name: 'environment file committed', text: '' },
    ]);
  });

  it('does not flag deploy.env.example — the committed template is how operators learn the names', async () => {
    const findings = await scanFiles({ 'deploy.env.example': 'AI_API_KEY=replace-me\n' });
    expect(findings).toEqual([]);
  });

  it('does not flag .env.example', async () => {
    const findings = await scanFiles({ '.env.example': 'AI_API_KEY=replace-me\n' });
    expect(findings).toEqual([]);
  });

  it('still flags deploy.env when a .gitignore in the same tree ignores it', async () => {
    // No git repo in this throwaway fixture, so git cannot confirm the ignore rule actually
    // governs the path — and unconfirmable stays a finding. See the repo-fixture tests below for
    // the state git CAN confirm.
    const findings = await scanFiles({
      '.gitignore': 'deploy.env\n',
      'deploy.env': '',
    });
    expect(findings).toEqual([
      { file: 'deploy.env', line: 0, name: 'environment file committed', text: '' },
    ]);
  });

  it('allows a deploy.env that git confirms is ignored and untracked — the documented workflow', async () => {
    // README: `cp deploy.env.example deploy.env`; docker-compose reads that exact file. The
    // platform's own setup instructions therefore put this file in every configured working tree,
    // so "present" cannot itself be the finding — the dangerous state is narrower: a file git
    // would actually commit. A real repo fixture proves the two-part condition: the name is
    // ignored AND the path carries no committed history. Flakes here mean git is missing.
    const repo = await scanInGitRepo({
      gitignore: 'deploy.env\n',
      files: { 'deploy.env': 'AI_API_KEY=fixture-not-real\n' },
    });
    expect(repo).toEqual([]);
  });

  it('flags deploy.env when git tracks it, even though gitignore names it', async () => {
    // The state the original design feared, stated precisely: gitignore cannot untrack a file.
    // `git add .` skips tracked changes, but `git commit -am` commits them — so ignored-but-
    // tracked is the exact leak-path this test keeps covered.
    const repo = await scanInGitRepo({
      gitignore: 'deploy.env\n',
      files: { 'deploy.env': 'AI_API_KEY=fixture-not-real\n' },
      forceAdd: true,
    });
    expect(repo).toEqual([
      { file: 'deploy.env', line: 0, name: 'environment file committed', text: '' },
    ]);
  });

  it('suppresses an offending line only when the allow-marker sits on that line', async () => {
    // The marker is `secret-scan-ok` and its scope is the line: the identical credential one line
    // below stays a finding, so an exemption can never widen into a file-wide off switch. The
    // echoed text is asserted too — a scanner that prints the secret it found has leaked it again.
    const findings = await scanFiles({
      'notes.md': [
        'key = sk-abcdefghijklmnopqrstuvwxyz012345 # secret-scan-ok',
        // The line below is this suite's *control* credential — a fake, but signature-shaped, so
        // the scanner flags this test file's own source. The trailing marker is the documented
        // remedy, and it lives in a comment so the string the scanner-under-test sees is unchanged.
        'key = sk-abcdefghijklmnopqrstuvwxyz012345', // secret-scan-ok
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([
      { file: 'notes.md', line: 2, name: 'OpenAI key', text: 'key = <redacted>' },
    ]);
  });
});
