import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCommand, parseRedisUrl, parseReply } from '../src/redis-client.js';
import { DidCache, didCacheKey } from '../src/did-cache.js';

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

/**
 * In-memory stand-in for RedisClient, with hooks to simulate failures.
 */
class FakeRedis {
  constructor({ failOn = null, failCount = Infinity } = {}) {
    this.store = new Map();
    this.failOn = failOn;
    this.failCount = failCount;
    this.calls = [];
    this.connectCalls = 0;
  }

  _maybeFail(operation) {
    if (this.failOn === operation && this.failCount > 0) {
      this.failCount -= 1;
      throw new Error(`simulated ${operation} failure`);
    }
  }

  async connect() {
    this.connectCalls += 1;
    this._maybeFail('connect');
  }

  async ping() {
    return 'PONG';
  }

  async get(key) {
    this.calls.push(['get', key]);
    this._maybeFail('get');
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value, ttlMs) {
    this.calls.push(['set', key, ttlMs]);
    this._maybeFail('set');
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys) {
    this.calls.push(['del', ...keys]);
    this._maybeFail('del');
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async scanKeys(pattern) {
    this._maybeFail('scan');
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }

  async quit() {}
}

function makeConfig(overrides = {}) {
  return {
    redisUrl: 'redis://localhost:6379',
    didCacheTtlMs: 60_000,
    cacheFailureThreshold: 3,
    ...overrides,
  };
}

function makeMetrics() {
  return { counters: {} };
}

// ─── URL parsing and RESP encoding ─────────────────────────────────────────

test('parseRedisUrl handles hosts, ports, auth, db, and TLS', () => {
  assert.deepEqual(parseRedisUrl('redis://localhost:6379'), {
    host: 'localhost',
    port: 6379,
    tls: false,
    username: null,
    password: null,
    db: null,
  });

  const full = parseRedisUrl('rediss://user:p%40ss@cache.example.com:6380/3');
  assert.equal(full.host, 'cache.example.com');
  assert.equal(full.port, 6380);
  assert.equal(full.tls, true);
  assert.equal(full.username, 'user');
  assert.equal(full.password, 'p@ss');
  assert.equal(full.db, 3);
});

test('parseRedisUrl rejects a non-Redis scheme', () => {
  assert.throws(() => parseRedisUrl('http://localhost:6379'), /Unsupported Redis protocol/);
});

test('encodeCommand produces a RESP array of bulk strings', () => {
  assert.equal(encodeCommand(['GET', 'key']), '*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n');
});

test('encodeCommand measures byte length, not character count', () => {
  // "é" is two bytes in UTF-8; a length of 1 would desynchronise the stream.
  assert.equal(encodeCommand(['SET', 'é']), '*2\r\n$3\r\nSET\r\n$2\r\né\r\n');
});

test('parseReply decodes each RESP type', () => {
  assert.deepEqual(parseReply(Buffer.from('+OK\r\n')), { value: 'OK', consumed: 5 });
  assert.deepEqual(parseReply(Buffer.from(':42\r\n')), { value: 42, consumed: 5 });
  assert.deepEqual(parseReply(Buffer.from('$3\r\nabc\r\n')), { value: 'abc', consumed: 9 });
  assert.deepEqual(parseReply(Buffer.from('$-1\r\n')), { value: null, consumed: 5 });

  const array = parseReply(Buffer.from('*2\r\n$1\r\na\r\n$1\r\nb\r\n'));
  assert.deepEqual(array.value, ['a', 'b']);

  const error = parseReply(Buffer.from('-ERR nope\r\n'));
  assert.ok(error.value instanceof Error);
  assert.equal(error.value.message, 'ERR nope');
});

test('parseReply returns null until a full reply has arrived', () => {
  assert.equal(parseReply(Buffer.from('$5\r\nabc')), null);
  // The trailing CRLF is part of the reply and must be present.
  assert.equal(parseReply(Buffer.from('$3\r\nabc')), null);
  assert.deepEqual(parseReply(Buffer.from('$3\r\nabc\r\n')), { value: 'abc', consumed: 9 });
});

// ─── Key normalisation ─────────────────────────────────────────────────────

test('didCacheKey normalises a DID and a bare address to one key', () => {
  assert.equal(didCacheKey(ADDRESS), didCacheKey(`did:stellar:${ADDRESS}`));
  assert.equal(didCacheKey(ADDRESS), `did:doc:${ADDRESS}`);
});

// ─── Cache behaviour ───────────────────────────────────────────────────────

test('get and set round-trip a document and count hits and misses', async () => {
  const metrics = makeMetrics();
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client, metrics });
  await cache.connect();

  assert.equal(await cache.get(ADDRESS), null);
  assert.equal(cache.stats.misses, 1);
  assert.equal(metrics.counters.did_cache_misses_total, 1);

  const document = { id: `did:stellar:${ADDRESS}`, active: true };
  assert.equal(await cache.set(ADDRESS, document), true);

  assert.deepEqual(await cache.get(ADDRESS), document);
  assert.equal(cache.stats.hits, 1);
  assert.equal(metrics.counters.did_cache_hits_total, 1);
});

test('set applies the configured TTL', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig({ didCacheTtlMs: 1234 }), { client });
  await cache.connect();

  await cache.set(ADDRESS, { id: 'x' });
  const setCall = client.calls.find((call) => call[0] === 'set');
  assert.equal(setCall[2], 1234);
});

test('a DID and its bare address share one cache entry', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  await cache.set(`did:stellar:${ADDRESS}`, { id: 'shared' });
  assert.deepEqual(await cache.get(ADDRESS), { id: 'shared' });
});

