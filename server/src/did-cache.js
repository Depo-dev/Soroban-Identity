import { RedisClient } from './redis-client.js';
import { logger } from './logger.js';

const KEY_PREFIX = 'did:doc:';

/**
 * Normalise a DID or bare Stellar address into a stable cache key.
 *
 * `did:stellar:G...` and a bare `G...` refer to the same document, so they must
 * not occupy two cache entries that can drift apart on invalidation.
 */
export function didCacheKey(didOrAddress) {
  const value = String(didOrAddress ?? '');
  const address = value.startsWith('did:stellar:') ? value.slice('did:stellar:'.length) : value;
  return `${KEY_PREFIX}${address}`;
}

/**
 * Redis-backed cache for resolved DID documents.
 *
 * Every operation degrades to a miss when Redis is unavailable: a cache outage
 * must slow the service down, never break it. Failures are counted and logged,
 * and the cache stops being consulted after repeated failures until a
 * reconnect succeeds, so a dead Redis does not add its timeout to every
 * request.
 */
export class DidCache {
  constructor(config, { client = null, metrics = null } = {}) {
    this.config = config;
    this.metrics = metrics;
    this.ttlMs = config.didCacheTtlMs ?? 60_000;
    this.enabled = Boolean(config.redisUrl);
    this.failureThreshold = config.cacheFailureThreshold ?? 3;

    this.client =
      client ??
      (this.enabled
        ? new RedisClient(config.redisUrl, {
            maxRetries: config.redisMaxRetries ?? 5,
            retryBaseMs: config.redisRetryBaseMs ?? 200,
            commandTimeoutMs: config.redisCommandTimeoutMs ?? 1000,
          })
        : null);

    this.available = false;
    this.consecutiveFailures = 0;
    this.stats = { hits: 0, misses: 0, errors: 0, sets: 0, invalidations: 0 };
  }

  /**
   * Connect to Redis. A failure here is logged and swallowed — the service
   * starts and runs uncached rather than refusing to boot.
   */
  async connect() {
    if (!this.enabled || !this.client) {
      logger.info('DID cache disabled (REDIS_URL is not configured)');
      return false;
    }
    try {
      await this.client.connect();
      this.available = true;
      this.consecutiveFailures = 0;
      logger.info({ ttlMs: this.ttlMs }, 'DID cache connected');
      return true;
    } catch (error) {
      this.available = false;
      logger.error({ error: error.message }, 'DID cache unavailable; continuing without cache');
      return false;
    }
  }

  /**
   * Whether a cache operation should even be attempted.
   */
  get usable() {
    return this.enabled && this.available && this.consecutiveFailures < this.failureThreshold;
  }

  _recordMetric(name) {
    if (this.metrics && typeof this.metrics.counters === 'object') {
      this.metrics.counters[name] = (this.metrics.counters[name] ?? 0) + 1;
    }
  }

  /**
   * Record a cache-layer failure. After `failureThreshold` consecutive
   * failures the cache is marked unusable and a reconnect is attempted in the
   * background, so requests stop paying the Redis timeout.
   */
  _recordFailure(operation, error) {
    this.stats.errors += 1;
    this.consecutiveFailures += 1;
    this._recordMetric('did_cache_errors_total');
    logger.warn(
      { operation, error: error.message, consecutiveFailures: this.consecutiveFailures },
      'DID cache operation failed',
    );

    if (this.consecutiveFailures === this.failureThreshold) {
      logger.error(
        { failureThreshold: this.failureThreshold },
        'DID cache disabled after repeated failures; attempting reconnect in the background',
      );
      this.available = false;
      void this._reconnect();
    }
  }

  async _reconnect() {
    try {
      await this.client.connect();
      this.available = true;
      this.consecutiveFailures = 0;
      logger.info('DID cache reconnected');
    } catch (error) {
      logger.warn({ error: error.message }, 'DID cache reconnect failed');
    }
  }

