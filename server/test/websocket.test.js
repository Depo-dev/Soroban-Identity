import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { WebSocket } from 'ws';
import {
  WebSocketHub,
  SubscriptionRegistry,
  MessageRateLimiter,
  authenticateUpgrade,
  didRoom,
  roomsForEvent,
  GLOBAL_ROOM,
  CLOSE_RATE_LIMITED,
  MAX_SUBSCRIPTIONS_PER_CLIENT,
} from '../src/websocket.js';

const ACCOUNT_A = `G${'A'.repeat(55)}`;
const ACCOUNT_B = `G${'B'.repeat(55)}`;
const API_KEY = 'test-admin-key';

// ── Room naming ────────────────────────────────────────────────────

test('didRoom maps a bare account and its DID form to the same room', () => {
  assert.equal(didRoom(ACCOUNT_A), didRoom(`did:stellar:${ACCOUNT_A}`));
  assert.equal(didRoom(` ${ACCOUNT_A} `), didRoom(ACCOUNT_A));
});

test('roomsForEvent always includes the global room', () => {
  assert.deepEqual(roomsForEvent({ type: 'x' }), [GLOBAL_ROOM]);
});

test('roomsForEvent derives the DID room from any subject-bearing field', () => {
  for (const event of [
    { subject: ACCOUNT_A },
    { did: ACCOUNT_A },
    { credential: { subject: ACCOUNT_A } },
    { credential: { did: ACCOUNT_A } },
  ]) {
    assert.deepEqual(roomsForEvent(event), [GLOBAL_ROOM, didRoom(ACCOUNT_A)]);
  }
});

// ── SubscriptionRegistry ───────────────────────────────────────────

test('registry tracks rooms per socket and sockets per room', () => {
  const registry = new SubscriptionRegistry();
  const a = {};
  const b = {};

  registry.subscribe(a, 'room-1');
  registry.subscribe(b, 'room-1');
  registry.subscribe(a, 'room-2');

  assert.deepEqual(registry.roomsFor(a).sort(), ['room-1', 'room-2']);
  assert.equal(registry.membersOf('room-1').size, 2);
  assert.equal(registry.roomCount, 2);
});

test('registry unsubscribe reports whether the socket was subscribed', () => {
  const registry = new SubscriptionRegistry();
  const socket = {};
  registry.subscribe(socket, 'room-1');

  assert.equal(registry.unsubscribe(socket, 'room-1'), true);
  assert.equal(registry.unsubscribe(socket, 'room-1'), false);
  assert.equal(registry.roomCount, 0);
});

test('registry remove drops every room the socket held', () => {
  const registry = new SubscriptionRegistry();
  const socket = {};
  registry.subscribe(socket, 'room-1');
  registry.subscribe(socket, 'room-2');

  registry.remove(socket);
  assert.deepEqual(registry.roomsFor(socket), []);
  assert.equal(registry.roomCount, 0);
});

test('registry caps the number of subscriptions per socket', () => {
  const registry = new SubscriptionRegistry();
  const socket = {};
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CLIENT; i += 1) {
    assert.equal(registry.subscribe(socket, `room-${i}`), true);
  }
  assert.equal(registry.subscribe(socket, 'one-too-many'), false);
  // Re-subscribing to a room it already holds is still allowed.
  assert.equal(registry.subscribe(socket, 'room-0'), true);
});

// ── MessageRateLimiter ─────────────────────────────────────────────

test('rate limiter allows up to the limit then refuses', () => {
  const limiter = new MessageRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);

  const refused = limiter.consume();
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1);
});

test('rate limiter refills once the window rolls over', () => {
  let now = 0;
  const limiter = new MessageRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, false);

  now = 1001;
  assert.equal(limiter.consume().allowed, true);
});

// ── authenticateUpgrade ────────────────────────────────────────────

const CONFIG = { adminApiKey: API_KEY, wsPath: '/ws' };

function upgradeUrl(query = '') {
  return new URL(`http://localhost/ws${query}`);
}

test('upgrade authentication accepts the admin key from a header', async () => {
  const result = await authenticateUpgrade(
    { headers: { 'x-api-key': API_KEY } },
    upgradeUrl(),
    { config: CONFIG },
  );
  assert.equal(result.ok, true);
});

