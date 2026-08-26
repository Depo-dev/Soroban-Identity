# Soroban Identity Server

Operational HTTP API server for Soroban Identity smart contracts. It exposes metrics, admin issuer management, and credential expiry tracking.

## Usage

### Run the Server
```bash
npm start
```

### Run Tests
```bash
npm test
```

## Configuration

The server configuration can be customized using the following environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port the server listens on. | `3001` |
| `LOG_LEVEL` | Logging verbosity (trace, debug, info, warn, error, fatal). All logs are structured JSON. | `info` |
| `ADMIN_API_KEY` | Key for authenticating request calls on `/admin/*` endpoints. Supports scoped access (see API Key Scopes below). | unset |
| `DATA_DIR` | Directory path for local file storage. | `./data` |
| `AUDIT_LOG_PATH` | Base file path prefix used for daily rotated audit logs. | `[DATA_DIR]/audit` |
| `AUDIT_LOG_RETENTION_DAYS` | Number of days to retain rotated audit logs. | `30` |
| `CREDENTIAL_STORE_PATH` | Storage location for credential records. | `[DATA_DIR]/credentials.json` |
| `EXPIRY_CONCURRENCY` | Maximum concurrent credential expiry notifications. Controls parallelism to prevent event loop blocking. | `8` |
| `WS_ENABLED` | Enable the WebSocket endpoint. Set to `false` to disable it. | `true` |
| `WS_PATH` | Path clients connect to for real-time updates. | `/ws` |
| `WS_MESSAGE_LIMIT` | Inbound messages allowed per connection per window. | `60` |
| `WS_MESSAGE_WINDOW_MS` | Length of the inbound message rate-limit window. | `60000` |
| `WS_HEARTBEAT_INTERVAL_MS` | Ping interval used to detect dead connections. `0` disables heartbeats. | `30000` |

## WebSocket API

Real-time credential status changes and DID updates are pushed over a
WebSocket at `WS_PATH` (default `/ws`).

### Connecting

Authentication happens during the HTTP upgrade, so an unauthenticated client
never becomes a WebSocket — it receives a plain `401` (or `403` when the key
lacks `credentials:read`) and the socket is closed.

The API key may be supplied three ways:

```bash
# Query parameter — the only option available to a browser, which cannot set
# headers on a WebSocket handshake
wscat -c "ws://localhost:3001/ws?token=$API_KEY"

# Header, for server-to-server clients
wscat -c ws://localhost:3001/ws -H "X-API-Key: $API_KEY"
wscat -c ws://localhost:3001/ws -H "Authorization: Bearer $API_KEY"
```

A `did` query parameter subscribes on connect, so a reconnecting client can
restore its subscriptions in the handshake rather than waiting for a round
trip. It may be repeated:

```
ws://localhost:3001/ws?token=KEY&did=GABC...&did=GDEF...
```

On success the server sends:

```json
{
  "type": "connected",
  "subscriptions": ["did:GABC..."],
  "heartbeatIntervalMs": 30000,
  "rateLimit": { "limit": 60, "windowMs": 60000 },
  "ts": "2026-01-01T00:00:00.000Z"
}
```

### Rooms

A subscription is a room. `did:<account>` receives events concerning one
subject; `all` receives everything. A subject may be named as a bare Stellar
account or as a `did:stellar:` DID — both resolve to the same room, so a client
need not know which form a credential was stored with.

A connection may hold at most 50 subscriptions.

### Client messages

| Message | Effect |
| --- | --- |
| `{"type":"subscribe","did":"GABC..."}` | Join one DID room. |
| `{"type":"subscribe","dids":["GABC...","GDEF..."]}` | Join several DID rooms. |
| `{"type":"subscribe","all":true}` | Join the global room. |
| `{"type":"unsubscribe","did":"GABC..."}` | Leave a room. Accepts the same fields as `subscribe`. |
| `{"type":"ping"}` | Answered with `{"type":"pong","ts":...}`. |

`subscribe` is answered with `{"type":"subscribed","rooms":[...],"subscriptions":[...]}`,
and `unsubscribe` with the equivalent `unsubscribed` frame.

### Server events

| Event | Sent when |
| --- | --- |
| `credential.status` | A credential is issued or revoked. Carries `status` (`issued`/`revoked`) and the `credential`. |
| `did.updated` | A DID changes — currently `issuer_added` and `issuer_removed`. |
| `contract.event` | A normalized on-chain event from the ledger poller. |

