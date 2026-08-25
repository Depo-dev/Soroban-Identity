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

export class TieredRateLimiter {
  constructor(options = {}) {
    this.tiers = options.tiers ?? RATE_LIMIT_TIERS;
    this.clients = new Map();
    this.now = options.now ?? (() => Date.now());
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
  }
}
