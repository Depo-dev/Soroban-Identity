// Token-bucket rate limiter middleware (#254).
//
// Keyed by API key id (when authenticated) or remote IP. Returns the
// standard `X-RateLimit-*` headers on every response and emits
// `429 Too Many Requests` + `Retry-After` when exhausted. Per-route
// limits configurable via constructor; defaults match the issue:
//   - 60 reads/minute
//   - 20 writes/minute

import { SorobanIdentityError } from "../errors";
import type { AuthContext } from "./api-keys";

export type RateClass = "read" | "write";
export type UserTier = "free" | "pro" | "enterprise";

export interface RateLimitConfig {
  /** Tokens replenished per `windowMs`. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export const TIER_LIMITS: Record<UserTier, Record<RateClass, RateLimitConfig>> = {
  free: {
    read: { limit: 60, windowMs: 60_000 },
    write: { limit: 20, windowMs: 60_000 },
  },
  pro: {
    read: { limit: 300, windowMs: 60_000 },
    write: { limit: 100, windowMs: 60_000 },
  },
  enterprise: {
    read: { limit: 1200, windowMs: 60_000 },
    write: { limit: 500, windowMs: 60_000 },
  },
};

export interface RateLimitOptions {
  tier?: UserTier;
  read?: Partial<RateLimitConfig>;
  write?: Partial<RateLimitConfig>;
  /** Per-key overrides — keyed by `apiKeyId` or `ip:<address>`. */
  overrides?: Record<string, Partial<Record<RateClass, RateLimitConfig>>>;
  now?: () => number;
  /** How to derive the bucket key from the request. Defaults to
   *  `req.auth?.apiKey.id` falling back to `ip:<req.ip>`. */
  keyFn?: (req: RequestLike) => string;
}

export const RATE_LIMIT_DEFAULTS: Record<RateClass, RateLimitConfig> = TIER_LIMITS.free;

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  config: RateLimitConfig;
}

/**
 * Token-bucket rate limiter keyed by API key ID or remote IP.
 *
 * Tokens refill linearly over `windowMs`. Separate buckets are maintained for
 * `read` and `write` rate classes. Per-key overrides can be supplied via
 * {@link RateLimitOptions.overrides}.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly overrides: NonNullable<RateLimitOptions["overrides"]>;
  private readonly readConfig: RateLimitConfig;
  private readonly writeConfig: RateLimitConfig;

  /**
   * @param options Rate limits, per-key overrides, and optional clock override.
   */
  constructor(options: RateLimitOptions = {}) {
    this.now = options.now ?? Date.now;
    this.overrides = options.overrides ?? {};
    this.readConfig = { ...RATE_LIMIT_DEFAULTS.read, ...options.read };
    this.writeConfig = { ...RATE_LIMIT_DEFAULTS.write, ...options.write };
  }

  /** Returns the post-consume state. `allowed === false` means the
   *  caller should reject with 429 and propagate the headers. */
  consume(
    key: string,
    rateClass: RateClass,
  ): { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfterMs: number } {
    const config = this.resolveConfig(key, rateClass);
    const now = this.now();
    // Key includes the rate class so read and write budgets are tracked in
    // separate buckets — a caller cannot consume read tokens to bypass the
    // stricter write limit (Issue #478).
    const bucketKey = `${key}:${rateClass}`;
    const bucket = this.buckets.get(bucketKey) ?? {
      tokens: config.limit,
      lastRefillAt: now,
      config,
    };
    // Refill — fractional tokens added based on elapsed window slice.
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    if (elapsed > 0) {
      const refill = (elapsed / config.windowMs) * config.limit;
      bucket.tokens = Math.min(config.limit, bucket.tokens + refill);
      bucket.lastRefillAt = now;
      bucket.config = config;
    }
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(bucketKey, bucket);
    this.evictStale(now, config.windowMs);
    const remaining = Math.max(0, Math.floor(bucket.tokens));
    // Both resetAt and retryAfterMs are derived from the same "time until the
    // next token is available" calculation so a client reading either value
    // off a response gets consistent retry guidance.
    const msPerToken = config.windowMs / config.limit;
    const tokensNeeded = Math.max(0, 1 - bucket.tokens);
    const timeUntilNextTokenMs = tokensNeeded > 0 ? Math.max(1, Math.ceil(tokensNeeded * msPerToken)) : 0;
    const resetAt = Math.ceil((now + timeUntilNextTokenMs) / 1000);
    const retryAfterMs = allowed ? 0 : timeUntilNextTokenMs;
    return { allowed, limit: config.limit, remaining, resetAt, retryAfterMs };
  }

  private evictStale(now: number, windowMs: number): void {
    for (const [k, b] of this.buckets) {
      if (now - b.lastRefillAt > windowMs) {
        this.buckets.delete(k);
      }
    }
  }

  private resolveConfig(key: string, rateClass: RateClass): RateLimitConfig {
    const override = this.overrides[key]?.[rateClass];
    if (override) return override;
    return rateClass === "read" ? this.readConfig : this.writeConfig;
  }
}

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  auth?: AuthContext;
};
type ResLike = {
  status(code: number): ResLike;
  json(body: unknown): ResLike;
  setHeader(name: string, value: string | number): void;
};
type NextLike = (err?: unknown) => void;

