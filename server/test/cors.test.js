import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getAllowedOrigin, setCorsHeaders } from '../src/http-utils.js';
import {
  loadConfig,
  validateConfig,
  DEFAULT_CORS_METHODS,
  DEFAULT_CORS_ALLOWED_HEADERS,
  DEFAULT_CORS_EXPOSED_HEADERS,
  DEFAULT_CORS_MAX_AGE,
} from '../src/config.js';

// ── Config parsing ─────────────────────────────────────────────────

test('CORS_ORIGIN accepts a single origin', () => {
  const config = loadConfig({ CORS_ORIGIN: 'https://app.example.com' });
  assert.deepEqual(config.corsAllowedOrigins, ['https://app.example.com']);
});

test('CORS_ORIGIN accepts a comma-separated list and trims each entry', () => {
  const config = loadConfig({
    CORS_ORIGIN: 'https://a.example.com, https://b.example.com ,https://c.example.com',
  });
  assert.deepEqual(config.corsAllowedOrigins, [
    'https://a.example.com',
    'https://b.example.com',
    'https://c.example.com',
  ]);
});

test('CORS_ALLOWED_ORIGINS remains supported as an alias', () => {
  const config = loadConfig({ CORS_ALLOWED_ORIGINS: 'https://legacy.example.com' });
  assert.deepEqual(config.corsAllowedOrigins, ['https://legacy.example.com']);
});

test('CORS_ORIGIN takes precedence over the legacy alias', () => {
  const config = loadConfig({
    CORS_ORIGIN: 'https://new.example.com',
    CORS_ALLOWED_ORIGINS: 'https://legacy.example.com',
  });
  assert.deepEqual(config.corsAllowedOrigins, ['https://new.example.com']);
});

test('origins default to wildcard in development and to none in production', () => {
  assert.deepEqual(loadConfig({ NODE_ENV: 'development' }).corsAllowedOrigins, ['*']);
  assert.deepEqual(loadConfig({ NODE_ENV: 'production' }).corsAllowedOrigins, []);
});

test('CORS_CREDENTIALS parses the usual truthy and falsy spellings', () => {
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(loadConfig({ CORS_CREDENTIALS: value }).corsCredentials, true, value);
  }
  for (const value of ['false', '0', 'no', 'off']) {
    assert.equal(loadConfig({ CORS_CREDENTIALS: value }).corsCredentials, false, value);
  }
});

test('CORS_CREDENTIALS defaults to false and ignores an unparseable value', () => {
  assert.equal(loadConfig({}).corsCredentials, false);
  assert.equal(loadConfig({ CORS_CREDENTIALS: 'maybe' }).corsCredentials, false);
});

test('methods, allowed headers and exposed headers fall back to their defaults', () => {
  const config = loadConfig({});
  assert.deepEqual(config.corsMethods, DEFAULT_CORS_METHODS);
  assert.deepEqual(config.corsAllowedHeaders, DEFAULT_CORS_ALLOWED_HEADERS);
  assert.deepEqual(config.corsExposedHeaders, DEFAULT_CORS_EXPOSED_HEADERS);
  assert.equal(config.corsMaxAge, DEFAULT_CORS_MAX_AGE);
});

test('methods and headers are configurable through the environment', () => {
  const config = loadConfig({
    CORS_METHODS: 'GET, POST',
    CORS_ALLOWED_HEADERS: 'Content-Type,X-API-Key',
    CORS_EXPOSED_HEADERS: 'X-Request-ID',
    CORS_MAX_AGE: '600',
  });
  assert.deepEqual(config.corsMethods, ['GET', 'POST']);
  assert.deepEqual(config.corsAllowedHeaders, ['Content-Type', 'X-API-Key']);
  assert.deepEqual(config.corsExposedHeaders, ['X-Request-ID']);
  assert.equal(config.corsMaxAge, 600);
});

test('CORS_MAX_AGE of 0 disables preflight caching rather than falling back', () => {
  assert.equal(loadConfig({ CORS_MAX_AGE: '0' }).corsMaxAge, 0);
});

// ── Config validation ──────────────────────────────────────────────

const REQUIRED = {
  STELLAR_SECRET_KEY: `S${'A'.repeat(55)}`,
  CREDENTIAL_CONTRACT_ID: `C${'A'.repeat(55)}`,
};

