import { logger } from './logger.js';

/**
 * Tiered Rate Limiter (#681)
 *
 * Implements request throttling based on user subscription tiers:
 * - free: 60 reads/min, 20 writes/min (max 60 req/min)
 * - pro: 300 reads/min, 100 writes/min (max 300 req/min)
 * - enterprise: 1200 reads/min, 500 writes/min (max 1200 req/min)
 */

export const RATE_LIMIT_TIERS = {
  free: {
    name: 'free',
    windowMs: 60 * 1000,
    readLimit: 60,
    writeLimit: 20,
    maxRequests: 60,
  },
  pro: {
    name: 'pro',
    windowMs: 60 * 1000,
    readLimit: 300,
    writeLimit: 100,
    maxRequests: 300,
  },
  enterprise: {
    name: 'enterprise',
    windowMs: 60 * 1000,
    readLimit: 1200,
    writeLimit: 500,
    maxRequests: 1200,
  },
};

/**
 * Per-endpoint limits, applied on top of the tier limits.
 *
 * Credential issuance is far more expensive than a read and is the endpoint an
 * abuser would target, so it gets its own much tighter window regardless of
 * tier. The first matching rule wins, so more specific patterns come first.
 */
export const ENDPOINT_RULES = [
  {
    name: 'credential_issuance',
    method: 'POST',
    pattern: /^\/credentials(\/issue)?$/,
    windowMs: 15 * 60 * 1000,
    limit: 10,
  },
  {
    name: 'credential_revocation',
    method: 'POST',
    pattern: /^\/credentials\/[^/]+\/revoke$/,
    windowMs: 15 * 60 * 1000,
    limit: 20,
  },
  {
    name: 'general',
    method: null,
    pattern: /^\//,
    windowMs: 15 * 60 * 1000,
    limit: 100,
  },
];

/**
 * Find the endpoint rule governing a request.
 */
export function matchEndpointRule(method, pathname, rules = ENDPOINT_RULES) {
  const upperMethod = String(method ?? '').toUpperCase();
  return (
    rules.find(
      (rule) =>
        (rule.method === null || rule.method === upperMethod) && rule.pattern.test(pathname),
    ) ?? null
  );
}

/**
 * Whether an address is exempt from rate limiting.
 *
 * Supports exact addresses and CIDR-style `/N` prefixes for IPv4.
 */
export function isWhitelisted(ip, whitelist = []) {
  if (!ip || whitelist.length === 0) return false;

  for (const entry of whitelist) {
    if (!entry.includes('/')) {
      if (entry === ip) return true;
      continue;
    }

    const [network, bitsRaw] = entry.split('/');
    const bits = Number.parseInt(bitsRaw, 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) continue;

    const toInt = (value) => {
      const parts = value.split('.');
      if (parts.length !== 4) return null;
      let total = 0;
      for (const part of parts) {
        const octet = Number.parseInt(part, 10);
        if (!Number.isFinite(octet) || octet < 0 || octet > 255) return null;
        total = total * 256 + octet;
      }
      return total;
    };

    const ipInt = toInt(ip);
    const networkInt = toInt(network);
    if (ipInt === null || networkInt === null) continue;

    // A /0 mask matches everything; shifting by 32 is undefined in JS, so it
    // is handled explicitly rather than via (-1 << (32 - bits)).
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((ipInt & mask) === (networkInt & mask)) return true;
  }

  return false;
}

export class TieredRateLimiter {
  constructor(options = {}) {
    this.tiers = options.tiers ?? RATE_LIMIT_TIERS;
    this.clients = new Map();
    this.now = options.now ?? (() => Date.now());
    this.endpointRules = options.endpointRules ?? ENDPOINT_RULES;
    this.whitelist = options.whitelist ?? [];
    this.trustProxy = options.trustProxy ?? false;
    this.maxBuckets = options.maxBuckets ?? 10_000;
    this.violations = 0;
  }

