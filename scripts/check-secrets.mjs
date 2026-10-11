#!/usr/bin/env node
/**
 * Secret scan. Fails the run if anything that looks like a credential is committed.
 *
 * `06-STORAGE-AND-SECURITY.md` requires this to be enforced by tooling rather than memory: "'no
 * secrets in the repo' is enforced by tooling, not memory", and `09` puts it inside the single
 * `verify` gate. The scan is deliberately signature-based rather than entropy-based — entropy alone
 * flags every hash, lockfile integrity line and base64 asset, and a scanner that cries wolf gets
 * disabled, which is the actual failure mode this file exists to avoid.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Directories never worth scanning: generated, vendored, or enormous. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.svelte-kit',
  'coverage',
  'playwright-report',
  'test-results',
  '.pnpm-store',
  '.data',
  'artifacts',
]);

/** Binary and lockfile extensions: no human puts a secret here, and integrity hashes trip the scan. */
const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.wasm',
  '.pdf',
  '.zip',
  '.mp4',
  '.webm',
]);

const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);

/**
 * Provider key signatures.
 *
 * Each pattern matches a *shape a provider actually issues*, so a match is evidence rather than
 * suspicion. Adding a provider here is cheaper than explaining a leak.
 */
const SIGNATURES = [
  { name: 'OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI project key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe secret key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    name: 'Postgres URL with password',
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:'"@]+:[^\s'"@]{6,}@/,
  },
  {
    // A quoted assignment to a key-ish name with a long opaque value.
    name: 'assigned credential',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{24,}['"]/i,
  },
];

/**
 * Lines exempted from the assigned-credential rule.
 *
 * Documentation, examples and this scanner itself must be able to *name* a credential without being
 * accused of holding one. The marker is explicit so an exemption is always a deliberate act.
 */
const ALLOW_MARKER = 'secret-scan-ok';

/** Files whose whole purpose is to name variables without values. */
const isExampleEnv = (path) => basename(path).startsWith('.env') && path.includes('.example');

/**
 * Environment files that are themselves the finding, whatever they are called.
 *
 * `deploy.env` belongs here because it is the one env file `.gitignore` names outright, and a name
 * there buys nothing unless this scan still reads it: the ignore rule exists to keep `git add .` from
 * staging the key, and a scan that honoured ignore rules would therefore skip the very file the ignore
 * rule was added for. The rule below matches on *name* and this scan walks the working tree, never
 * `git ls-files`, so ignored-but-present stays visible — a present secret is the dangerous state, an
 * absent one needs no scanning. Deriving candidates from git would reinstate the blind spot this
 * constant exists to close.
 */
const SECRET_ENV_FILES = new Set(['.env', 'deploy.env']);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (SKIP_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    yield join(dir, entry.name);
  }
}

/** Files larger than this are almost certainly generated data, and scanning them costs seconds. */
const MAX_FILE_BYTES = 2_000_000;

async function scan(root) {
  const findings = [];
  for await (const path of walk(root)) {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) continue;

    const rel = relative(root, path);

    const name = basename(path);

    // A real environment file is itself the finding — no pattern needed.
    if (SECRET_ENV_FILES.has(name) || (name.startsWith('.env.') && !isExampleEnv(path))) {
      findings.push({ file: rel, line: 0, name: 'environment file committed', text: '' });
      continue;
    }

    const text = await readFile(path, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes(ALLOW_MARKER)) continue;
      for (const signature of SIGNATURES) {
        if (signature.pattern.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            name: signature.name,
            // Never echo the value: a scanner that prints the secret it found has leaked it again.
            text: line
              .trim()
              .slice(0, 48)
              .replace(/[A-Za-z0-9_-]{12,}/g, '<redacted>'),
          });
        }
      }
    }
  }
  return findings;
}

/**
 * True only when this file is the process entry point. The CLI must not run on import: the test
 * suite imports `scan` directly, and an import that could `process.exit` would kill the runner.
 */
const isEntryPoint = () => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntryPoint()) {
  const findings = await scan(ROOT);

  if (findings.length > 0) {
    console.error(`\nSecret scan FAILED — ${findings.length} finding(s):\n`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.name}  ${f.text}`);
    }
    console.error(
      '\nRemove the value, move it to an untracked .env, and add the variable name to the matching' +
        ' .env.example. If a match is a false positive, append the marker comment `' +
        ALLOW_MARKER +
        '` to that line.\n',
    );
    process.exit(1);
  }

  console.log('Secret scan passed: no credentials found in tracked files.');
}

export { scan };
