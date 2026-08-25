import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { formatEvent, normalizeContractEvent, handleEventsRequest } from '../src/sse.js';

// formatEvent must never throw on unserializable data — it logs and returns
// null so the caller can skip just that one event instead of crashing.
test('formatEvent returns null instead of throwing on circular data', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(formatEvent('contract-event', circular), null);
});

test('formatEvent formats a well-formed event as an SSE frame', () => {
  const frame = formatEvent('contract-event', { id: '1' });
  assert.equal(frame, 'event: contract-event\ndata: {"id":"1"}\n\n');
});

// normalizeContractEvent must coerce malformed RPC payloads to safe
// defaults rather than throwing.
test('normalizeContractEvent returns null for non-object input', () => {
  assert.equal(normalizeContractEvent(null), null);
  assert.equal(normalizeContractEvent('not-an-event'), null);
});

test('normalizeContractEvent tolerates missing/malformed fields', () => {
  const event = normalizeContractEvent({ topic: 'not-an-array', ledger: 'NaN-not-a-number' });
  assert.equal(event.contractId, '');
  assert.deepEqual(event.topic, []);
  assert.equal(event.ledger, 0);
  assert.equal(typeof event.id, 'string');
});

test('normalizeContractEvent parses a well-formed event', () => {
  const event = normalizeContractEvent({
    id: 'evt-1',
    contractId: 'CCONTRACT',
    topic: ['IDENTITY', 'updated'],
    value: { foo: 'bar' },
    ledger: 42,
    txHash: 'abc',
    ledgerClosedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(event, {
    id: 'evt-1',
    type: 'IDENTITY',
    contractId: 'CCONTRACT',
    topic: ['IDENTITY', 'updated'],
    value: { foo: 'bar' },
    ledger: 42,
    txHash: 'abc',
    timestamp: '2026-01-01T00:00:00Z',
  });
});

function makeRes() {
  const res = new EventEmitter();
  res.writes = [];
  res.writeHead = (status, headers) => { res._status = status; res._headers = headers; return res; };
  res.write = (chunk) => { res.writes.push(chunk); return true; };
  return res;
}

// The end-to-end regression for the original bug report: a malformed event
// from the RPC node must not crash the request handler or kill the stream.
test('handleEventsRequest skips malformed events without throwing', async () => {
  const req = new EventEmitter();
  const res = makeRes();
  const url = new URL('http://localhost/events');
  const soroban = {
    getEvents: async () => [
      { id: 'good', contractId: 'C1', topic: ['IDENTITY'], value: {}, ledger: 1, txHash: 'x', ledgerClosedAt: '2026-01-01T00:00:00Z' },
      null, // malformed: not an object at all
      { id: 'bad', contractId: 'C1', topic: ['IDENTITY'], ledger: 2, get value() { throw new Error('boom'); } }, // throws while normalizing
    ],
  };
  const config = { eventPollIntervalMs: 5 };

  assert.doesNotThrow(() => handleEventsRequest(req, res, url, { config, soroban }));

  // Let the poll timer fire at least once.
  await new Promise((resolve) => setTimeout(resolve, 20));
  req.emit('close');

  assert.equal(res._status, 200);
  assert.equal(res._headers['Content-Type'], 'text/event-stream');
  assert.ok(res.writes.some((chunk) => chunk.includes('event: connected')));
  assert.ok(res.writes.some((chunk) => chunk.includes('"id":"good"')));
  assert.ok(!res.writes.some((chunk) => chunk.includes('"id":"bad"')));
});
