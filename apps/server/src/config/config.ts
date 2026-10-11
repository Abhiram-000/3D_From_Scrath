/**
 * Configuration: resolved once, into one validated object.
 *
 * `06-STORAGE-AND-SECURITY.md` requires exactly this shape and says why: "Configuration resolves once
 * into one validated object — never `process.env.X` scattered across a dozen call sites with private
 * defaults." Two specific scars from that document are encoded below:
 *
 *   - **Boolean parsing treats `"false"` as false.** The string `"false"` is truthy, which the doc names
 *     as "the most common 'I turned it off and it stayed on' bug".
 *   - **Production misconfiguration is fatal and *exhaustive*.** Every problem is collected and reported
 *     together, because "finding them one restart at a time is a bad use of anybody's afternoon".
 *
 * Nothing else in the server reads `process.env`. That is enforceable by review and by search, and it is
 * what makes the config check runnable in CI without booting anything.
 */
import { z } from 'zod';

/** A problem that prevents production from starting. Collected, never thrown one at a time. */
export interface ConfigProblem {
  variable: string;
  message: string;
  /** What to do about it, in words an operator can act on. */
  fix: string;
}

/** A non-fatal complaint worth stating at startup and exposing on the health endpoint. */
export interface ConfigWarning {
  variable: string;
  message: string;
}

/**
 * Parse a boolean environment variable.
 *
 * Accepts the spellings operators actually use and — critically — treats the *string* `"false"` as false.
 * An unset variable returns the fallback so "not configured" and "configured off" stay distinguishable
 * to the caller when that matters.
 */
export const parseBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalised = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalised)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalised)) return false;
  return fallback;
};

/** Parse a positive integer, falling back rather than producing `NaN` on nonsense. */
export const parseInteger = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Comma-separated list, trimmed and emptied of blanks. */
export const parseList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export const CspMode = z.enum(['enforce', 'report-only', 'off']);
export type CspMode = z.infer<typeof CspMode>;

export const StorageBackend = z.enum(['postgres', 'file']);
export type StorageBackend = z.infer<typeof StorageBackend>;

export interface ServerConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly port: number;
  readonly host: string;
  /** Number of proxy hops to trust when deriving a client IP for rate limiting. */
  readonly trustProxy: number;
  readonly publicOrigin: string | null;
  /** Resolved CORS allow-list. Never `*` in production. */
  readonly allowedOrigins: readonly string[];

  readonly ai: {
    readonly configured: boolean;
    readonly apiKey: string | null;
    readonly baseUrl: string;
    readonly model: string;
    readonly chatModel: string;
    readonly maxOutputTokens: number;
    /**
     * A second, independent provider (`04` resilience: "upstream failures are translated, not
     * propagated"). When the primary is quota-throttled or down, generation falls across to this
     * one rather than failing the learner's wait. Null when unconfigured.
     */
    readonly fallback: {
      readonly apiKey: string | null;
      readonly baseUrl: string;
      readonly model: string;
    } | null;
  };

  readonly storage: {
    readonly backend: StorageBackend;
    readonly databaseUrl: string | null;
    readonly sslRejectUnauthorized: boolean;
    readonly dataDir: string;
    readonly allowEphemeral: boolean;
  };

  readonly security: {
    readonly writeToken: string | null;
    readonly allowOpenWrites: boolean;
    readonly csp: CspMode;
    readonly hsts: boolean;
    readonly forceHttps: boolean;
  };

  readonly limits: {
    readonly api: number;
    readonly write: number;
    readonly generate: number;
    readonly chat: number;
    readonly quiz: number;
  };

  readonly logging: {
    readonly level: string;
    readonly pretty: boolean;
  };

  /** Fatal in production, informational elsewhere. */
  readonly problems: readonly ConfigProblem[];
  /** Always informational; surfaced on the detailed health endpoint. */
  readonly warnings: readonly ConfigWarning[];
}

/** Defaults chosen to be safe in development and to fail loudly rather than quietly in production. */
const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-5',
  maxOutputTokens: 64_000,
  dataDir: '.data',
  limits: { api: 600, write: 30, generate: 12, chat: 60, quiz: 30 },
} as const;