  /**
   * Read a cached DID document.
   *
   * @returns {Promise<object|null>} The document, or null on a miss, a parse
   *   failure, or any cache error.
   */
  async get(didOrAddress) {
    if (!this.usable) return null;

    try {
      const raw = await this.client.get(didCacheKey(didOrAddress));
      if (raw === null || raw === undefined) {
        this.stats.misses += 1;
        this._recordMetric('did_cache_misses_total');
        return null;
      }

      this.consecutiveFailures = 0;
      this.stats.hits += 1;
      this._recordMetric('did_cache_hits_total');
      return JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // A corrupt entry is treated as a miss and dropped, rather than
        // poisoning every subsequent read of that DID.
        this.stats.misses += 1;
        this._recordMetric('did_cache_misses_total');
        void this.invalidate(didOrAddress);
        return null;
      }
      this._recordFailure('get', error);
      return null;
    }
  }

  /**
   * Cache a resolved DID document with a TTL.
   */
  async set(didOrAddress, document, ttlMs = this.ttlMs) {
    if (!this.usable || document === null || document === undefined) return false;

    try {
      await this.client.set(didCacheKey(didOrAddress), JSON.stringify(document), ttlMs);
      this.consecutiveFailures = 0;
      this.stats.sets += 1;
      this._recordMetric('did_cache_sets_total');
      return true;
    } catch (error) {
      this._recordFailure('set', error);
      return false;
    }
  }

  /**
   * Drop one DID from the cache. Call this whenever a DID is created or
   * updated, so a stale document cannot outlive the write that changed it.
   */
  async invalidate(didOrAddress) {
    if (!this.enabled || !this.client) return false;

    try {
      await this.client.del(didCacheKey(didOrAddress));
      this.stats.invalidations += 1;
      this._recordMetric('did_cache_invalidations_total');
      return true;
    } catch (error) {
      this._recordFailure('invalidate', error);
      return false;
    }
  }

  /**
   * Drop every cached DID document. Uses SCAN rather than KEYS so a large
   * keyspace does not block the Redis event loop.
   */
  async invalidateAll() {
    if (!this.usable) return 0;

    try {
      const keys = await this.client.scanKeys(`${KEY_PREFIX}*`);
      if (keys.length === 0) return 0;
      await this.client.del(...keys);
      this.stats.invalidations += keys.length;
      logger.info({ count: keys.length }, 'DID cache flushed');
      return keys.length;
    } catch (error) {
      this._recordFailure('invalidateAll', error);
      return 0;
    }
  }

  /**
   * Pre-populate the cache for a set of DIDs.
   *
   * Resolution failures are counted and skipped rather than aborting the warm,
   * so one bad DID cannot prevent the rest from being cached.
   *
   * @param {string[]} dids
   * @param {(did: string) => Promise<object|null>} resolve
   */
  async warm(dids, resolve) {
    if (!this.usable || !Array.isArray(dids) || dids.length === 0) {
      return { warmed: 0, failed: 0, skipped: dids?.length ?? 0 };
    }

    let warmed = 0;
    let failed = 0;

    for (const did of dids) {
      try {
        const document = await resolve(did);
        if (document) {
          await this.set(did, document);
          warmed += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn({ did, error: error.message }, 'DID cache warm failed for one entry');
      }
    }

    logger.info({ warmed, failed, total: dids.length }, 'DID cache warm complete');
    return { warmed, failed, skipped: 0 };
  }

  /**
   * Hit/miss counters plus a derived hit rate, for the metrics endpoint.
   */
  getStats() {
    const lookups = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      enabled: this.enabled,
      available: this.available,
      ttlMs: this.ttlMs,
      hitRate: lookups === 0 ? 0 : Number((this.stats.hits / lookups).toFixed(4)),
    };
  }

  async close() {
    if (this.client) await this.client.quit();
    this.available = false;
  }
}
