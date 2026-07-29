import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { validateContentType, readJson, requireAuth } from '../src/http-utils.js';

function makeReq(method, contentType) {
  return { method, headers: contentType !== undefined ? { 'content-type': contentType } : {} };
}

function makeRes() {
  const res = { _status: null, _body: null };
  res.writeHead = (status) => { res._status = status; return res; };
  res.end = (body) => { res._body = body; };
  return res;
}

// Non-JSON Content-Type on POST returns 415 UNSUPPORTED_MEDIA_TYPE
test('POST with form content-type returns 415', () => {
  const req = makeReq('POST', 'application/x-www-form-urlencoded');
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, true);
  assert.equal(res._status, 415);
  assert.match(res._body, /UNSUPPORTED_MEDIA_TYPE/);
});

// Missing Content-Type on POST returns 415
test('POST with missing content-type returns 415', () => {
  const req = makeReq('POST', undefined);
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, true);
  assert.equal(res._status, 415);
});

// Correct Content-Type on POST passes through
test('POST with application/json passes', () => {
  const req = makeReq('POST', 'application/json; charset=utf-8');
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, false);
  assert.equal(res._status, null);
});

// GET is unaffected regardless of Content-Type
test('GET is unaffected', () => {
  const req = makeReq('GET', 'text/plain');
  const res = makeRes();
  assert.equal(validateContentType(req, res), false);
});

// DELETE is unaffected
test('DELETE is unaffected', () => {
  const req = makeReq('DELETE', undefined);
  const res = makeRes();
  assert.equal(validateContentType(req, res), false);
});

// PATCH with wrong content-type returns 415
test('PATCH with wrong content-type returns 415', () => {
  const req = makeReq('PATCH', 'multipart/form-data');
  const res = makeRes();
  assert.equal(validateContentType(req, res), true);
  assert.equal(res._status, 415);
});

// ---------------------------------------------------------------------------
// readJson – oversized body tests (Issue #479)
// Verify that an oversized body returns { __payloadTooLarge: true } without
// throwing a ReferenceError caused by the previously missing logger import.
// ---------------------------------------------------------------------------

function makeReadableStream(data) {
  const readable = new Readable({ read() {} });
  readable.headers = {};
  readable.socket = { remoteAddress: '127.0.0.1' };
  if (data !== undefined) {
    readable.push(Buffer.from(data));
  }
  readable.push(null); // signal end
  return readable;
}

const testConfig = { maxBodyBytes: 64 };

// Content-Length header exceeds limit → must return __payloadTooLarge, no throw
test('readJson returns __payloadTooLarge when Content-Length exceeds limit', async () => {
  const body = 'x'.repeat(200);
  const req = makeReadableStream(body);
  req.headers = { 'content-length': String(body.length) };

  let result;
  let threw = false;
  try {
    result = await readJson(req, testConfig);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'readJson must not throw on oversized Content-Length');
  assert.deepEqual(result, { __payloadTooLarge: true });
});

// Streamed body exceeds limit (no Content-Length) → must return __payloadTooLarge, no throw
test('readJson returns __payloadTooLarge when streamed body exceeds limit', async () => {
  const body = 'x'.repeat(200);
  const req = makeReadableStream(body);
  // no content-length header

  let result;
  let threw = false;
  try {
    result = await readJson(req, testConfig);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'readJson must not throw on oversized streamed body');
  assert.deepEqual(result, { __payloadTooLarge: true });
});

// ---------------------------------------------------------------------------
// requireAuth — timing-safe API key comparison (Issue #481)
// ---------------------------------------------------------------------------

function makeAuthReq(apiKey) {
  return {
    headers: apiKey !== undefined ? { 'x-api-key': apiKey } : {},
    apiKeyScopes: null,
  };
}

function makeAuthRes() {
  const res = { _status: null, _body: null };
  res.writeHead = (status) => { res._status = status; return res; };
  res.end = (body) => { res._body = body; };
  return res;
}

const authConfig = { adminApiKey: 'super-secret-key-abc123' };

test('requireAuth returns true for correct API key', () => {
  const req = makeAuthReq('super-secret-key-abc123');
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, true);
  assert.equal(res._status, null, 'Should not send a response on success');
});

test('requireAuth returns false and sends 401 for wrong API key', () => {
  const req = makeAuthReq('wrong-key');
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
  assert.match(res._body, /UNAUTHORIZED/);
});

test('requireAuth returns false and sends 401 for key that is prefix of correct key', () => {
  // Prefix attack — must fail even though bytes match up to the prefix length
  const req = makeAuthReq('super-secret-key-abc');
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
});

test('requireAuth returns false and sends 401 for key that is correct key plus extra chars', () => {
  const req = makeAuthReq('super-secret-key-abc123EXTRA');
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
});

test('requireAuth returns false and sends 401 for empty key', () => {
  const req = makeAuthReq('');
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
});

test('requireAuth returns false and sends 401 when no key is supplied', () => {
  const req = makeAuthReq(undefined);
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
});

test('requireAuth returns false and sends 503 when adminApiKey is not configured', () => {
  const req = makeAuthReq('any-key');
  const res = makeAuthRes();
  const result = requireAuth(req, res, {});
  assert.equal(result, false);
  assert.equal(res._status, 503);
});

test('requireAuth accepts correct key supplied via Authorization Bearer header', () => {
  const req = {
    headers: { authorization: 'Bearer super-secret-key-abc123' },
    apiKeyScopes: null,
  };
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, true);
});

test('requireAuth rejects wrong key supplied via Authorization Bearer header', () => {
  const req = {
    headers: { authorization: 'Bearer wrong-key' },
    apiKeyScopes: null,
  };
  const res = makeAuthRes();
  const result = requireAuth(req, res, authConfig);
  assert.equal(result, false);
  assert.equal(res._status, 401);
});