/**
 * Inputs the resolver cannot derive from the environment map.
 *
 * `resolveConfig` is a pure function of its arguments, and that purity is what lets the whole
 * production-refusal matrix be unit-tested without touching the filesystem. "Does this process have a
 * built frontend to serve" is a fact about the disk, so it arrives as a caller-supplied probe rather
 * than an `existsSync` inside the resolver: `main.ts` passes the real answer, tests pass it explicitly,
 * and neither makes the other depend on what happens to be built on the machine.
 */
export interface ResolveConfigDeps {
  /**
   * Whether this process will serve a built frontend from its own origin.
   *
   * Defaults to `false` — absent — deliberately, and the direction is not arbitrary. A caller that
   * forgets to probe lands in the fail-safe direction, where a missing `PUBLIC_ORIGIN` is a refusal.
   * Defaulting to `true` would fail open: a split deployment would boot, allow no origin, and hand
   * learners a blank page with the reason buried in a browser console.
   */
  readonly staticSitePresent?: boolean;
}

/**
 * Resolve configuration from an environment map.
 *
 * Takes the environment as an argument rather than reading `process.env` directly so the resolver is a
 * pure function — which is what lets the whole production-refusal matrix be unit-tested without spawning
 * processes or mutating global state.
 */
export function resolveConfig(
  env: Record<string, string | undefined>,
  deps: ResolveConfigDeps = {},
): ServerConfig {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigWarning[] = [];

  const rawEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  const nodeEnv =
    rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development';
  const isProduction = nodeEnv === 'production';

  // See `ResolveConfigDeps.staticSitePresent`: unknown is treated as absent, which refuses.
  const staticSitePresent = deps.staticSitePresent ?? false;

  // ── AI ─────────────────────────────────────────────────────────────────────
  const apiKey = env.AI_API_KEY?.trim() || null;
  const aiConfigured = apiKey !== null;
  if (!aiConfigured) {
    // Not a problem even in production: `04` requires "no AI key → generation/chat/quiz answer 503 with a
    // hint while the gallery and viewer keep working entirely". A degraded mode is a real mode.
    warnings.push({
      variable: 'AI_API_KEY',
      message:
        'No AI key configured. Generation, chat and quiz will answer 503; the gallery and viewer work normally.',
    });
  }

  // ── Fallback AI provider (optional) ────────────────────────────────────────
  const fallbackKey = env.FALLBACK_AI_API_KEY?.trim() || null;
  const fallback = fallbackKey
    ? {
        apiKey: fallbackKey,
        baseUrl: env.FALLBACK_AI_BASE_URL?.trim() || 'https://freeinference.org/v1',
        model: env.FALLBACK_AI_MODEL?.trim() || 'deepseek-v4-flash',
      }
    : null;

  // ── Storage ────────────────────────────────────────────────────────────────
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  const allowEphemeral = parseBoolean(env.EDU3D_ALLOW_EPHEMERAL_STORE, false);
  const backend: StorageBackend = databaseUrl ? 'postgres' : 'file';

  if (!databaseUrl) {
    if (isProduction && !allowEphemeral) {
      problems.push({
        variable: 'DATABASE_URL',
        message:
          'Production would run on the local file store, so every published model and share link is lost when the filesystem is replaced.',
        fix: 'Set DATABASE_URL to a Postgres connection string, or set EDU3D_ALLOW_EPHEMERAL_STORE=true to accept the loss explicitly.',
      });
    } else {
      warnings.push({
        variable: 'DATABASE_URL',
        message:
          'No DATABASE_URL configured: the gallery is stored in a local file. Published models are lost if this filesystem is replaced.',
      });
    }
  }

  // ── Security ───────────────────────────────────────────────────────────────
  const writeToken = env.EDU3D_WRITE_TOKEN?.trim() || null;
  const allowOpenWrites = parseBoolean(env.EDU3D_ALLOW_OPEN_WRITES, false);
  if (!writeToken) {
    if (isProduction && !allowOpenWrites) {
      problems.push({
        variable: 'EDU3D_WRITE_TOKEN',
        message: 'Publishing and deleting would be open to anyone who can reach this server.',
        fix: 'Set EDU3D_WRITE_TOKEN to a long random secret, or set EDU3D_ALLOW_OPEN_WRITES=true to accept unauthenticated writes.',
      });
    } else {
      warnings.push({
        variable: 'EDU3D_WRITE_TOKEN',
        message:
          'No write token configured: publish and delete are open. Fine locally, never in production.',
      });
    }
  }

  // ── Origins ────────────────────────────────────────────────────────────────
  const publicOrigin = env.PUBLIC_ORIGIN?.trim() || null;
  const configuredOrigins = parseList(env.ALLOWED_ORIGINS);
  const origins = new Set(configuredOrigins);

  // The platform's own advertised URL is derived in automatically, so a first deploy works without
  // hand-listing origins (`06`).
  if (publicOrigin) origins.add(publicOrigin.replace(/\/$/, ''));

  if (!isProduction) {
    // `localhost` is trusted only outside production: `Origin` is whatever the requesting page's address
    // happens to be, so a deployment trusting `http://localhost:*` trusts any developer machine on earth.
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
    origins.add('http://localhost:4173');
  }

  if (isProduction && origins.size === 0) {
    // Whether PUBLIC_ORIGIN is required at all depends on the deployment shape, not on taste. Serving
    // the built site from this same origin (static-pages.ts) makes every request same-origin, so there
    // is nothing to declare. Having no site to serve means this process is API-only, so the browser is
    // necessarily on another origin — and with none allowed, every learner request is a CORS failure.
    if (staticSitePresent) {
      warnings.push({
        variable: 'PUBLIC_ORIGIN',
        message:
          'No CORS origins configured. Fine because this server also serves the built frontend from its own origin; if you meant to deploy it separately, set PUBLIC_ORIGIN to its URL.',
      });
    } else {
      problems.push({
        variable: 'PUBLIC_ORIGIN',
        message:
          'No built frontend to serve and no origin allowed, so this server is API-only and every browser request from the frontend fails CORS.',
        fix: 'Set PUBLIC_ORIGIN to the URL the frontend is served from (or list it in ALLOWED_ORIGINS), or build apps/web so this server serves it from this same origin.',
      });
    }
  }

  if (configuredOrigins.includes('*')) {
    if (isProduction) {
      problems.push({
        variable: 'ALLOWED_ORIGINS',
        message: 'A wildcard origin lets any site on the internet spend this server’s AI budget.',
        fix: 'Replace `*` with the explicit origins that should be allowed.',
      });
    } else {
      warnings.push({
        variable: 'ALLOWED_ORIGINS',
        message: 'Wildcard origin allowed in development only.',
      });
    }
  }

  // ── Proxy trust ────────────────────────────────────────────────────────────
  const trustProxyRaw = env.TRUST_PROXY?.trim();
  const trustProxy = parseInteger(trustProxyRaw, 0);
  if (isProduction && (trustProxyRaw === undefined || trustProxyRaw === '')) {
    // The single most consequential deployed-server setting (`06`): unset, every visitor behind the
    // platform router shares one bucket and the fourth concurrent visitor starts receiving 429s.
    problems.push({
      variable: 'TRUST_PROXY',
      message:
        'Without proxy trust, every visitor behind the platform router shares one rate-limit bucket and legitimate users will receive 429s.',
      fix: 'Set TRUST_PROXY to the number of proxy hops in front of this server (usually 1).',
    });
  }

  const cspRaw = (env.EDU3D_CSP ?? (isProduction ? 'enforce' : 'report-only')).trim().toLowerCase();
  const cspParsed = CspMode.safeParse(cspRaw);
  if (!cspParsed.success) {
    warnings.push({
      variable: 'EDU3D_CSP',
      message: `Unrecognised value "${cspRaw}"; falling back to ${isProduction ? 'enforce' : 'report-only'}.`,
    });
  }
  const csp: CspMode = cspParsed.success
    ? cspParsed.data
    : isProduction
      ? 'enforce'
      : 'report-only';

  const forceHttps = parseBoolean(env.EDU3D_FORCE_HTTPS, false);
  if (forceHttps && trustProxy === 0) {
    // Redirecting on a proxied request without proxy trust produces an infinite redirect loop, because the
    // server sees `http` on every hop no matter what the client used.
    warnings.push({
      variable: 'EDU3D_FORCE_HTTPS',
      message:
        'HTTPS redirect is on but TRUST_PROXY is 0, which will loop behind a TLS-terminating proxy.',
    });
  }

  return {
    env: nodeEnv,
    isProduction,
    port: parseInteger(env.PORT, DEFAULTS.port),
    host: env.HOST?.trim() || DEFAULTS.host,
    trustProxy,
    publicOrigin,
    allowedOrigins: [...origins],

    ai: {
      configured: aiConfigured || fallbackKey !== null,
      apiKey,
      baseUrl: env.AI_BASE_URL?.trim() || DEFAULTS.aiBaseUrl,
      model: env.AI_MODEL?.trim() || DEFAULTS.aiModel,
      // Chat falls back to the generation model rather than to a hard-coded cheap one: a wrong model id is
      // a confusing 404 from the provider, whereas reusing the configured one always works.
      chatModel: env.AI_CHAT_MODEL?.trim() || env.AI_MODEL?.trim() || DEFAULTS.aiModel,
      maxOutputTokens: parseInteger(env.AI_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens),
      fallback,
    },

    storage: {
      backend,
      databaseUrl,
      sslRejectUnauthorized: parseBoolean(env.EDU3D_DB_SSL_REJECT_UNAUTHORIZED, isProduction),
      dataDir: env.EDU3D_DATA_DIR?.trim() || DEFAULTS.dataDir,
      allowEphemeral,
    },

    security: {
      writeToken,
      allowOpenWrites,
      csp,
      hsts: parseBoolean(env.EDU3D_HSTS, false),
      forceHttps,
    },

    limits: {
      api: parseInteger(env.EDU3D_API_RATE_LIMIT, DEFAULTS.limits.api),
      write: parseInteger(env.EDU3D_WRITE_RATE_LIMIT, DEFAULTS.limits.write),
      generate: parseInteger(env.EDU3D_GENERATE_RATE_LIMIT, DEFAULTS.limits.generate),
      chat: parseInteger(env.EDU3D_CHAT_RATE_LIMIT, DEFAULTS.limits.chat),
      quiz: parseInteger(env.EDU3D_QUIZ_RATE_LIMIT, DEFAULTS.limits.quiz),
    },

    logging: {
      level: env.LOG_LEVEL?.trim() || 'info',
      pretty:
        (env.LOG_FORMAT?.trim().toLowerCase() ?? (isProduction ? 'json' : 'pretty')) === 'pretty',
    },

    problems,
    warnings,
  };
}

