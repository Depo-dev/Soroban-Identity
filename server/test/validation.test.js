import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createApp } from '../src/app.js';
import {
  sanitizeString,
  sanitizeDeep,
  validate,
  schemas,
  did,
  credentialId,
  stellarAccount,
  stellarContract,
  searchParamsToObject,
} from '../src/validation.js';

const ACCOUNT = `G${'A'.repeat(55)}`;
const CONTRACT = `C${'A'.repeat(55)}`;

// ── Unit: sanitization ─────────────────────────────────────────────

test('sanitizeString trims surrounding whitespace', () => {
  assert.equal(sanitizeString('  hello  '), 'hello');
});

test('sanitizeString strips ASCII control characters', () => {
  const raw = `a${String.fromCharCode(0)}b${String.fromCharCode(27)}c${String.fromCharCode(127)}`;
  assert.equal(sanitizeString(raw), 'abc');
});

test('sanitizeString leaves non-strings untouched', () => {
  assert.equal(sanitizeString(42), 42);
  assert.equal(sanitizeString(null), null);
});

test('sanitizeDeep sanitizes nested values and object keys', () => {
  const input = {
    [` key${String.fromCharCode(0)} `]: '  value  ',
    nested: { list: ['  a  ', `b${String.fromCharCode(7)}`] },
  };
  assert.deepEqual(sanitizeDeep(input), {
    key: 'value',
    nested: { list: ['a', 'b'] },
  });
});

test('sanitizeDeep stops recursing past the depth cap', () => {
  let deep = '  leaf  ';
  for (let i = 0; i < 25; i += 1) deep = { next: deep };
  // Must not throw on deeply nested input.
  assert.ok(sanitizeDeep(deep));
});

// ── Unit: custom validators ────────────────────────────────────────

test('stellarAccount accepts a valid G address and rejects others', () => {
  assert.equal(stellarAccount.safeParse(ACCOUNT).success, true);
  assert.equal(stellarAccount.safeParse(CONTRACT).success, false);
  assert.equal(stellarAccount.safeParse('GABC').success, false);
  assert.equal(stellarAccount.safeParse(`G${'a'.repeat(55)}`).success, false);
});

test('stellarContract accepts a valid C address only', () => {
  assert.equal(stellarContract.safeParse(CONTRACT).success, true);
  assert.equal(stellarContract.safeParse(ACCOUNT).success, false);
});

test('did accepts did:stellar with a valid account identifier', () => {
  assert.equal(did.safeParse(`did:stellar:${ACCOUNT}`).success, true);
  assert.equal(did.safeParse(`did:stellar:${CONTRACT}`).success, false);
  assert.equal(did.safeParse('did:example:123').success, false);
  assert.equal(did.safeParse(ACCOUNT).success, false);
});

test('credentialId rejects path separators and short values', () => {
  assert.equal(credentialId.safeParse('cred-123').success, true);
  assert.equal(credentialId.safeParse('urn:cred:1').success, true);
  assert.equal(credentialId.safeParse('a/b').success, false);
  assert.equal(credentialId.safeParse('ab').success, false);
  assert.equal(credentialId.safeParse('x'.repeat(129)).success, false);
});

test('credentialId is sanitized before the pattern check', () => {
  const parsed = credentialId.safeParse('  cred-123  ');
  assert.equal(parsed.success, true);
  assert.equal(parsed.data, 'cred-123');
});

// ── Unit: validate() ───────────────────────────────────────────────

test('validate returns field-level errors for every offending field', () => {
  const result = validate(schemas.issueCredential, {
    body: { id: 'x', subject: 'not-an-address' },
  });
  assert.equal(result.success, false);
  const fields = result.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['id', 'subject']);
  for (const error of result.errors) {
    assert.equal(error.source, 'body');
    assert.ok(error.message.length > 0);
    assert.ok(error.code);
  }
});

test('validate rejects unknown body keys on strict schemas', () => {
  const result = validate(schemas.issueCredential, {
    body: { id: 'cred-1', unexpected: true },
  });
  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.code === 'unrecognized_keys'));
});