test('upgrade authentication accepts a Bearer token', async () => {
  const result = await authenticateUpgrade(
    { headers: { authorization: `Bearer ${API_KEY}` } },
    upgradeUrl(),
    { config: CONFIG },
  );
  assert.equal(result.ok, true);
});

test('upgrade authentication accepts a token query parameter', async () => {
  const result = await authenticateUpgrade({ headers: {} }, upgradeUrl(`?token=${API_KEY}`), {
    config: CONFIG,
  });
  assert.equal(result.ok, true);
});

test('upgrade authentication rejects a missing or wrong key', async () => {
  const missing = await authenticateUpgrade({ headers: {} }, upgradeUrl(), { config: CONFIG });
  assert.deepEqual(missing, { ok: false, reason: 'missing_api_key' });

  const wrong = await authenticateUpgrade(
    { headers: { 'x-api-key': 'nope' } },
    upgradeUrl(),
    { config: CONFIG },
  );
  assert.deepEqual(wrong, { ok: false, reason: 'invalid_api_key' });
});

test('upgrade authentication honours issued keys and their scopes', async () => {
  const apiKeyService = {
    validateKey: async (token) =>
      token === 'reader' ? { id: 'key_1', tier: 'pro', scopes: ['credentials:read'] }
        : token === 'writer-only' ? { id: 'key_2', tier: 'free', scopes: ['credentials:write'] }
          : null,
  };

  const reader = await authenticateUpgrade({ headers: { 'x-api-key': 'reader' } }, upgradeUrl(), {
    config: CONFIG,
    apiKeyService,
  });
  assert.equal(reader.ok, true);
  assert.equal(reader.auth.keyId, 'key_1');

  const writer = await authenticateUpgrade(
    { headers: { 'x-api-key': 'writer-only' } },
    upgradeUrl(),
    { config: CONFIG, apiKeyService },
  );
  assert.deepEqual(writer, { ok: false, reason: 'insufficient_scope' });
});

// ── Integration harness ────────────────────────────────────────────

async function withHub(run, { config = {}, soroban = null } = {}) {
  const hubConfig = {
    adminApiKey: API_KEY,
    wsPath: '/ws',
    eventPollIntervalMs: 0,
    ...config,
  };

  const server = http.createServer((req, res) => {
    res.writeHead(404).end();
  });

  const hub = new WebSocketHub({
    config: hubConfig,
    soroban,
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? 0,
    rateLimit: config.rateLimit ?? {},
  });

  // Polling is driven explicitly in tests via pollOnce().
  hub._startPolling = () => {};
  hub.attach(server);

  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  /** Open a client and resolve once the server's "connected" frame arrives. */
  const connect = (query = `?token=${API_KEY}`) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws${query}`);
      const inbox = [];
      const waiters = [];

      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else inbox.push(message);
      });

      /** Await the next message, whether it has already arrived or not. */
      ws.next = () =>
        new Promise((resolveNext, rejectNext) => {
          if (inbox.length > 0) return resolveNext(inbox.shift());
          const timer = setTimeout(() => rejectNext(new Error('timed out waiting for a message')), 3000);
          waiters.push((message) => { clearTimeout(timer); resolveNext(message); });
        });

      ws.closed = new Promise((resolveClosed) => {
        ws.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
      });

      ws.on('error', reject);
      ws.on('open', async () => {
        try {
          const first = await ws.next();
          ws.connectedFrame = first;
          resolve(ws);
        } catch (error) {
          reject(error);
        }
      });
    });

  /** Attempt a connection expected to be refused during the handshake. */
  const expectRejected = (query) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws${query}`);
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ statusCode: res.statusCode });
      });
      ws.on('open', () => { ws.close(); reject(new Error('connection unexpectedly succeeded')); });
      ws.on('error', (error) => {
        if (!/Unexpected server response/.test(error.message)) reject(error);
      });
    });

  try {
    await run({ hub, connect, expectRejected, port });
  } finally {
    await hub.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── Integration: authentication ────────────────────────────────────

test('an unauthenticated upgrade is refused with 401 before the handshake', async () => {
  await withHub(async ({ expectRejected, hub }) => {
    const result = await expectRejected('');
    assert.equal(result.statusCode, 401);
    assert.equal(hub.clientCount, 0);
  });
});

test('a wrong API key is refused with 401', async () => {
  await withHub(async ({ expectRejected }) => {
    const result = await expectRejected('?token=wrong-key');
    assert.equal(result.statusCode, 401);
  });
});

test('an authenticated client receives a connected frame', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect();
    assert.equal(ws.connectedFrame.type, 'connected');
    assert.deepEqual(ws.connectedFrame.subscriptions, []);
    assert.equal(hub.clientCount, 1);
    ws.close();
  });
});

