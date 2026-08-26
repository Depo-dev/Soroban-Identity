import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  REDACTED,
  RotatingFileSink,
  buildAccessRecord,
  levelForStatus,
  preparePayload,
  redact,
  redactHeaders,
  resolveClientIp,
  startAccessLog,
} from '../src/access-log.js';

function makeConfig(overrides = {}) {
  return {
    accessLogEnabled: true,
    logPayloads: false,
    logHeaders: false,
    logPayloadMaxBytes: 2048,
    trustProxy: false,
    ...overrides,
  };
}

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    url: '/credentials',
    headers: { 'user-agent': 'test-agent/1.0', ...(overrides.headers ?? {}) },
    socket: { remoteAddress: '10.0.0.5' },
    ...overrides,
  };
}

function makeRes(statusCode = 200, headers = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.getHeader = (name) => headers[name.toLowerCase()];
  return res;
}

// ─── Redaction ─────────────────────────────────────────────────────────────

test('redact removes sensitive fields at any depth', () => {
  const input = {
    subject: 'GABC',
    password: 'hunter2',
    nested: { apiKey: 'k-123', api_key: 'k-456', safe: 'kept' },
    list: [{ secret: 's' }, { ok: 'yes' }],
  };

  const output = redact(input);

  assert.equal(output.subject, 'GABC');
  assert.equal(output.password, REDACTED);
  assert.equal(output.nested.apiKey, REDACTED);
  assert.equal(output.nested.api_key, REDACTED);
  assert.equal(output.nested.safe, 'kept');
  assert.equal(output.list[0].secret, REDACTED);
  assert.equal(output.list[1].ok, 'yes');
});

test('redact matches sensitive names regardless of case and separators', () => {
  const output = redact({ PRIVATE_KEY: 'x', 'private-key': 'y', SecretKey: 'z' });
  assert.equal(output.PRIVATE_KEY, REDACTED);
  assert.equal(output['private-key'], REDACTED);
  assert.equal(output.SecretKey, REDACTED);
});

test('redact bounds recursion depth instead of blowing the stack', () => {
  let deep = { value: 'bottom' };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };

  const output = redact(deep);
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('redact leaves primitives and null untouched', () => {
  assert.equal(redact('plain'), 'plain');
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test('redactHeaders hides credentials but keeps the rest', () => {
  const output = redactHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'k-123',
    cookie: 'session=abc',
    'user-agent': 'curl/8',
    'content-type': 'application/json',
  });

  assert.equal(output.authorization, REDACTED);
  assert.equal(output['x-api-key'], REDACTED);
  assert.equal(output.cookie, REDACTED);
  assert.equal(output['user-agent'], 'curl/8');
  assert.equal(output['content-type'], 'application/json');
});

// ─── Client IP ─────────────────────────────────────────────────────────────

test('resolveClientIp ignores X-Forwarded-For unless the proxy is trusted', () => {
  const req = makeReq({ headers: { 'x-forwarded-for': '1.2.3.4' } });

  // Untrusted: a client could otherwise spoof its own address.
  assert.equal(resolveClientIp(req), '10.0.0.5');
  assert.equal(resolveClientIp(req, { trustProxy: true }), '1.2.3.4');
});

test('resolveClientIp takes the first hop from a forwarded chain', () => {
  const req = makeReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9' } });
  assert.equal(resolveClientIp(req, { trustProxy: true }), '1.2.3.4');
});

test('resolveClientIp falls back to X-Real-IP and then to unknown', () => {
  const realIp = makeReq({ headers: { 'x-real-ip': '2.2.2.2' } });
  assert.equal(resolveClientIp(realIp, { trustProxy: true }), '2.2.2.2');

  const bare = { headers: {}, socket: {} };
  assert.equal(resolveClientIp(bare), 'unknown');
});

// ─── Payload preparation ───────────────────────────────────────────────────

test('preparePayload redacts and passes through a small body', () => {
  const output = preparePayload({ id: 'c1', secret: 's' });
  assert.deepEqual(output, { id: 'c1', secret: REDACTED });
});

test('preparePayload truncates a large body and reports its real size', () => {
  const output = preparePayload({ blob: 'x'.repeat(5000) }, 100);

  assert.equal(output.truncated, true);
  assert.ok(output.bytes > 100);
  assert.equal(output.preview.length, 100);
});

test('preparePayload returns undefined for an absent body', () => {
  assert.equal(preparePayload(null), undefined);
  assert.equal(preparePayload(undefined), undefined);
});

// ─── Level mapping ─────────────────────────────────────────────────────────

test('levelForStatus escalates on client and server errors', () => {
  assert.equal(levelForStatus(200), 'info');
  assert.equal(levelForStatus(301), 'info');
  assert.equal(levelForStatus(404), 'warn');
  assert.equal(levelForStatus(429), 'warn');
  assert.equal(levelForStatus(500), 'error');
  assert.equal(levelForStatus(503), 'error');
});

// ─── Access record ─────────────────────────────────────────────────────────

test('buildAccessRecord captures method, path, status, duration, IP, and agent', () => {
  const req = makeReq();
  const res = makeRes(201, { 'content-length': '42' });

  const record = buildAccessRecord(req, res, {
    requestId: 'req-1',
    startedAt: Date.now() - 25,
    config: makeConfig(),
  });

  assert.equal(record.type, 'http_access');
  assert.equal(record.requestId, 'req-1');
  assert.equal(record.method, 'POST');
  assert.equal(record.path, '/credentials');
  assert.equal(record.status, 201);
  assert.ok(record.durationMs >= 20);
  assert.equal(record.ip, '10.0.0.5');
  assert.equal(record.userAgent, 'test-agent/1.0');
  assert.equal(record.contentLength, '42');
});

test('buildAccessRecord omits headers and payloads unless they are enabled', () => {
  const record = buildAccessRecord(makeReq(), makeRes(200), {
    requestId: 'req-2',
    startedAt: Date.now(),
    config: makeConfig(),
    requestBody: { password: 'hunter2' },
  });

  assert.equal(record.headers, undefined);
  assert.equal(record.requestBody, undefined);
});

test('buildAccessRecord includes redacted headers and payloads when enabled', () => {
  const req = makeReq({ headers: { authorization: 'Bearer x', 'user-agent': 'ua' } });

  const record = buildAccessRecord(req, makeRes(200), {
    requestId: 'req-3',
    startedAt: Date.now(),
    config: makeConfig({ logHeaders: true, logPayloads: true }),
    requestBody: { subject: 'GABC', password: 'hunter2' },
    responseBody: { id: 'c1', token: 'secret' },
  });

  assert.equal(record.headers.authorization, REDACTED);
  assert.equal(record.requestBody.subject, 'GABC');
  assert.equal(record.requestBody.password, REDACTED);
  assert.equal(record.responseBody.token, REDACTED);
});

test('buildAccessRecord carries the API key id and tier when present', () => {
  const req = makeReq({ apiKeyId: 'key-1', userTier: 'pro' });
  const record = buildAccessRecord(req, makeRes(200), {
    requestId: 'req-4',
    startedAt: Date.now(),
    config: makeConfig(),
  });

  assert.equal(record.apiKeyId, 'key-1');
  assert.equal(record.userTier, 'pro');
});

test('startAccessLog emits a record and writes it to the sink', async () => {
  const written = [];
  const sink = { write: async (line) => written.push(line) };

  const finish = startAccessLog(makeReq(), makeRes(200), {
    requestId: 'req-5',
    config: makeConfig(),
    sink,
  });

  const record = finish({ requestBody: { id: 'c1' } });
  assert.equal(record.requestId, 'req-5');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 1);

  const parsed = JSON.parse(written[0]);
  assert.equal(parsed.requestId, 'req-5');
  assert.ok(parsed.time);
});

