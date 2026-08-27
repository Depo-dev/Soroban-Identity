import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { MetricsService } from '../src/metrics.js';
import { routeLabel } from '../src/route-label.js';

const ACCOUNT_A = `G${'A'.repeat(55)}`;
const ACCOUNT_B = `G${'B'.repeat(55)}`;

function newMetrics(options = {}) {
  return new MetricsService({ collectDefaultMetrics: false, ...options });
}

// ── Route labelling ────────────────────────────────────────────────

test('routeLabel collapses identifiers into a bounded pattern', () => {
  assert.equal(routeLabel('/credentials/abc123'), '/credentials/:id');
  assert.equal(routeLabel('/credentials/abc123/verify'), '/credentials/:id/verify');
  assert.equal(routeLabel('/credentials/abc123/revoke'), '/credentials/:id/revoke');
  assert.equal(routeLabel('/admin/api-keys/key_1/rotate'), '/admin/api-keys/:id/rotate');
});

test('routeLabel prefers a literal route over an id pattern', () => {
  assert.equal(routeLabel('/credentials/issue'), '/credentials/issue');
  assert.equal(routeLabel('/webhooks/logs'), '/webhooks/logs');
  assert.equal(routeLabel('/webhooks/test'), '/webhooks/test');
});

test('routeLabel maps unknown paths to a single unmatched label', () => {
  assert.equal(routeLabel('/nope'), 'unmatched');
  assert.equal(routeLabel('/a/b/c/d'), 'unmatched');
  assert.equal(routeLabel(''), 'unmatched');
  assert.equal(routeLabel(undefined), 'unmatched');
});

// ── Registry isolation and runtime metrics ─────────────────────────

test('each MetricsService owns a private registry', async () => {
  const a = newMetrics();
  const b = newMetrics();
  a.applyEvents([{ topic: ['DID', 'created'] }]);

  assert.match(await a.renderPrometheus(), /dids_created_total 1/);
  assert.match(await b.renderPrometheus(), /dids_created_total 0/);
});

test('Node.js runtime metrics are exported when enabled', async () => {
  const metrics = new MetricsService();
  const rendered = await metrics.renderPrometheus();
  assert.match(rendered, /process_cpu_user_seconds_total/);
  assert.match(rendered, /nodejs_heap_size_used_bytes/);
  assert.match(rendered, /nodejs_eventloop_lag_seconds/);
  metrics.registry.clear();
});

test('renderPrometheus advertises the Prometheus text content type', () => {
  const metrics = newMetrics();
  assert.match(metrics.contentType, /^text\/plain/);
  assert.match(metrics.contentType, /version=0\.0\.4/);
});

// ── counters proxy compatibility ───────────────────────────────────

test('the counters proxy reads through to the registry', async () => {
  const metrics = newMetrics();
  assert.equal(metrics.counters.rpc_cache_hits_total, 0);
  metrics.applyEvents([{ topic: ['CRED', 'issued credential'] }]);
  assert.equal(metrics.counters.credentials_issued_total, 1);
});

test('the counters proxy supports the increment-by-assignment style used by soroban.js', async () => {
  const metrics = newMetrics();
  metrics.counters.rpc_cache_hits_total = (metrics.counters.rpc_cache_hits_total || 0) + 1;
  metrics.counters.rpc_cache_hits_total = (metrics.counters.rpc_cache_hits_total || 0) + 1;
  assert.equal(metrics.counters.rpc_cache_hits_total, 2);
  assert.match(await metrics.renderPrometheus(), /rpc_cache_hits_total 2/);
});

test('the counters proxy ignores an attempt to move a counter backwards', () => {
  const metrics = newMetrics();
  metrics.counters.rpc_retries_total = 5;
  metrics.counters.rpc_retries_total = 2;
  assert.equal(metrics.counters.rpc_retries_total, 5);
});

// ── HTTP metrics ───────────────────────────────────────────────────

test('observeHttpRequest records count and duration with bounded labels', async () => {
  const metrics = newMetrics();
  metrics.observeHttpRequest({
    method: 'get',
    route: '/credentials/:id',
    statusCode: 200,
    durationSeconds: 0.02,
  });
  const rendered = await metrics.renderPrometheus();

  assert.match(rendered, /# TYPE http_requests_total counter/);
  assert.match(
    rendered,
    /http_requests_total\{method="GET",route="\/credentials\/:id",status_code="200"\} 1/,
  );
  assert.match(rendered, /# TYPE http_request_duration_seconds histogram/);
  assert.match(rendered, /http_request_duration_seconds_count\{[^}]*route="\/credentials\/:id"[^}]*\} 1/);
});

// ── Business metrics ───────────────────────────────────────────────

test('updateBusinessMetrics counts active DIDs and credential types', async () => {
  const metrics = newMetrics();
  const now = 1_000_000;
  metrics.updateBusinessMetrics(
    [
      { id: 'a', subject: ACCOUNT_A, type: 'Diploma', expiresAt: 0 },
      { id: 'b', subject: ACCOUNT_A, type: 'Licence', expiresAt: now + 100 },
      { id: 'c', subject: ACCOUNT_B, type: 'Diploma', expiresAt: 0 },
      { id: 'd', subject: ACCOUNT_B, type: 'Diploma', expiresAt: now - 100 }, // expired
      { id: 'e', subject: ACCOUNT_B, type: 'Diploma', revoked: true }, // revoked
    ],
    now,
  );
  const rendered = await metrics.renderPrometheus();

  assert.match(rendered, /^active_dids 2$/m);
  assert.match(rendered, /^credential_types 2$/m);
  assert.match(rendered, /active_credentials\{type="Diploma"\} 2/);
  assert.match(rendered, /active_credentials\{type="Licence"\} 1/);
});