test('validateConfig accepts a wildcard and a list of absolute origins', () => {
  assert.equal(validateConfig({ ...REQUIRED, CORS_ORIGIN: '*' }).isValid, true);
  assert.equal(
    validateConfig({
      ...REQUIRED,
      CORS_ORIGIN: 'https://a.example.com,http://localhost:5173',
    }).isValid,
    true,
  );
});

test('validateConfig rejects an origin that is not an absolute URL', () => {
  const result = validateConfig({ ...REQUIRED, CORS_ORIGIN: 'app.example.com' });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('CORS_ORIGIN')));
});

test('validateConfig rejects an origin carrying a path', () => {
  const result = validateConfig({
    ...REQUIRED,
    CORS_ORIGIN: 'https://app.example.com/api',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('path, query or fragment')));
});

test('validateConfig rejects credentials combined with a wildcard origin', () => {
  const result = validateConfig({
    ...REQUIRED,
    CORS_ORIGIN: '*',
    CORS_CREDENTIALS: 'true',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('CORS_CREDENTIALS')));
});

test('validateConfig rejects credentials that rely on the development wildcard default', () => {
  const result = validateConfig({
    ...REQUIRED,
    NODE_ENV: 'development',
    CORS_CREDENTIALS: 'true',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('CORS_CREDENTIALS')));
});

test('validateConfig accepts credentials with explicit origins', () => {
  const result = validateConfig({
    ...REQUIRED,
    CORS_ORIGIN: 'https://app.example.com',
    CORS_CREDENTIALS: 'true',
  });
  assert.equal(result.isValid, true);
});

test('validateConfig rejects an unparseable CORS_CREDENTIALS value', () => {
  const result = validateConfig({ ...REQUIRED, CORS_CREDENTIALS: 'sometimes' });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('CORS_CREDENTIALS')));
});

test('validateConfig rejects a non-numeric CORS_MAX_AGE', () => {
  const result = validateConfig({ ...REQUIRED, CORS_MAX_AGE: 'forever' });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some((e) => e.includes('CORS_MAX_AGE')));
});

// ── getAllowedOrigin ───────────────────────────────────────────────

test('getAllowedOrigin returns null when no origins are configured', () => {
  assert.equal(getAllowedOrigin('https://app.example.com', []), null);
  assert.equal(getAllowedOrigin('https://app.example.com', undefined), null);
});

test('getAllowedOrigin returns the wildcard when credentials are off', () => {
  assert.equal(getAllowedOrigin('https://any.example.com', ['*'], false), '*');
});

test('getAllowedOrigin reflects the request origin when credentials are on', () => {
  assert.equal(
    getAllowedOrigin('https://any.example.com', ['*'], true),
    'https://any.example.com',
  );
  assert.equal(getAllowedOrigin(undefined, ['*'], true), null);
});

test('getAllowedOrigin matches an exact configured origin only', () => {
  const allowed = ['https://app.example.com'];
  assert.equal(getAllowedOrigin('https://app.example.com', allowed), 'https://app.example.com');
  assert.equal(getAllowedOrigin('https://evil.example.com', allowed), null);
  assert.equal(getAllowedOrigin('https://app.example.com.evil.com', allowed), null);
});

// ── setCorsHeaders unit behaviour ──────────────────────────────────

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
  };
}

test('setCorsHeaders returns true for a preflight and false otherwise', () => {
  const config = { corsAllowedOrigins: ['*'] };
  assert.equal(
    setCorsHeaders({ method: 'OPTIONS', headers: {} }, fakeRes(), config),
    true,
  );
  assert.equal(
    setCorsHeaders({ method: 'GET', headers: {} }, fakeRes(), config),
    false,
  );
});

test('a preflight advertises the configured methods, headers and cache lifetime', () => {
  const res = fakeRes();
  setCorsHeaders(
    { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } },
    res,
    {
      corsAllowedOrigins: ['https://app.example.com'],
      corsMethods: ['GET', 'POST'],
      corsAllowedHeaders: ['Content-Type', 'X-API-Key'],
      corsExposedHeaders: ['X-Request-ID'],
      corsMaxAge: 600,
    },
  );

  assert.equal(res.getHeader('access-control-allow-methods'), 'GET, POST');
  assert.equal(res.getHeader('access-control-allow-headers'), 'Content-Type, X-API-Key');
  assert.equal(res.getHeader('access-control-max-age'), '600');
  assert.equal(res.getHeader('access-control-expose-headers'), 'X-Request-ID');
});