Every event carries a `ts` timestamp. A client subscribed to both the global
room and the relevant DID room receives one copy, not two.

### Errors

Protocol problems are reported without dropping the connection:

| Code | Meaning |
| --- | --- |
| `INVALID_MESSAGE` | The message was not JSON, or a `subscribe` named no rooms. |
| `UNKNOWN_MESSAGE_TYPE` | Unsupported `type`. |
| `SUBSCRIPTION_LIMIT` | The connection is already at 50 subscriptions. |
| `RATE_LIMIT_EXCEEDED` | Too many inbound messages; the connection is then closed with code `4029`. |

### Rate limiting

Each connection holds its own token bucket — `WS_MESSAGE_LIMIT` messages per
`WS_MESSAGE_WINDOW_MS`. A client that exhausts it is sent a
`RATE_LIMIT_EXCEEDED` error carrying `retryAfterSeconds` and then closed with
code `4029`, rather than being silently throttled: dropping subscribe messages
would leave a client believing it is subscribed when it is not.

Inbound messages larger than 16KB are rejected by the protocol layer.

### Reconnection

The server pings every connection every `WS_HEARTBEAT_INTERVAL_MS` and
terminates any that missed the previous ping, so a half-open connection is
reaped rather than lingering.

Clients should reconnect with exponential backoff and restore their
subscriptions using `did` query parameters on the new handshake. Close codes
tell a client whether reconnecting is worthwhile:

| Code | Meaning |
| --- | --- |
| `1001` | Server shutting down — reconnect after a delay. |
| `4001` | Credentials are no longer valid — do not retry without a new key. |
| `4029` | Rate limited — reconnect after `retryAfterSeconds`. |

```js
function connect(url, backoffMs = 1000) {
  const ws = new WebSocket(url);
  ws.addEventListener('close', (event) => {
    if (event.code === 4001) return;              // fix the key first
    const delay = event.code === 4029 ? 60_000 : backoffMs;
    setTimeout(() => connect(url, Math.min(backoffMs * 2, 30_000)), delay);
  });
  return ws;
}
```
| `EXPIRY_WARNING_DAYS` | Fallback warning window in days when no reminder threshold applies. | `7` |
| `EXPIRY_REMINDER_THRESHOLDS` | Comma-separated days-before-expiry at which a reminder is sent. | `30,7,1` |
| `EXPIRY_JOB_INTERVAL_MS` | Interval between expiry job runs when no cron schedule is configured. | `3600000` |
| `EXPIRY_CRON_SCHEDULE` | Standard 5-field cron expression for the expiry job. When set it replaces the fixed interval. | unset |
| `NOTIFICATION_WEBHOOK_URL` | Fallback webhook receiving expiry reminders. | unset |
| `SUBJECT_NOTIFICATION_WEBHOOKS` | JSON map of subject address to webhook url. | `{}` |
| `EMAIL_API_URL` | HTTP endpoint of the email provider used for expiry reminders. Enables email delivery together with `EMAIL_FROM`. | unset |
| `EMAIL_API_KEY` | Bearer token sent to `EMAIL_API_URL`. | unset |
| `EMAIL_FROM` | Sender address for reminder emails. Required when `EMAIL_API_URL` is set. | unset |
| `NOTIFICATION_EMAIL` | Fallback recipient address for reminder emails. | unset |
| `SUBJECT_NOTIFICATION_EMAILS` | JSON map of subject address to recipient email. | `{}` |
| `NOTIFICATION_MAX_RETRIES` | Attempts per notification channel before it is recorded as failed. | `3` |
| `NOTIFICATION_RETRY_BASE_MS` | Base delay for exponential backoff between notification attempts. | `500` |

## Credential Expiry Notifications

A background job scans stored credentials and notifies holders before a
credential expires.

### Scheduling

By default the job runs on a fixed interval (`EXPIRY_JOB_INTERVAL_MS`). Setting
`EXPIRY_CRON_SCHEDULE` switches it to a cron schedule instead:
| `REDIS_URL` | Redis connection URL (`redis://` or `rediss://`). Unset disables the DID cache. | unset |
| `DID_CACHE_TTL_MS` | TTL applied to cached DID documents. | `60000` |
| `REDIS_MAX_RETRIES` | Connection attempts before the cache is left unavailable. | `5` |
| `REDIS_RETRY_BASE_MS` | Base delay for connection backoff. | `200` |
| `REDIS_COMMAND_TIMEOUT_MS` | Per-command timeout. | `1000` |
| `CACHE_FAILURE_THRESHOLD` | Consecutive failures before the cache is bypassed. | `3` |
| `DID_CACHE_WARM_LIST` | Comma-separated DIDs or addresses to pre-resolve at startup. | unset |