test('updateBusinessMetrics drops a type back to zero when its last credential goes', async () => {
  const metrics = newMetrics();
  metrics.updateBusinessMetrics([{ id: 'a', subject: ACCOUNT_A, type: 'Diploma', expiresAt: 0 }], 100);
  assert.match(await metrics.renderPrometheus(), /active_credentials\{type="Diploma"\} 1/);

  metrics.updateBusinessMetrics([{ id: 'a', subject: ACCOUNT_A, type: 'Diploma', revoked: true }], 100);
  assert.match(await metrics.renderPrometheus(), /active_credentials\{type="Diploma"\} 0/);
});

test('updateBusinessMetrics labels a credential with no type as unspecified', async () => {
  const metrics = newMetrics();
  metrics.updateBusinessMetrics([{ id: 'a', subject: ACCOUNT_A, expiresAt: 0 }], 100);
  assert.match(await metrics.renderPrometheus(), /active_credentials\{type="unspecified"\} 1/);
});

test('observeCredentialVerification tracks each outcome separately', async () => {
  const metrics = newMetrics();
  metrics.observeCredentialVerification('verified');
  metrics.observeCredentialVerification('verified');
  metrics.observeCredentialVerification('revoked');
  const rendered = await metrics.renderPrometheus();

  assert.match(rendered, /credentials_verified_total\{result="verified"\} 2/);
  assert.match(rendered, /credentials_verified_total\{result="revoked"\} 1/);
});

// ── Integration: GET /metrics ──────────────────────────────────────

async function withServer(run, { credentials = [] } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prom-metrics-test-'));
  const credentialStorePath = path.join(dataDir, 'credentials.json');
  await fs.writeFile(credentialStorePath, JSON.stringify({ credentials }), 'utf8');

  const config = {
    adminApiKey: 'test-admin-key',
    adminActor: 'admin',
    corsAllowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    dataDir,
    credentialStorePath,
    auditLogPath: path.join(dataDir, 'audit'),
    apiKeyStorePath: path.join(dataDir, 'api-keys.json'),
    expiryWarningDays: 7,
  };

  const metrics = new MetricsService();
  const soroban = {
    pingAllContracts: async () => ({ identity: true, credential: true, reputation: true }),
    getIssuers: async () => [],
    circuitBreaker: { toHealthInfo: () => ({}) },
  };

  const app = createApp({
    config,
    soroban,
    metrics,
    metricsAggregator: null,
    webhookService: { trigger: async () => {}, deliverTest: async () => ({}) },
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
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw }));
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  try {
    await run({ request, metrics, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    metrics.registry.clear();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('GET /metrics returns the Prometheus exposition format', async () => {
  await withServer(async ({ request }) => {
    const res = await request('GET', '/metrics');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.match(res.body, /# HELP credentials_issued_total/);
    assert.match(res.body, /# TYPE credentials_issued_total counter/);
    assert.match(res.body, /nodejs_heap_size_used_bytes/);
  });
});

test('GET /metrics reports request count and duration for prior requests', async () => {
  await withServer(async ({ request }) => {
    await request('GET', '/health');
    await request('GET', '/health');
    const res = await request('GET', '/metrics');

    assert.match(
      res.body,
      /http_requests_total\{method="GET",route="\/health",status_code="200"\} 2/,
    );
    assert.match(res.body, /http_request_duration_seconds_bucket\{[^}]*route="\/health"/);
  });
});

test('GET /metrics reports business gauges computed from the credential store', async () => {
  await withServer(
    async ({ request }) => {
      const res = await request('GET', '/metrics');
      assert.match(res.body, /^active_dids 2$/m);
      assert.match(res.body, /^credential_types 2$/m);
      assert.match(res.body, /active_credentials\{type="Diploma"\} 2/);
    },
    {
      credentials: [
        { id: 'a', subject: ACCOUNT_A, type: 'Diploma', expiresAt: 0 },
        { id: 'b', subject: ACCOUNT_B, type: 'Diploma', expiresAt: 0 },
        { id: 'c', subject: ACCOUNT_B, type: 'Licence', expiresAt: 0 },
      ],
    },
  );
});

test('credential verification outcomes are counted through the HTTP endpoint', async () => {
  await withServer(
    async ({ request }) => {
      await request('POST', '/credentials/cred-live/verify', {
        headers: { 'x-api-key': 'test-admin-key' },
      });
      await request('POST', '/credentials/cred-revoked/verify', {
        headers: { 'x-api-key': 'test-admin-key' },
      });
      const res = await request('GET', '/metrics');

      assert.match(res.body, /credentials_verified_total\{result="verified"\} 1/);
      assert.match(res.body, /credentials_verified_total\{result="revoked"\} 1/);
    },
    {
      credentials: [
        { id: 'cred-live', subject: ACCOUNT_A, type: 'Diploma', expiresAt: 0 },
        { id: 'cred-revoked', subject: ACCOUNT_A, type: 'Diploma', expiresAt: 0, revoked: true },
      ],
    },
  );
});

test('an unmatched path does not create a new route label series', async () => {
  await withServer(async ({ request }) => {
    await request('GET', '/definitely-not-a-route-1');
    await request('GET', '/definitely-not-a-route-2');
    const res = await request('GET', '/metrics');

    assert.match(res.body, /http_requests_total\{method="GET",route="unmatched",status_code="404"\} 2/);
    assert.doesNotMatch(res.body, /definitely-not-a-route/);
  });
});