test('Vary: Origin is set whenever the allowed origin depends on the request', () => {
  const specific = fakeRes();
  setCorsHeaders({ method: 'GET', headers: { origin: 'https://app.example.com' } }, specific, {
    corsAllowedOrigins: ['https://app.example.com'],
  });
  assert.equal(specific.getHeader('vary'), 'Origin');

  const wildcard = fakeRes();
  setCorsHeaders({ method: 'GET', headers: { origin: 'https://any.example.com' } }, wildcard, {
    corsAllowedOrigins: ['*'],
  });
  assert.equal(wildcard.getHeader('vary'), undefined);
});

// ── Integration ────────────────────────────────────────────────────

const BASE_CONFIG = {
  adminApiKey: 'test-key',
  adminActor: 'admin',
  maxBodyBytes: 64 * 1024,
  expiryWarningDays: 7,
  corsMethods: DEFAULT_CORS_METHODS,
  corsAllowedHeaders: DEFAULT_CORS_ALLOWED_HEADERS,
  corsExposedHeaders: DEFAULT_CORS_EXPOSED_HEADERS,
  corsMaxAge: DEFAULT_CORS_MAX_AGE,
};

const soroban = {
  pingAllContracts: async () => ({ credential: true, identity: true, reputation: true }),
  getIssuers: async () => [],
  circuitBreaker: { toHealthInfo: () => ({}) },
};

async function withServer(configOverrides, run) {
  const config = { ...BASE_CONFIG, ...configOverrides };
  const app = createApp({
    config,
    soroban,
    metrics: { renderPrometheus: () => '# HELP test\ntest_metric 1\n' },
    metricsAggregator: null,
    webhookService: { trigger: async () => {} },
  });

  const server = http.createServer(app);
  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  const request = (method, pathname, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ port, method, path: pathname, headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw }));
      });
      req.on('error', reject);
      req.end();
    });

  try {
    await run(request);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ALLOWED = ['https://app.example.com', 'http://localhost:5173'];

test('a preflight returns 204 with the configured CORS headers', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED }, async (request) => {
    const res = await request('OPTIONS', '/health', { origin: 'https://app.example.com' });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.example.com');
    assert.match(res.headers['access-control-allow-methods'], /GET/);
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
    assert.match(res.headers['access-control-allow-headers'], /Authorization/);
    assert.equal(res.headers['access-control-max-age'], '86400');
  });
});

test('the preflight cache lifetime follows CORS_MAX_AGE', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED, corsMaxAge: 120 }, async (request) => {
    const res = await request('OPTIONS', '/health', { origin: 'https://app.example.com' });
    assert.equal(res.headers['access-control-max-age'], '120');
  });
});

test('each configured origin is allowed and an unlisted origin is not', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED }, async (request) => {
    for (const origin of ALLOWED) {
      const res = await request('GET', '/health', { origin });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['access-control-allow-origin'], origin);
    }

    const blocked = await request('GET', '/health', { origin: 'https://evil.example.com' });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.headers['access-control-allow-origin'], undefined);
  });
});

test('X-Request-ID is exposed to the browser', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://app.example.com' });
    assert.match(res.headers['access-control-expose-headers'], /X-Request-ID/);
    assert.ok(res.headers['x-request-id']);
  });
});

test('a wildcard origin is returned as-is and carries no credentials header', async () => {
  await withServer({ corsAllowedOrigins: ['*'] }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://any-origin.com' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});

test('credentials are advertised only when CORS_CREDENTIALS is enabled', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED, corsCredentials: true }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://app.example.com' });
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.example.com');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  await withServer({ corsAllowedOrigins: ALLOWED, corsCredentials: false }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://app.example.com' });
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});

test('with credentials enabled a wildcard reflects the request origin', async () => {
  await withServer({ corsAllowedOrigins: ['*'], corsCredentials: true }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://any-origin.com' });
    assert.equal(res.headers['access-control-allow-origin'], 'https://any-origin.com');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.equal(res.headers.vary, 'Origin');
  });
});

test('CORS headers are set on every route type', async () => {
  await withServer({ corsAllowedOrigins: ALLOWED }, async (request) => {
    for (const pathname of ['/health', '/info', '/metrics']) {
      const res = await request('GET', pathname, { origin: 'https://app.example.com' });
      assert.equal(
        res.headers['access-control-allow-origin'],
        'https://app.example.com',
        pathname,
      );
    }
  });
});

test('no CORS headers are sent when the allowed origin list is empty', async () => {
  await withServer({ corsAllowedOrigins: [] }, async (request) => {
    const res = await request('GET', '/health', { origin: 'https://app.example.com' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});