test('invalidate removes one entry', async () => {
  const metrics = makeMetrics();
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client, metrics });
  await cache.connect();

  await cache.set(ADDRESS, { id: 'x' });
  assert.equal(await cache.invalidate(ADDRESS), true);
  assert.equal(await cache.get(ADDRESS), null);
  assert.equal(metrics.counters.did_cache_invalidations_total, 1);
});

test('invalidateAll clears every cached DID and leaves other keys alone', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  await cache.set('GAAA', { id: 'a' });
  await cache.set('GBBB', { id: 'b' });
  client.store.set('other:key', 'untouched');

  assert.equal(await cache.invalidateAll(), 2);
  assert.equal(client.store.get('other:key'), 'untouched');
});

test('a corrupt entry is treated as a miss and dropped', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  client.store.set(didCacheKey(ADDRESS), '{not json');

  assert.equal(await cache.get(ADDRESS), null);
  assert.equal(cache.stats.misses, 1);
  // Dropped rather than left to poison every later read.
  assert.equal(client.store.has(didCacheKey(ADDRESS)), false);
});

test('the cache is disabled without a Redis URL and reports every op as a miss', async () => {
  const cache = new DidCache(makeConfig({ redisUrl: '' }));

  assert.equal(await cache.connect(), false);
  assert.equal(cache.enabled, false);
  assert.equal(await cache.get(ADDRESS), null);
  assert.equal(await cache.set(ADDRESS, { id: 'x' }), false);
  assert.equal(cache.getStats().enabled, false);
});

test('a failed connection leaves the cache unusable without throwing', async () => {
  const client = new FakeRedis({ failOn: 'connect' });
  const cache = new DidCache(makeConfig(), { client });

  assert.equal(await cache.connect(), false);
  assert.equal(cache.available, false);
  // Reads still answer, as a miss.
  assert.equal(await cache.get(ADDRESS), null);
});

test('a read failure degrades to a miss rather than throwing', async () => {
  const metrics = makeMetrics();
  const client = new FakeRedis({ failOn: 'get', failCount: 1 });
  const cache = new DidCache(makeConfig(), { client, metrics });
  await cache.connect();

  assert.equal(await cache.get(ADDRESS), null);
  assert.equal(cache.stats.errors, 1);
  assert.equal(metrics.counters.did_cache_errors_total, 1);
});

test('repeated failures take the cache out of circuit and trigger a reconnect', async () => {
  // Reconnect also fails, so the breaker stays open and the state is stable
  // to assert on.
  const client = new FakeRedis({ failOn: 'get', failCount: 3 });
  client.connect = async function connect() {
    this.connectCalls += 1;
    if (this.connectCalls > 1) throw new Error('simulated reconnect failure');
  };

  const cache = new DidCache(makeConfig({ cacheFailureThreshold: 3 }), { client });
  await cache.connect();

  await cache.get(ADDRESS);
  await cache.get(ADDRESS);
  assert.equal(cache.usable, true);

  await cache.get(ADDRESS);
  // Third consecutive failure trips the breaker.
  assert.equal(cache.usable, false);
  assert.equal(cache.available, false);

  // A reconnect was attempted in the background rather than left dead.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.connectCalls > 1);

  // Reads keep answering as misses while the breaker is open.
  assert.equal(await cache.get(ADDRESS), null);
});

test('a successful background reconnect closes the breaker again', async () => {
  const client = new FakeRedis({ failOn: 'get', failCount: 3 });
  const cache = new DidCache(makeConfig({ cacheFailureThreshold: 3 }), { client });
  await cache.connect();

  await cache.get(ADDRESS);
  await cache.get(ADDRESS);
  await cache.get(ADDRESS);

  // The background reconnect succeeds because the simulated failures are spent.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.available, true);
  assert.equal(cache.consecutiveFailures, 0);
  assert.equal(cache.usable, true);
});

test('a successful read resets the failure counter', async () => {
  const client = new FakeRedis({ failOn: 'get', failCount: 1 });
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  await cache.get(ADDRESS);
  assert.equal(cache.consecutiveFailures, 1);

  await cache.set(ADDRESS, { id: 'x' });
  await cache.get(ADDRESS);
  assert.equal(cache.consecutiveFailures, 0);
});

test('warm pre-populates the cache and survives individual failures', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  const result = await cache.warm(['GAAA', 'GBBB', 'GCCC'], async (did) => {
    if (did === 'GBBB') throw new Error('rpc down');
    if (did === 'GCCC') return null;
    return { id: `did:stellar:${did}` };
  });

  assert.equal(result.warmed, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(await cache.get('GAAA'), { id: 'did:stellar:GAAA' });
});

test('warm is a no-op when the cache is unusable', async () => {
  const cache = new DidCache(makeConfig({ redisUrl: '' }));
  const result = await cache.warm(['GAAA'], async () => ({ id: 'x' }));

  assert.equal(result.warmed, 0);
  assert.equal(result.skipped, 1);
});

test('getStats reports a hit rate', async () => {
  const client = new FakeRedis();
  const cache = new DidCache(makeConfig(), { client });
  await cache.connect();

  await cache.set(ADDRESS, { id: 'x' });
  await cache.get(ADDRESS);
  await cache.get('GMISSING');

  const stats = cache.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
  assert.equal(stats.enabled, true);
  assert.equal(stats.ttlMs, 60_000);
});

test('getStats reports a zero hit rate before any lookup', async () => {
  const cache = new DidCache(makeConfig(), { client: new FakeRedis() });
  assert.equal(cache.getStats().hitRate, 0);
});