## DID Resolution Cache

`SorobanClient.resolveDid()` reads through a Redis cache when `REDIS_URL` is
set, cutting repeat resolutions of the same DID down to one Redis round trip
instead of an RPC call.

### Graceful degradation

The cache is never on the critical path. A miss, a Redis error, a command
timeout, or a completely unreachable Redis all fall through to the contract, so
resolution still succeeds — just slower. Specifically:

- A failed connection at startup logs and continues; the server boots uncached.
- After `CACHE_FAILURE_THRESHOLD` consecutive failures the cache is bypassed
  entirely and a reconnect runs in the background, so requests stop paying the
  Redis timeout on every call. A successful reconnect closes the breaker.
- A corrupt cache entry is treated as a miss and deleted, rather than being
  left to poison every later read of that DID.
- Only real documents are cached. A negative result is never stored, so a DID
  created moments later is not invisible for the whole TTL.

### Keys and invalidation

`did:stellar:G...` and a bare `G...` normalise to the same key
(`did:doc:<address>`), so the two forms cannot drift apart on invalidation.

`SorobanClient.invalidateDid()` drops one entry — call it after any write that
changes a document. Two admin endpoints expose this operationally:

| Endpoint | Scope | Description |
| --- | --- | --- |
| `GET /cache/stats` | `admin:read` | Hits, misses, errors, invalidations, and hit rate |
| `DELETE /cache/dids` | `admin:write` | Flush every cached DID (SCAN-based, never `KEYS`) |
| `DELETE /cache/dids/:did` | `admin:write` | Invalidate one DID |

### Metrics

`did_cache_hits_total`, `did_cache_misses_total`, `did_cache_sets_total`,
`did_cache_errors_total`, and `did_cache_invalidations_total` are exported on
`/metrics` alongside the existing counters.

### Warming

`DID_CACHE_WARM_LIST` pre-resolves a comma-separated set of DIDs at startup.
Warming runs in the background so boot is not blocked on RPC round trips, and
one failing DID does not abort the rest.

### Redis client

The client is implemented directly against `node:net`/`node:tls` in
`src/redis-client.js`, because this server ships with pino as its only runtime
dependency. It speaks RESP, supports `redis://` and `rediss://` with optional
auth and database selection, and covers GET, SET with TTL, DEL, SCAN, and PING
with connection retry and per-command timeouts.

## API Key Scopes

The server supports granular access control through API key scopes. Instead of granting full access, you can issue scoped keys for specific operations.

### Scope Format

```
<api-key>:<scope1>,<scope2>,<scope3>
```

### Available Scopes

- **`credentials:read`** - Verify and read credentials
- **`credentials:write`** - Issue new credentials
- **`admin:read`** - View administrative data (issuers, expiry reports)
- **`admin:write`** - Modify administrative settings (add/remove issuers)
- **`*`** - Wildcard grants all permissions

### Examples

```bash
# Read-only dashboard access
X-API-Key: my-key:credentials:read,admin:read

# Issuer integration (write-only)
X-API-Key: my-key:credentials:write

# Full admin access
X-API-Key: my-key:admin:read,admin:write

# Full access (wildcard)
X-API-Key: my-key:*

# Legacy format (no scopes = full access)
X-API-Key: my-key
```

For detailed documentation, see [API Key Scopes](../docs/api-key-scopes.md).

## Audit Log Naming & Rotation

The system generates a new, separate audit log file for each day. The log files are stored in Newline Delimited JSON (NDJSON) format.

### Log File Naming
The log file name is derived by appending the current UTC date to the base log path prefix:
`audit-YYYY-MM-DD.ndjson`

* Day 1 logs are written to `audit-YYYY-MM-Day1.ndjson`.
* Day 2 logs are written to `audit-YYYY-MM-Day2.ndjson`.

### Cleanup & Retention
Every time the server starts, it scans the logs folder and deletes any rotated log files that are older than `AUDIT_LOG_RETENTION_DAYS` days (default is 30 days) to prevent disk space exhaustion.