// ── Integration: subscriptions ─────────────────────────────────────

test('a client can subscribe to a DID room and receive its events', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', did: ACCOUNT_A }));

    const ack = await ws.next();
    assert.equal(ack.type, 'subscribed');
    assert.deepEqual(ack.rooms, [didRoom(ACCOUNT_A)]);

    hub.emitCredentialEvent('issued', { id: 'cred-1', subject: ACCOUNT_A });
    const event = await ws.next();
    assert.equal(event.type, 'credential.status');
    assert.equal(event.status, 'issued');
    assert.equal(event.credential.id, 'cred-1');
    assert.ok(event.ts);

    ws.close();
  });
});

test('a DID subscription can be requested in the connection query string', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect(`?token=${API_KEY}&did=${ACCOUNT_A}`);
    assert.deepEqual(ws.connectedFrame.subscriptions, [didRoom(ACCOUNT_A)]);

    hub.emitCredentialEvent('revoked', { id: 'cred-2', subject: ACCOUNT_A });
    const event = await ws.next();
    assert.equal(event.status, 'revoked');
    ws.close();
  });
});

test('events for one DID are not delivered to another DID room', async () => {
  await withHub(async ({ connect, hub }) => {
    const listener = await connect();
    listener.send(JSON.stringify({ type: 'subscribe', did: ACCOUNT_B }));
    await listener.next();

    const delivered = hub.emitCredentialEvent('issued', { id: 'cred-3', subject: ACCOUNT_A });
    assert.equal(delivered, 0);
    listener.close();
  });
});

test('a client subscribed to both the global and a DID room receives one copy', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', all: true, did: ACCOUNT_A }));
    const ack = await ws.next();
    assert.equal(ack.subscriptions.length, 2);

    const delivered = hub.emitCredentialEvent('issued', { id: 'cred-4', subject: ACCOUNT_A });
    assert.equal(delivered, 1);

    const event = await ws.next();
    assert.equal(event.credential.id, 'cred-4');
    ws.close();
  });
});

test('unsubscribe stops delivery and reports the removed rooms', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', did: ACCOUNT_A }));
    await ws.next();

    ws.send(JSON.stringify({ type: 'unsubscribe', did: ACCOUNT_A }));
    const ack = await ws.next();
    assert.equal(ack.type, 'unsubscribed');
    assert.deepEqual(ack.rooms, [didRoom(ACCOUNT_A)]);
    assert.deepEqual(ack.subscriptions, []);

    assert.equal(hub.emitCredentialEvent('issued', { id: 'cred-5', subject: ACCOUNT_A }), 0);
    ws.close();
  });
});

test('DID updates reach the subscribed room', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect(`?token=${API_KEY}&did=${ACCOUNT_A}`);
    hub.emitDidEvent('issuer_added', ACCOUNT_A, { subject: ACCOUNT_A });

    const event = await ws.next();
    assert.equal(event.type, 'did.updated');
    assert.equal(event.action, 'issuer_added');
    assert.equal(event.did, ACCOUNT_A);
    ws.close();
  });
});

// ── Integration: protocol errors and rate limiting ─────────────────

test('a non-JSON message is answered with an error, not a disconnect', async () => {
  await withHub(async ({ connect }) => {
    const ws = await connect();
    ws.send('this is not json');

    const error = await ws.next();
    assert.equal(error.type, 'error');
    assert.equal(error.code, 'INVALID_MESSAGE');
    assert.equal(ws.readyState, ws.OPEN);
    ws.close();
  });
});

test('an unknown message type is reported', async () => {
  await withHub(async ({ connect }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'teleport' }));

    const error = await ws.next();
    assert.equal(error.code, 'UNKNOWN_MESSAGE_TYPE');
    ws.close();
  });
});

test('a subscribe naming nothing is rejected', async () => {
  await withHub(async ({ connect }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe' }));

    const error = await ws.next();
    assert.equal(error.code, 'INVALID_MESSAGE');
    ws.close();
  });
});