/**
 * Format the startup report.
 *
 * One function so the wording is identical whether it is printed by the server, by the config check, or
 * by a test asserting the refusal. Exhaustive by construction: it prints the whole list.
 */
export function formatStartupReport(config: ServerConfig): string {
  const lines: string[] = [];
  lines.push(`environment      ${config.env}`);
  lines.push(`listening        http://${config.host}:${config.port}`);
  lines.push(`storage          ${config.storage.backend}`);
  lines.push(
    `ai               ${config.ai.configured ? `${config.ai.model} via ${config.ai.baseUrl}` : 'not configured'}`,
  );
  lines.push(`writes           ${config.security.writeToken ? 'token required' : 'OPEN'}`);
  lines.push(`csp              ${config.security.csp}`);
  lines.push(`trust proxy      ${config.trustProxy}`);
  lines.push(
    `allowed origins  ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'none'}`,
  );

  if (config.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const warning of config.warnings)
      lines.push(`  - ${warning.variable}: ${warning.message}`);
  }

  if (config.problems.length > 0) {
    lines.push('');
    lines.push(`configuration problems (${config.problems.length}):`);
    for (const problem of config.problems) {
      lines.push(`  - ${problem.variable}: ${problem.message}`);
      lines.push(`      fix: ${problem.fix}`);
    }
  }

  return lines.join('\n');
}

/** True when the process must refuse to start. Production only; elsewhere problems are warnings. */
export const shouldRefuseToStart = (config: ServerConfig): boolean =>
  config.isProduction && config.problems.length > 0;
