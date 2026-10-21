/**
 * Config resolution tests.
 *
 * The resolver is a pure function of an environment map precisely so this suite can exist: `06` requires
 * production to refuse to start on unsafe configuration and to report *every* problem at once, and both
 * of those are claims that only a test can keep true. Spawning processes to check them would be slow
 * enough that nobody would run it.
 */
import { describe, expect, it } from 'vitest';
import {
  formatStartupReport,
  parseBoolean,
  parseInteger,
  parseList,
  resolveConfig,
  shouldRefuseToStart,
} from '../src/config/config.ts';

/** A production environment with every required variable satisfied. */
const validProduction = {
  NODE_ENV: 'production',
  AI_API_KEY: 'test-key',
  DATABASE_URL: 'postgres://user:pass@db.example/edu3d',
  EDU3D_WRITE_TOKEN: 'a-long-random-secret',
  PUBLIC_ORIGIN: 'https://edu3d.example',
  TRUST_PROXY: '1',
} satisfies Record<string, string>;

describe('parseBoolean', () => {
  it('treats the string "false" as false', () => {
    // The scar 06 names by hand: `"false"` is a truthy string, and a naive check leaves the flag on.
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('FALSE', true)).toBe(false);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('off', true)).toBe(false);
    expect(parseBoolean('no', true)).toBe(false);
  });

  it('accepts the affirmative spellings operators actually use', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'enabled']) {
      expect(parseBoolean(value, false), value).toBe(true);
    }
  });

  it('falls back for unset and unrecognised values', () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean('', false)).toBe(false);
    expect(parseBoolean('maybe', true)).toBe(true);
  });
});

