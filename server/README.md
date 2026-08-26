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

## Request Validation

Every mutating endpoint and every query-bearing endpoint is validated with a
[Zod](https://zod.dev) schema before its handler runs. Schemas live in
`src/validation.js` and are keyed by route.

### What is validated

| Section | Notes |
| --- | --- |
| Body | JSON bodies are validated against a strict schema — unknown keys are rejected. |
| Query parameters | Values are parsed and range-checked (for example `limit` must be 1-200). |
| Path parameters | Credential identifiers are pattern-checked before any lookup. |
| Headers | `x-request-id`, `x-user-tier`, `x-api-version` and `x-actor` are validated on every request. |

### Sanitization

All string inputs are sanitized before schema checks run: surrounding
whitespace is trimmed and ASCII control characters (including NUL and the C1
range) are stripped, from values *and* object keys. A value that is only
padding therefore fails its schema rather than being silently accepted.

### Custom validators

| Validator | Accepts |
| --- | --- |
| `stellarAccount` | `G` followed by 55 base32 characters. |
| `stellarContract` | `C` followed by 55 base32 characters. |
| `did` | `did:stellar:<STELLAR_ACCOUNT>`. |
| `credentialId` | 3-128 characters of `A-Z a-z 0-9 . _ : -` — no `/` or whitespace, so an id can never alter routing. |
| `subject` | Either a Stellar account address or a `did:stellar` DID. |
| `httpUrl` | An absolute `http:` or `https:` URL. |

### Error responses

A failed request returns `400` with one entry per offending field:

```json
{
  "error": "validation_failed",
  "code": "VALIDATION_FAILED",
  "message": "Request validation failed.",
  "errors": [
    { "field": "id", "source": "body", "message": "Must be 3-128 characters using letters, digits, dot, underscore, colon or hyphen", "code": "custom" },
    { "field": "limit", "source": "query", "message": "Must be between 1 and 200", "code": "custom" }
  ]
}
```

`source` is one of `body`, `query`, `params` or `headers`, so a client can map
each error back to the part of the request that produced it. Errors from every
section are collected in a single pass rather than reported one at a time.

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
