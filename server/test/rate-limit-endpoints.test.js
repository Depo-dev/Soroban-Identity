import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDPOINT_RULES,
  TieredRateLimiter,
  isWhitelisted,
  matchEndpointRule,
} from '../src/rate-limiter.js';

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '10.0.0.5' },
    ...overrides,
  };
}

/**
 * Limiter with a controllable clock, so window expiry is deterministic.
 */
function makeLimiter(options = {}) {
  let now = 1_000_000;
  const limiter = new TieredRateLimiter({ now: () => now, ...options });
  return {
    limiter,
    advance(ms) {
      now += ms;
    },
  };
}

// ─── Endpoint rule matching ────────────────────────────────────────────────

test('matchEndpointRule routes credential issuance to its own tighter rule', () => {
  const issue = matchEndpointRule('POST', '/credentials');
  assert.equal(issue.name, 'credential_issuance');
  assert.equal(issue.limit, 10);
  assert.equal(issue.windowMs, 15 * 60 * 1000);

  assert.equal(matchEndpointRule('POST', '/credentials/issue').name, 'credential_issuance');
});

test('matchEndpointRule sends reads and other paths to the general rule', () => {
  // A GET on the same path is a read, not an issuance.
  assert.equal(matchEndpointRule('GET', '/credentials').name, 'general');
  assert.equal(matchEndpointRule('GET', '/webhooks').name, 'general');

  const general = matchEndpointRule('GET', '/anything');
  assert.equal(general.limit, 100);
  assert.equal(general.windowMs, 15 * 60 * 1000);
});

test('matchEndpointRule matches revocation without catching credential reads', () => {
  assert.equal(matchEndpointRule('POST', '/credentials/abc123/revoke').name, 'credential_revocation');
  assert.equal(matchEndpointRule('GET', '/credentials/abc123').name, 'general');
});

test('ENDPOINT_RULES orders specific rules before the catch-all', () => {
  assert.equal(ENDPOINT_RULES[ENDPOINT_RULES.length - 1].name, 'general');
});

// ─── Whitelist ─────────────────────────────────────────────────────────────

test('isWhitelisted matches exact addresses', () => {
  assert.equal(isWhitelisted('10.0.0.5', ['10.0.0.5']), true);
  assert.equal(isWhitelisted('10.0.0.6', ['10.0.0.5']), false);
  assert.equal(isWhitelisted('10.0.0.5', []), false);
});

test('isWhitelisted matches CIDR ranges', () => {
  assert.equal(isWhitelisted('10.0.0.7', ['10.0.0.0/24']), true);
  assert.equal(isWhitelisted('10.0.1.7', ['10.0.0.0/24']), false);
  assert.equal(isWhitelisted('192.168.5.5', ['192.168.0.0/16']), true);
  // /0 matches everything and must not be computed with an undefined shift.
  assert.equal(isWhitelisted('8.8.8.8', ['0.0.0.0/0']), true);
  assert.equal(isWhitelisted('10.0.0.5', ['10.0.0.5/32']), true);
});

test('isWhitelisted ignores malformed entries rather than throwing', () => {
  assert.equal(isWhitelisted('10.0.0.5', ['not-an-ip', '10.0.0.0/99', '10.0.0.0/abc']), false);
  assert.equal(isWhitelisted('10.0.0.5', ['garbage', '10.0.0.5']), true);
  assert.equal(isWhitelisted(null, ['10.0.0.5']), false);
});

// ─── Endpoint budgets ──────────────────────────────────────────────────────

test('credential issuance is capped at 10 per window', () => {
  const { limiter } = makeLimiter();
  const req = makeReq({ method: 'POST' });

  for (let i = 1; i <= 10; i += 1) {
    const result = limiter.consumeEndpoint(req, '/credentials');
    assert.equal(result.allowed, true, `request ${i} should be allowed`);
  }

  const denied = limiter.consumeEndpoint(req, '/credentials');
  assert.equal(denied.allowed, false);
  assert.equal(denied.rule, 'credential_issuance');
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfter > 0);
});

test('general endpoints are capped at 100 per window', () => {
  const { limiter } = makeLimiter();
  const req = makeReq();

  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.consumeEndpoint(req, '/webhooks').allowed, true);
  }
  assert.equal(limiter.consumeEndpoint(req, '/webhooks').allowed, false);
});

test('endpoint budgets are independent of each other', () => {
  const { limiter } = makeLimiter();
  const post = makeReq({ method: 'POST' });

  for (let i = 0; i < 11; i += 1) limiter.consumeEndpoint(post, '/credentials');
  assert.equal(limiter.consumeEndpoint(post, '/credentials').allowed, false);

  // The issuance budget being spent must not block an unrelated read.
  assert.equal(limiter.consumeEndpoint(makeReq(), '/webhooks').allowed, true);
});

test('endpoint budgets are per client', () => {
  const { limiter } = makeLimiter();
  const first = makeReq({ method: 'POST', socket: { remoteAddress: '1.1.1.1' } });
  const second = makeReq({ method: 'POST', socket: { remoteAddress: '2.2.2.2' } });

  for (let i = 0; i < 11; i += 1) limiter.consumeEndpoint(first, '/credentials');
  assert.equal(limiter.consumeEndpoint(first, '/credentials').allowed, false);
  assert.equal(limiter.consumeEndpoint(second, '/credentials').allowed, true);
});

