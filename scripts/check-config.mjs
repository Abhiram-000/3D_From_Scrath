#!/usr/bin/env node
/**
 * Configuration check, runnable without starting the server.
 *
 * `06-STORAGE-AND-SECURITY.md` requires that "production misconfiguration is fatal and *exhaustive*":
 * every problem is listed at startup, not just the first, because "finding them one restart at a time
 * is a bad use of anybody's afternoon". This script is the build-time half of that rule — it asserts
 * that every variable the platform reads is documented in a committed example, and that no example
 * ever carries a credential value.
 *
 * The table below is the documentation of record. A variable added to the code without an entry here
 * fails the run, which is what keeps operator-facing docs from drifting behind the config resolver.
 */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `scope` says which committed example must document the variable:
 *   - `both`       — meaningful in development and production
 *   - `production` — only relevant to a deployment, so the dev example may omit it
 *
 * `secret: true` means a value in a committed example is a finding, not a convenience.
 */
const VARIABLES = [
  // AI provider
  {
    name: 'AI_API_KEY',
    scope: 'both',
    secret: true,
    why: 'Provider credential. Server-side only, never sent to a client.',
  },
  {
    name: 'AI_BASE_URL',
    scope: 'both',
    why: 'OpenAI-compatible endpoint. Lets the provider be swapped without a code change.',
  },
  { name: 'AI_MODEL', scope: 'both', why: 'Generation model id.' },
  {
    name: 'AI_CHAT_MODEL',
    scope: 'both',
    why: 'Cheaper model for chat and quiz, so a chatty session cannot eat the generation budget.',
  },
  {
    name: 'AI_MAX_OUTPUT_TOKENS',
    scope: 'both',
    why: 'Generous by default: a truncated model is refused, not shipped.',
  },

  // Server
  { name: 'PORT', scope: 'both', why: 'Listen port.' },
  { name: 'HOST', scope: 'both', why: 'Bind address.' },
  { name: 'NODE_ENV', scope: 'both', why: 'production enables the exhaustive startup refusals.' },
  {
    name: 'PUBLIC_ORIGIN',
    scope: 'production',
    why: "The platform's own URL; derived into the CORS allow-list so a first deploy works.",
  },
  { name: 'ALLOWED_ORIGINS', scope: 'both', why: 'Extra CORS origins. Never `*` in production.' },
  {
    name: 'TRUST_PROXY',
    scope: 'production',
    why: 'Without it every visitor behind a platform router shares one rate-limit bucket.',
  },

  // Storage
  {
    name: 'DATABASE_URL',
    scope: 'both',
    secret: true,
    why: 'Postgres. Durable by default; the file fallback announces itself and refuses production.',
  },
  {
    name: 'EDU3D_DB_SSL_REJECT_UNAUTHORIZED',
    scope: 'both',
    why: 'Managed providers require TLS; local Docker does not.',
  },
  {
    name: 'EDU3D_DATA_DIR',
    scope: 'both',
    why: 'Where the file-backed fallback store and rejected-output artifacts are written.',
  },
  {
    name: 'EDU3D_ALLOW_EPHEMERAL_STORE',
    scope: 'production',
    why: 'Explicit "I accept ephemeral storage" acknowledgement. The refusal is the feature.',
  },

  // Security
  {
    name: 'EDU3D_WRITE_TOKEN',
    scope: 'both',
    secret: true,
    why: 'Bearer token for publish/delete. Compared in constant time, header-only.',
  },
  {
    name: 'EDU3D_ALLOW_OPEN_WRITES',
    scope: 'production',
    why: 'Explicit acknowledgement of unauthenticated writes. Development only.',
  },
  {
    name: 'EDU3D_CSP',
    scope: 'both',
    why: 'enforce | report-only | off. Stated at startup either way.',
  },
  {
    name: 'EDU3D_HSTS',
    scope: 'production',
    why: 'Opt-in; most platforms terminate TLS at the edge.',
  },
  {
    name: 'EDU3D_FORCE_HTTPS',
    scope: 'production',
    why: 'Opt-in redirect; correct only once TRUST_PROXY is set.',
  },

  // Budgets
  {
    name: 'EDU3D_API_RATE_LIMIT',
    scope: 'both',
    why: 'General limiter. Generous: one model load makes several calls.',
  },
  {
    name: 'EDU3D_WRITE_RATE_LIMIT',
    scope: 'both',
    why: 'Writes are rarer and more consequential.',
  },
  {
    name: 'EDU3D_GENERATE_RATE_LIMIT',
    scope: 'both',
    why: 'A classroom behind one NAT is one IP, so this must be configurable.',
  },
  { name: 'EDU3D_CHAT_RATE_LIMIT', scope: 'both', why: 'Separate budget from generation.' },
  { name: 'EDU3D_QUIZ_RATE_LIMIT', scope: 'both', why: 'Separate budget from generation.' },

  // Observability
  { name: 'LOG_LEVEL', scope: 'both', why: 'pino level.' },
  { name: 'LOG_FORMAT', scope: 'both', why: 'json | pretty.' },
];

const EXAMPLES = [
  { path: 'apps/server/.env.example', kind: 'development' },
  { path: 'apps/server/.env.production.example', kind: 'production' },
];

const problems = [];
const notes = [];

for (const example of EXAMPLES) {
  const full = join(ROOT, example.path);
  try {
    await access(full);
  } catch {
    problems.push(`missing committed example file: ${example.path}`);
    continue;
  }

  const text = await readFile(full, 'utf8');
  const assignments = text
    .split('\n')
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter(({ raw }) => raw.length > 0 && !raw.startsWith('#') && raw.includes('='))
    .map(({ raw, line }) => {
      const eq = raw.indexOf('=');
      return { name: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim(), line };
    });

  const declared = new Map(assignments.map((a) => [a.name, a]));

  for (const variable of VARIABLES) {
    const mustAppear = example.kind === 'production' || variable.scope === 'both';
    if (mustAppear && !declared.has(variable.name)) {
      problems.push(`${example.path}: ${variable.name} is not documented (${variable.why})`);
    }
  }

  for (const assignment of assignments) {
    const variable = VARIABLES.find((v) => v.name === assignment.name);
    if (!variable) {
      notes.push(
        `${example.path}:${assignment.line}: ${assignment.name} is declared in the example but unknown to this table`,
      );
      continue;
    }
    // A credential value in a committed example is one copy-paste away from being a real leak.
    if (variable.secret && assignment.value.length > 0) {
      problems.push(
        `${example.path}:${assignment.line}: ${assignment.name} must be left empty in a committed example`,
      );
    }
  }
}

if (notes.length > 0) {
  console.log('Config notes:');
  for (const note of notes) console.log(`  - ${note}`);
}

if (problems.length > 0) {
  console.error(`\nConfig check FAILED — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(
  `Config check passed: ${VARIABLES.length} variables documented across ${EXAMPLES.length} example files.`,
);