test('a sink failure never breaks the request', async () => {
  const sink = {
    write: async () => {
      throw new Error('disk full');
    },
  };

  const finish = startAccessLog(makeReq(), makeRes(200), {
    requestId: 'req-6',
    config: makeConfig(),
    sink,
  });

  assert.doesNotThrow(() => finish());
  await new Promise((resolve) => setImmediate(resolve));
});

// ─── Rotation ──────────────────────────────────────────────────────────────

test('RotatingFileSink appends lines to its file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accesslog-'));
  const filePath = path.join(dir, 'access.log');
  const sink = new RotatingFileSink({ filePath, maxBytes: 1024 });

  await sink.write('{"a":1}');
  await sink.write('{"a":2}');
  await sink.close();

  const content = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(content.trim().split('\n'), ['{"a":1}', '{"a":2}']);
});

test('RotatingFileSink rotates past the size limit and keeps history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accesslog-'));
  const filePath = path.join(dir, 'access.log');
  const sink = new RotatingFileSink({ filePath, maxBytes: 40, maxFiles: 3 });

  for (let i = 0; i < 6; i += 1) {
    await sink.write(JSON.stringify({ index: i, pad: 'xxxxxxxxxxxxxxxxxxxx' }));
  }
  await sink.close();

  const entries = await fs.readdir(dir);
  assert.ok(entries.includes('access.log'));
  assert.ok(entries.includes('access.log.1'), 'expected a rotated file');
});

test('RotatingFileSink drops history beyond maxFiles', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accesslog-'));
  const filePath = path.join(dir, 'access.log');
  const sink = new RotatingFileSink({ filePath, maxBytes: 30, maxFiles: 2 });

  for (let i = 0; i < 10; i += 1) {
    await sink.write(JSON.stringify({ index: i, pad: 'yyyyyyyyyyyyyyyyyyyy' }));
  }
  await sink.close();

  const entries = (await fs.readdir(dir)).filter((name) => name.startsWith('access.log'));
  // The live file plus at most maxFiles rotations.
  assert.ok(entries.length <= 3, `expected at most 3 files, got ${entries.join(', ')}`);
  assert.equal(entries.includes('access.log.4'), false);
});

test('RotatingFileSink resumes an existing file without rotating immediately', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accesslog-'));
  const filePath = path.join(dir, 'access.log');
  await fs.writeFile(filePath, 'existing\n', 'utf8');

  const sink = new RotatingFileSink({ filePath, maxBytes: 10 * 1024 });
  await sink.write('{"a":1}');
  await sink.close();

  const content = await fs.readFile(filePath, 'utf8');
  assert.match(content, /^existing\n/);
  assert.match(content, /\{"a":1\}/);
});