  /**
   * Drop expired buckets so an unbounded stream of distinct clients cannot grow
   * the map without limit. Called opportunistically on write rather than on a
   * timer, so an idle process does no work.
   */
  evictExpired(now = this.now()) {
    let evicted = 0;
    for (const [key, state] of this.clients) {
      if (now >= state.resetTime) {
        this.clients.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Consume one unit of the per-endpoint budget for this request.
   *
   * This is independent of the tier budget: a request must satisfy both. It is
   * evaluated first, since the endpoint rules are the tighter constraint on the
   * expensive routes.
   */
  consumeEndpoint(req, pathname) {
    const rule = matchEndpointRule(req.method, pathname, this.endpointRules);
    if (!rule) return { allowed: true, rule: null };

    const clientKey = this.getClientKey(req);
    const bucketKey = `${clientKey}:endpoint:${rule.name}`;
    const now = this.now();

    let state = this.clients.get(bucketKey);
    if (!state || now >= state.resetTime) {
      state = { count: 0, resetTime: now + rule.windowMs, limit: rule.limit, tier: rule.name };
      this.clients.set(bucketKey, state);
    }

    state.count += 1;
    const allowed = state.count <= rule.limit;

    return {
      allowed,
      rule: rule.name,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - state.count),
      resetAt: Math.ceil(state.resetTime / 1000),
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil((state.resetTime - now) / 1000)),
    };
  }

  /**
   * Full check for one request: whitelist, then endpoint budget, then tier
   * budget. Denials are logged so violations are visible in the access log.
   */
  check(req, pathname) {
    const ip = this.resolveIp(req);

    if (isWhitelisted(ip, this.whitelist)) {
      return { allowed: true, whitelisted: true, ip };
    }

    const endpoint = this.consumeEndpoint(req, pathname);
    if (!endpoint.allowed) {
      this.recordViolation({ req, ip, pathname, scope: 'endpoint', result: endpoint });
      return { ...endpoint, allowed: false, scope: 'endpoint', ip };
    }

    const tier = this.consume(req);
    if (!tier.allowed) {
      this.recordViolation({ req, ip, pathname, scope: 'tier', result: tier });
      return { ...tier, allowed: false, scope: 'tier', ip, endpoint };
    }

    // Surface whichever budget is closer to exhaustion, so the headers a client
    // sees reflect the limit that will actually stop them first.
    const binding = endpoint.remaining <= tier.remaining ? endpoint : tier;
    return { ...tier, allowed: true, scope: 'tier', ip, endpoint, binding };
  }

  resolveIp(req) {
    if (this.trustProxy) {
      const forwarded = req.headers?.['x-forwarded-for'];
      if (forwarded) {
        const first = String(forwarded).split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  recordViolation({ req, ip, pathname, scope, result }) {
    this.violations += 1;
    logger.warn(
      {
        type: 'rate_limit_violation',
        scope,
        rule: result.rule ?? result.tier,
        ip,
        method: req.method,
        path: pathname,
        limit: result.limit,
        retryAfter: result.retryAfter,
        apiKeyId: req.apiKeyId ?? null,
        userAgent: req.headers?.['user-agent'] ?? null,
      },
      'Rate limit exceeded',
    );
  }

  resolveTier(req) {
    if (req.userTier && this.tiers[req.userTier.toLowerCase()]) {
      return req.userTier.toLowerCase();
    }
    const headerTier = req.headers?.['x-user-tier']?.toLowerCase();
    if (headerTier && this.tiers[headerTier]) {
      return headerTier;
    }
    if (req.auth?.apiKey?.tier && this.tiers[req.auth.apiKey.tier.toLowerCase()]) {
      return req.auth.apiKey.tier.toLowerCase();
    }
    return 'free';
  }

  getClientKey(req) {
    if (req.apiKeyId) return `key:${req.apiKeyId}`;
    if (req.auth?.apiKey?.id) return `key:${req.auth.apiKey.id}`;
    const forwarded = req.headers?.['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown');
    return `ip:${ip}`;
  }

  consume(req) {
    const tierName = this.resolveTier(req);
    const tier = this.tiers[tierName] ?? this.tiers.free;
    const clientKey = this.getClientKey(req);
    const now = this.now();

    const isWrite = req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    const limit = isWrite ? tier.writeLimit : tier.readLimit;
    const bucketKey = `${clientKey}:${tierName}:${isWrite ? 'write' : 'read'}`;

    let state = this.clients.get(bucketKey);
    if (!state || now >= state.resetTime) {
      if (this.clients.size >= this.maxBuckets) this.evictExpired(now);
      state = {
        count: 1,
        resetTime: now + tier.windowMs,
        limit,
        tier: tierName,
      };
      this.clients.set(bucketKey, state);
      return {
        allowed: true,
        tier: tierName,
        limit,
        remaining: Math.max(0, limit - 1),
        resetAt: Math.ceil(state.resetTime / 1000),
        retryAfter: 0,
      };
    }

    state.count += 1;
    const allowed = state.count <= limit;
    const remaining = Math.max(0, limit - state.count);
    const resetAt = Math.ceil(state.resetTime / 1000);
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((state.resetTime - now) / 1000));

    return {
      allowed,
      tier: tierName,
      limit,
      remaining,
      resetAt,
      retryAfter,
    };
  }

  reset() {
    this.clients.clear();
    this.violations = 0;
  }

  /**
   * Bucket and violation counts, for the metrics endpoint.
   */
  getStats() {
    return {
      buckets: this.clients.size,
      violations: this.violations,
      whitelistEntries: this.whitelist.length,
    };
  }
}