describe('parseInteger and parseList', () => {
  it('rejects nonsense rather than producing NaN', () => {
    expect(parseInteger('abc', 42)).toBe(42);
    expect(parseInteger('-5', 42)).toBe(42);
    expect(parseInteger('0', 42)).toBe(42);
    expect(parseInteger('600', 42)).toBe(600);
  });

  it('trims and drops blanks in a list', () => {
    expect(parseList('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('development defaults', () => {
  const config = resolveConfig({});

  it('starts with no configuration at all', () => {
    expect(shouldRefuseToStart(config)).toBe(false);
    expect(config.env).toBe('development');
  });

  it('falls back to the file store and says so', () => {
    expect(config.storage.backend).toBe('file');
    expect(config.warnings.map((w) => w.variable)).toContain('DATABASE_URL');
  });

  it('treats a missing AI key as a degraded mode, not a failure', () => {
    // 04: no key means generation answers 503 while the gallery and viewer keep working entirely.
    expect(config.ai.configured).toBe(false);
    expect(config.problems).toHaveLength(0);
    expect(config.warnings.map((w) => w.variable)).toContain('AI_API_KEY');
  });

  it('announces that writes are open', () => {
    expect(config.security.writeToken).toBeNull();
    expect(config.warnings.map((w) => w.variable)).toContain('EDU3D_WRITE_TOKEN');
  });

  it('trusts localhost origins only outside production', () => {
    expect(config.allowedOrigins.some((origin) => origin.includes('localhost'))).toBe(true);
    const production = resolveConfig(validProduction);
    expect(production.allowedOrigins.some((origin) => origin.includes('localhost'))).toBe(false);
  });
});

describe('production refusals', () => {
  it('starts when everything required is present', () => {
    const config = resolveConfig(validProduction);
    expect(config.problems).toEqual([]);
    expect(shouldRefuseToStart(config)).toBe(false);
  });

  it('refuses without a database, and explains the loss', () => {
    const { DATABASE_URL: _omitted, ...env } = validProduction;
    const config = resolveConfig(env);
    expect(shouldRefuseToStart(config)).toBe(true);
    const problem = config.problems.find((p) => p.variable === 'DATABASE_URL');
    expect(problem?.message).toMatch(/share link/i);
    expect(problem?.fix).toMatch(/EDU3D_ALLOW_EPHEMERAL_STORE/);
  });

  it('accepts ephemeral storage when the operator says so explicitly', () => {
    // The refusal is the feature, and the acknowledgement is the escape hatch — not the default.
    const { DATABASE_URL: _omitted, ...env } = validProduction;
    const config = resolveConfig({ ...env, EDU3D_ALLOW_EPHEMERAL_STORE: 'true' });
    expect(config.problems.map((p) => p.variable)).not.toContain('DATABASE_URL');
    expect(config.storage.backend).toBe('file');
  });

  it('refuses with unauthenticated writes', () => {
    const { EDU3D_WRITE_TOKEN: _omitted, ...env } = validProduction;
    const config = resolveConfig(env);
    expect(shouldRefuseToStart(config)).toBe(true);
    expect(config.problems.map((p) => p.variable)).toContain('EDU3D_WRITE_TOKEN');
  });

  it('keeps open writes possible in production only through the explicit escape hatch', async () => {
    // Guard, not regression: the boot refusal stays the loud half, and app.ts's requireWriteToken
    // now fails closed at request time too (`allowOpenWrites || !isProduction` with no token) — so
    // the two layers agree: an operator who wants open writes says so exactly once, and everyone
    // else gets a 401 the share modal can prompt for. The authoring pass tests this route-level
    // half (tests/app.test.ts, "the write posture"); this pins the resolver side.
    const { EDU3D_WRITE_TOKEN: _omitted, ...env } = validProduction;
    const config = resolveConfig({ ...env, EDU3D_ALLOW_OPEN_WRITES: 'true' });
    expect(config.problems.map((p) => p.variable)).not.toContain('EDU3D_WRITE_TOKEN');
    expect(shouldRefuseToStart(config)).toBe(false);
    expect(config.security.allowOpenWrites).toBe(true);
    expect(config.security.writeToken).toBeNull();
  });

  it('refuses without proxy trust, the setting that silently breaks rate limiting', () => {
    const { TRUST_PROXY: _omitted, ...env } = validProduction;
    const config = resolveConfig(env);
    expect(shouldRefuseToStart(config)).toBe(true);
    const problem = config.problems.find((p) => p.variable === 'TRUST_PROXY');
    expect(problem?.message).toMatch(/429/);
  });

  it('refuses a wildcard origin', () => {
    const config = resolveConfig({ ...validProduction, ALLOWED_ORIGINS: '*' });
    expect(shouldRefuseToStart(config)).toBe(true);
    expect(config.problems.map((p) => p.variable)).toContain('ALLOWED_ORIGINS');
  });

  it('refuses PUBLIC_ORIGIN when there is no built frontend to serve', () => {
    // The refusal is conditional because PUBLIC_ORIGIN is only load-bearing in a split deployment. With
    // no `index.html` under the static root this process is API-only, so a browser on the frontend's
    // origin is cross-origin by definition — and with nothing allowed, every request is a CORS failure
    // the learner sees as a blank page.
    const { PUBLIC_ORIGIN: _omitted, ...env } = validProduction;
    const config = resolveConfig(env, { staticSitePresent: false });
    expect(shouldRefuseToStart(config)).toBe(true);
    const problem = config.problems.find((p) => p.variable === 'PUBLIC_ORIGIN');
    expect(problem?.fix).toMatch(/PUBLIC_ORIGIN|ALLOWED_ORIGINS/);
  });

  it('accepts a missing PUBLIC_ORIGIN when this server serves the frontend itself', () => {
    // Same origin, so there is no cross-origin request to allow: refusing to boot here would be a false
    // alarm on the single-container deployment the README documents.
    const { PUBLIC_ORIGIN: _omitted, ...env } = validProduction;
    const config = resolveConfig(env, { staticSitePresent: true });
    expect(config.problems.map((p) => p.variable)).not.toContain('PUBLIC_ORIGIN');
    expect(config.warnings.map((w) => w.variable)).toContain('PUBLIC_ORIGIN');
  });

  it('defaults the probe to absent, so a caller that forgets it fails closed', () => {
    // Not `true`: a deploy that never passes the probe and has a separately hosted frontend would
    // otherwise boot with no origin allowed and serve a platform no browser can reach.
    const { PUBLIC_ORIGIN: _omitted, ...env } = validProduction;
    const config = resolveConfig(env);
    expect(config.problems.map((p) => p.variable)).toContain('PUBLIC_ORIGIN');
  });

  it('reports every problem at once rather than the first', () => {
    // The exhaustiveness requirement, stated as a test: four things wrong, four problems reported.
    // PUBLIC_ORIGIN is among them because the probe defaults to "no built frontend" — refusing is the
    // direction that matters when a deploy forgets to say how its frontend is reached.
    const config = resolveConfig({ NODE_ENV: 'production' });
    expect(shouldRefuseToStart(config)).toBe(true);
    const variables = config.problems.map((p) => p.variable);
    expect(variables).toContain('DATABASE_URL');
    expect(variables).toContain('EDU3D_WRITE_TOKEN');
    expect(variables).toContain('TRUST_PROXY');
    expect(variables).toContain('PUBLIC_ORIGIN');
    expect(config.problems.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every problem an actionable fix', () => {
    const config = resolveConfig({ NODE_ENV: 'production' });
    for (const problem of config.problems) {
      expect(problem.fix.length, problem.variable).toBeGreaterThan(20);
    }
  });
});

describe('derived settings', () => {
  it('derives the public origin into the CORS allow-list so a first deploy works', () => {
    const config = resolveConfig(validProduction);
    expect(config.allowedOrigins).toContain('https://edu3d.example');
  });

  it('strips a trailing slash from the public origin, because Origin headers never carry one', () => {
    const config = resolveConfig({ ...validProduction, PUBLIC_ORIGIN: 'https://edu3d.example/' });
    expect(config.allowedOrigins).toContain('https://edu3d.example');
  });

  it('defaults chat to the generation model rather than a guessed cheap one', () => {
    // A wrong hard-coded model id is a confusing provider 404; reusing the configured one always works.
    const config = resolveConfig({ ...validProduction, AI_MODEL: 'some-model' });
    expect(config.ai.chatModel).toBe('some-model');
  });

  it('warns when an HTTPS redirect would loop behind a proxy', () => {
    const config = resolveConfig({
      ...validProduction,
      TRUST_PROXY: '0',
      EDU3D_FORCE_HTTPS: 'true',
    });
    expect(config.warnings.map((w) => w.variable)).toContain('EDU3D_FORCE_HTTPS');
  });

  it('enforces CSP by default in production and reports-only in development', () => {
    expect(resolveConfig(validProduction).security.csp).toBe('enforce');
    expect(resolveConfig({}).security.csp).toBe('report-only');
  });
});

describe('startup report', () => {
  it('lists every problem with its fix', () => {
    const config = resolveConfig({ NODE_ENV: 'production' });
    const report = formatStartupReport(config);
    expect(report).toMatch(/configuration problems \(\d+\)/);
    expect(report).toMatch(/fix:/);
    for (const problem of config.problems) {
      expect(report).toContain(problem.variable);
    }
  });

  it('never prints a secret value', () => {
    // A startup banner is copied into issue reports and CI logs; a key in it is a key leaked.
    const report = formatStartupReport(resolveConfig(validProduction));
    expect(report).not.toContain('test-key');
    expect(report).not.toContain('a-long-random-secret');
    expect(report).not.toContain('pass@db.example');
  });
});