export interface RateLimitMiddlewareOptions extends RateLimitOptions {
  /** Classify the request as read or write. Default: GET/HEAD/OPTIONS → read. */
  classify?: (req: RequestLike, method: string) => RateClass;
  /** Derive user tier from request. Default: req.auth?.apiKey?.tier ?? "free". */
  deriveTier?: (req: RequestLike) => UserTier;
  rateLimiter?: TokenBucketRateLimiter;
}

function defaultKey(req: RequestLike): string {
  return req.auth?.apiKey.id ?? `ip:${req.ip ?? "unknown"}`;
}

function defaultClassify(_req: RequestLike, method: string): RateClass {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

function defaultDeriveTier(req: RequestLike): UserTier {
  return (req.auth?.apiKey as (ApiKeyMetadata & { tier?: UserTier }) | undefined)?.tier ?? "free";
}

/**
 * Create an Express-compatible rate-limit middleware backed by
 * {@link TokenBucketRateLimiter}.
 *
 * Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and
 * `X-RateLimit-Tier` headers on every response. Returns `429 Too Many Requests` with a
 * `Retry-After` header when a bucket is exhausted.
 *
 * @param options Rate limit config, classifier, optional pre-built limiter.
 * @returns Synchronous middleware function `(req, res, next) => void`.
 *
 * @example
 * ```ts
 * app.use(createRateLimitMiddleware({ read: { limit: 120, windowMs: 60_000 } }));
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions = {}) {
  const limiter = options.rateLimiter ?? new TokenBucketRateLimiter(options);
  const keyFn = options.keyFn ?? defaultKey;
  const classifyFn = options.classify ?? defaultClassify;
  const deriveTierFn = options.deriveTier ?? defaultDeriveTier;
  return function rateLimit(
    req: RequestLike & { method?: string },
    res: ResLike,
    next: NextLike,
  ): void {
    const tier = deriveTierFn(req);
    const key = keyFn(req);
    const rateClass = classifyFn(req, req.method ?? "GET");
    const result = limiter.consume(key, rateClass);
    res.setHeader("X-RateLimit-Tier", tier);
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", result.resetAt);
    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      if (tier === "free") {
        res.setHeader("X-Upgrade-Available", "Upgrade to Pro/Enterprise for higher limits: https://soroban-identity.org/pricing");
      }
      const err = new SorobanIdentityError("rate limit exceeded", {
        code: "RATE_LIMITED",
        details: {
          tier,
          limit: result.limit,
          resetAt: result.resetAt,
          retryAfterMs: result.retryAfterMs,
          ...(tier === "free"
            ? {
                upgrade: {
                  message: "Upgrade to Pro (300 req/min) or Enterprise (1200 req/min) for increased rate limits.",
                  url: "https://soroban-identity.org/pricing",
                },
              }
            : {}),
        },
      });
      res.status(429).json({ error: err.toEnvelope() });
      return;
    }
    next();
  };
}