test('an endpoint budget resets after its window', () => {
  const { limiter, advance } = makeLimiter();
  const req = makeReq({ method: 'POST' });

  for (let i = 0; i < 11; i += 1) limiter.consumeEndpoint(req, '/credentials');
  assert.equal(limiter.consumeEndpoint(req, '/credentials').allowed, false);

  advance(15 * 60 * 1000 + 1);
  assert.equal(limiter.consumeEndpoint(req, '/credentials').allowed, true);
});

// ─── Combined check ────────────────────────────────────────────────────────

test('check allows a request within both budgets and reports the tighter one', () => {
  const { limiter } = makeLimiter();
  const result = limiter.check(makeReq(), '/webhooks');

  assert.equal(result.allowed, true);
  assert.ok(result.binding);
  assert.ok(result.binding.remaining <= result.remaining);
});

test('check denies on the endpoint budget before the tier budget', () => {
  const { limiter } = makeLimiter();
  const req = makeReq({ method: 'POST' });

  let denial = null;
  for (let i = 0; i < 12; i += 1) {
    const result = limiter.check(req, '/credentials');
    if (!result.allowed) {
      denial = result;
      break;
    }
  }

  assert.ok(denial, 'expected a denial');
  assert.equal(denial.scope, 'endpoint');
  assert.equal(denial.rule, 'credential_issuance');
});

test('check exempts a whitelisted address entirely', () => {
  const { limiter } = makeLimiter({ whitelist: ['10.0.0.5'] });
  const req = makeReq({ method: 'POST' });

  for (let i = 0; i < 50; i += 1) {
    const result = limiter.check(req, '/credentials');
    assert.equal(result.allowed, true);
    assert.equal(result.whitelisted, true);
  }
  assert.equal(limiter.violations, 0);
});

test('check honours a CIDR whitelist entry', () => {
  const { limiter } = makeLimiter({ whitelist: ['10.0.0.0/24'] });
  assert.equal(limiter.check(makeReq(), '/credentials').whitelisted, true);
});

test('check ignores X-Forwarded-For for whitelisting unless the proxy is trusted', () => {
  const spoofed = makeReq({
    headers: { 'x-forwarded-for': '10.0.0.5' },
    socket: { remoteAddress: '203.0.113.9' },
  });

  const untrusted = makeLimiter({ whitelist: ['10.0.0.5'] }).limiter;
  // Otherwise any caller could whitelist themselves with a header.
  assert.notEqual(untrusted.check(spoofed, '/credentials').whitelisted, true);

  const trusted = makeLimiter({ whitelist: ['10.0.0.5'], trustProxy: true }).limiter;
  assert.equal(trusted.check(spoofed, '/credentials').whitelisted, true);
});

test('check counts violations for logging and metrics', () => {
  const { limiter } = makeLimiter();
  const req = makeReq({ method: 'POST' });

  for (let i = 0; i < 13; i += 1) limiter.check(req, '/credentials');

  assert.ok(limiter.violations >= 1);
  assert.equal(limiter.getStats().violations, limiter.violations);
});

// ─── Bucket lifecycle ──────────────────────────────────────────────────────

test('expired buckets are evicted rather than growing without bound', () => {
  const { limiter, advance } = makeLimiter();

  for (let i = 0; i < 25; i += 1) {
    limiter.check(makeReq({ socket: { remoteAddress: `10.0.1.${i}` } }), '/webhooks');
  }
  assert.ok(limiter.clients.size >= 25);

  advance(16 * 60 * 1000);
  const evicted = limiter.evictExpired();

  assert.ok(evicted > 0);
  assert.equal(limiter.clients.size, 0);
});

test('eviction leaves live buckets in place', () => {
  const { limiter, advance } = makeLimiter();

  limiter.check(makeReq({ socket: { remoteAddress: '10.0.2.1' } }), '/webhooks');
  advance(10 * 60 * 1000);
  limiter.check(makeReq({ socket: { remoteAddress: '10.0.2.2' } }), '/webhooks');

  advance(6 * 60 * 1000);
  limiter.evictExpired();

  // The first client's window has passed; the second's has not.
  const remaining = [...limiter.clients.keys()];
  assert.ok(remaining.every((key) => !key.includes('10.0.2.1')));
  assert.ok(remaining.some((key) => key.includes('10.0.2.2')));
});

test('getStats reports bucket, violation, and whitelist counts', () => {
  const { limiter } = makeLimiter({ whitelist: ['10.0.0.1', '10.0.0.2'] });
  limiter.check(makeReq({ socket: { remoteAddress: '9.9.9.9' } }), '/webhooks');

  const stats = limiter.getStats();
  assert.ok(stats.buckets > 0);
  assert.equal(stats.violations, 0);
  assert.equal(stats.whitelistEntries, 2);
});

test('reset clears buckets and the violation count', () => {
  const { limiter } = makeLimiter();
  const req = makeReq({ method: 'POST' });
  for (let i = 0; i < 12; i += 1) limiter.check(req, '/credentials');

  limiter.reset();

  assert.equal(limiter.clients.size, 0);
  assert.equal(limiter.violations, 0);
});