test('a client ping is answered with a pong', async () => {
  await withHub(async ({ connect }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'ping' }));

    const pong = await ws.next();
    assert.equal(pong.type, 'pong');
    assert.ok(pong.ts);
    ws.close();
  });
});

test('a client exceeding its message rate limit is closed', async () => {
  await withHub(
    async ({ connect }) => {
      const ws = await connect();
      ws.send(JSON.stringify({ type: 'ping' }));
      await ws.next(); // pong
      ws.send(JSON.stringify({ type: 'ping' }));
      await ws.next(); // pong
      ws.send(JSON.stringify({ type: 'ping' })); // over the limit

      const error = await ws.next();
      assert.equal(error.code, 'RATE_LIMIT_EXCEEDED');
      assert.ok(error.retryAfterSeconds >= 1);

      const closed = await ws.closed;
      assert.equal(closed.code, CLOSE_RATE_LIMITED);
    },
    { config: { rateLimit: { limit: 2, windowMs: 60_000 } } },
  );
});

test('a disconnected client is removed from every room', async () => {
  await withHub(async ({ connect, hub }) => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', did: ACCOUNT_A }));
    await ws.next();
    assert.equal(hub.registry.roomCount, 1);

    ws.close();
    await ws.closed;
    // Give the server's close handler a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.registry.roomCount, 0);
  });
});

// ── Integration: contract event polling ────────────────────────────

test('polled contract events are broadcast to the global room', async () => {
  const soroban = {
    getEvents: async () => [
      { id: 'ev-1', topic: ['CRED', 'issued'], ledger: 10, contractId: 'C1' },
    ],
  };

  await withHub(
    async ({ connect, hub }) => {
      const ws = await connect();
      ws.send(JSON.stringify({ type: 'subscribe', all: true }));
      await ws.next();

      const count = await hub.pollOnce();
      assert.equal(count, 1);

      const event = await ws.next();
      assert.equal(event.type, 'contract.event');
      assert.equal(event.event.ledger, 10);
      ws.close();
    },
    { soroban },
  );
});

test('polling advances the ledger cursor so an event is not re-sent', async () => {
  let call = 0;
  const soroban = {
    getEvents: async (from) => {
      call += 1;
      if (call === 1) return [{ id: 'ev-1', topic: ['CRED', 'issued'], ledger: 10 }];
      assert.equal(from, 11, 'second poll should resume after the highest ledger seen');
      return [];
    },
  };

  await withHub(
    async ({ hub }) => {
      assert.equal(await hub.pollOnce(), 1);
      assert.equal(await hub.pollOnce(), 0);
    },
    { soroban },
  );
});

test('a failing poll is logged and does not throw', async () => {
  const soroban = {
    getEvents: async () => { throw new Error('rpc exploded'); },
  };

  await withHub(
    async ({ hub }) => {
      assert.equal(await hub.pollOnce(), 0);
    },
    { soroban },
  );
});

test('an upgrade on another path is left for other handlers', async () => {
  await withHub(async ({ hub }) => {
    let destroyed = false;
    let written = '';
    const socket = {
      write(chunk) { written += chunk; },
      destroy() { destroyed = true; },
    };

    // A path the hub does not own must be left untouched: no HTTP rejection
    // written, no socket destroyed, and no client registered — so another
    // upgrade handler on the same server can still claim it.
    await hub._handleUpgrade(
      { url: '/not-ws', headers: { host: 'localhost' } },
      socket,
      Buffer.alloc(0),
    );

    assert.equal(written, '');
    assert.equal(destroyed, false);
    assert.equal(hub.clientCount, 0);
  });
});

test('an upgrade on the hub path without a key is rejected with a 401 response', async () => {
  await withHub(async ({ hub }) => {
    let destroyed = false;
    let written = '';
    const socket = {
      write(chunk) { written += chunk; },
      destroy() { destroyed = true; },
    };

    await hub._handleUpgrade(
      { url: '/ws', headers: { host: 'localhost' } },
      socket,
      Buffer.alloc(0),
    );

    assert.match(written, /^HTTP\/1\.1 401 Unauthorized/);
    assert.match(written, /missing_api_key/);
    assert.equal(destroyed, true);
  });
});