test('validate coerces and range-checks query parameters', () => {
  const ok = validate(schemas.listCredentials, {
    query: new URLSearchParams('limit=25'),
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data.query.limit, 25);

  const tooBig = validate(schemas.listCredentials, {
    query: new URLSearchParams('limit=500'),
  });
  assert.equal(tooBig.success, false);
  assert.equal(tooBig.errors[0].field, 'limit');
  assert.equal(tooBig.errors[0].source, 'query');
});

test('validate reports header errors with source "headers"', () => {
  const result = validate(schemas.commonHeaders, {
    headers: { 'X-User-Tier': 'platinum' },
  });
  assert.equal(result.success, false);
  assert.equal(result.errors[0].source, 'headers');
  assert.equal(result.errors[0].field, 'x-user-tier');
});

test('validate accumulates errors across body and query in one pass', () => {
  const result = validate(schemas.removeIssuer, {
    body: { issuer: 'bad' },
    query: new URLSearchParams('issuer=alsobad'),
  });
  assert.equal(result.success, false);
  const sources = [...new Set(result.errors.map((e) => e.source))].sort();
  assert.deepEqual(sources, ['body', 'query']);
});

test('searchParamsToObject keeps the last value for repeated keys', () => {
  const obj = searchParamsToObject(new URLSearchParams('a=1&a=2&b=3'));
  assert.deepEqual(obj, { a: '2', b: '3' });
});

// ── Integration: 400 responses from the HTTP layer ─────────────────

async function withServer(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-test-'));
  const config = {
    adminApiKey: 'test-admin-key',
    adminActor: 'admin',
    corsAllowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    dataDir,
    credentialStorePath: path.join(dataDir, 'credentials.json'),
    auditLogPath: path.join(dataDir, 'audit'),
    apiKeyStorePath: path.join(dataDir, 'api-keys.json'),
    expiryWarningDays: 7,
    expiryReminderThresholds: [30, 7, 1],
  };

  const soroban = {
    pingAllContracts: async () => ({ identity: true, credential: true, reputation: true }),
    getIssuers: async () => [],
    addIssuer: async () => {},
    removeIssuer: async () => {},
    circuitBreaker: { toHealthInfo: () => ({}) },
  };

  const app = createApp({
    config,
    soroban,
    metrics: { renderPrometheus: () => '' },
    metricsAggregator: null,
    webhookService: { trigger: async () => {}, deliverTest: async () => ({ ok: true }) },
  });

  const server = http.createServer(app);
  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  const request = (method, pathname, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          port,
          method,
          path: pathname,
          headers: {
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
            resolve({ statusCode: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  try {
    await run({ request, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('POST /credentials rejects a malformed body with field-level errors', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/credentials', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { id: 'x', subject: 'nope' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(res.body.errors));
    const fields = res.body.errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ['id', 'subject']);
  });
});

test('POST /credentials accepts a valid body', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/credentials', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { id: 'cred-valid-1', subject: ACCOUNT, expiresAt: 0 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 'cred-valid-1');
  });
});

test('GET /credentials rejects an out-of-range limit', async () => {
  await withServer(async ({ request }) => {
    const res = await request('GET', '/credentials?limit=9999');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors[0].source, 'query');
    assert.equal(res.body.errors[0].field, 'limit');
  });
});

test('GET /credentials/:id rejects an invalid credential id', async () => {
  await withServer(async ({ request }) => {
    const res = await request('GET', '/credentials/ab');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors[0].field, 'credentialId');
    assert.equal(res.body.errors[0].source, 'params');
  });
});

test('an unsupported x-user-tier header is rejected before routing', async () => {
  await withServer(async ({ request }) => {
    const res = await request('GET', '/health', { headers: { 'x-user-tier': 'platinum' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors[0].source, 'headers');
  });
});

test('POST /admin/issuers rejects a non-Stellar issuer address', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/admin/issuers', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { issuer: 'not-an-address' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors[0].field, 'issuer');
  });
});

test('POST /admin/issuers accepts a valid Stellar issuer address', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/admin/issuers', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { issuer: ACCOUNT },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.issuer, ACCOUNT);
  });
});

test('POST /webhooks rejects a non-http url', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/webhooks', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { url: 'javascript:alert(1)' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors[0].field, 'url');
  });
});

test('string inputs are sanitized before reaching storage', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/credentials', {
      headers: { 'x-api-key': 'test-admin-key' },
      body: { id: '  cred-sanitized  ', type: '  Diploma  ' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 'cred-sanitized');
    assert.equal(res.body.type, 'Diploma');
  });
});
