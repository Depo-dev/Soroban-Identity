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
| `RATE_LIMIT_WHITELIST` | Comma-separated IPs or CIDR ranges exempt from rate limiting. | unset |
| `RATE_LIMIT_MAX_BUCKETS` | Bucket count that triggers eviction of expired windows. | `10000` |
| `TRUST_PROXY` | Trust `X-Forwarded-For` when resolving the client IP. | `false` |

## Rate Limiting

Two budgets apply to every non-exempt request, and both must be satisfied.
`/info`, `/health`, and `/metrics` are exempt.

### Per-endpoint limits

Evaluated first, since they are the tighter constraint on the expensive routes.
The first matching rule wins.

| Rule | Match | Limit |
| --- | --- | --- |
| `credential_issuance` | `POST /credentials`, `POST /credentials/issue` | 10 per 15 min |
| `credential_revocation` | `POST /credentials/:id/revoke` | 20 per 15 min |
| `general` | everything else | 100 per 15 min |
| `CORS_ORIGIN` | Allowed browser origins. A single origin, a comma-separated list, or `*`. | `*` in development, none in production |
| `CORS_CREDENTIALS` | Whether to send `Access-Control-Allow-Credentials`. Cannot be combined with `CORS_ORIGIN=*`. | `false` |
| `CORS_METHODS` | Comma-separated methods advertised on a preflight. | `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| `CORS_ALLOWED_HEADERS` | Comma-separated request headers a browser may send. | `Content-Type,Authorization,X-API-Key,X-Request-ID,X-Actor,X-User-Tier,X-API-Version` |
| `CORS_EXPOSED_HEADERS` | Comma-separated response headers readable by browser JavaScript. | `X-Request-ID,Content-Type,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-API-Version` |
| `CORS_MAX_AGE` | Seconds a browser may cache a preflight result. `0` disables caching. | `86400` |
| `ACCESS_LOG_ENABLED` | Emit one structured record per completed request. | `true` |
| `ACCESS_LOG_PATH` | Also write access records to this file, with rotation. Unset means stdout only. | unset |
| `ACCESS_LOG_MAX_BYTES` | Size at which the access log file rotates. | `10485760` |
| `ACCESS_LOG_MAX_FILES` | Rotated files to retain. | `5` |
| `LOG_PAYLOADS` | Include redacted request and response bodies in access records. | `false` |
| `LOG_HEADERS` | Include redacted request headers in access records. | `false` |
| `LOG_PAYLOAD_MAX_BYTES` | Size at which a logged payload is truncated. | `2048` |
| `TRUST_PROXY` | Trust `X-Forwarded-For` / `X-Real-IP` for the client IP. | `false` |

## API Request Logging

Cross-origin access is configured entirely through environment variables, so a
single build serves local development, staging and production.

### Origins

`CORS_ORIGIN` takes one origin, a comma-separated list, or `*`:

```bash
# Local development — the default in NODE_ENV=development
CORS_ORIGIN=*

# One origin
CORS_ORIGIN=https://app.example.com

# Several origins
CORS_ORIGIN=https://app.example.com,https://admin.example.com,http://localhost:5173
```

An origin is matched exactly, so `https://app.example.com.evil.com` never
matches `https://app.example.com`. When `CORS_ORIGIN` is unset the server
allows all origins in development and none in production — a production
deployment must name its origins rather than inherit a permissive default.

`CORS_ALLOWED_ORIGINS` is still read as an alias for existing deployments;
`CORS_ORIGIN` wins when both are set.

Each value must be a bare origin (`scheme://host[:port]`). A value with a path,
query or fragment is rejected at startup, because an `Origin` header never
carries one and such a value could never match a real request.

### Credentials

```bash
CORS_ORIGIN=https://app.example.com
CORS_CREDENTIALS=true
```

`CORS_CREDENTIALS` accepts `true/false`, `1/0`, `yes/no` and `on/off`. It is
`false` by default.

The CORS spec forbids credentials with a wildcard origin — a browser rejects
such a response outright — so enabling credentials while `CORS_ORIGIN` is `*`
(including by relying on the development default) fails validation at startup
rather than at the browser. When credentials are enabled and the origin list is
a wildcard by other means, the server reflects the request's own origin instead
of sending `*`.

### Methods and headers

```bash
CORS_METHODS=GET,POST
CORS_ALLOWED_HEADERS=Content-Type,X-API-Key
CORS_EXPOSED_HEADERS=X-Request-ID,X-RateLimit-Remaining
```

`CORS_METHODS` and `CORS_ALLOWED_HEADERS` populate the preflight response.
`CORS_EXPOSED_HEADERS` lists the response headers browser JavaScript may read;
it defaults to `X-Request-ID`, `Content-Type`, the rate-limit headers and
`X-API-Version`.

### Preflight caching

```bash
CORS_MAX_AGE=600
```

`CORS_MAX_AGE` is the `Access-Control-Max-Age` value in seconds, defaulting to
`86400` (24 hours). Browsers apply their own upper bound. Setting it to `0`
disables preflight caching, which is useful while iterating on the header
configuration.

### Vary

Whenever the allowed origin depends on the request — a specific origin list, or
a wildcard with credentials enabled — the server sends `Vary: Origin` so a
shared cache cannot serve one origin's response to another.

### Example deployments

```bash
# Development
NODE_ENV=development npm start

# Staging with a credentialed dashboard
NODE_ENV=production CORS_ORIGIN=https://staging.example.com CORS_CREDENTIALS=true npm start

# Production, read-only public API, short preflight cache
NODE_ENV=production CORS_ORIGIN=https://app.example.com,https://docs.example.com CORS_METHODS=GET,OPTIONS CORS_MAX_AGE=300 npm start
```

These are per client, and independent of each other: exhausting the issuance
budget does not block reads. A `GET /credentials` is a read and falls under
`general`, not `credential_issuance`.

### Per-tier limits

The existing subscription tiers still apply on top, with separate read and
write budgets:

| Tier | Reads | Writes |
| --- | --- | --- |
| free | 60/min | 20/min |
| pro | 300/min | 100/min |
| enterprise | 1200/min | 500/min |

### Response headers

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Limit of whichever budget is closest to exhaustion |
| `X-RateLimit-Remaining` | Requests left in that budget |
| `X-RateLimit-Reset` | Unix seconds at which it resets |
| `X-RateLimit-Tier` | Resolved subscription tier |
| `X-RateLimit-Scope` | `endpoint` or `tier` |
| `X-RateLimit-Bypass` | `whitelist` when the caller is exempt |
| `Retry-After` | Seconds to wait, sent with every 429 |

The reported budget is whichever will stop the client first, so the headers are
not misleading when the endpoint limit is nearly spent but the tier limit is
not.

### 429 responses

```json
{
  "error": "rate_limit_exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "scope": "endpoint",
  "rule": "credential_issuance",
  "message": "Rate limit exceeded for 'credential_issuance' (10 requests per window). Retry in 840s.",
  "limit": 10,
  "windowMinutes": 14,
  "retryAfter": 840
| Section | Notes |
| --- | --- |
| Body | JSON bodies are validated against a strict schema — unknown keys are rejected. |
| Query parameters | Values are parsed and range-checked (for example `limit` must be 1-200). |
| Path parameters | Credential identifiers are pattern-checked before any lookup. |
| Headers | `x-request-id`, `x-user-tier`, `x-api-version` and `x-actor` are validated on every request. |

### Sanitization
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
Every completed request emits one structured JSON record through pino, at a
level derived from the status: `info` below 400, `warn` for 4xx, `error` for
5xx.

```json
{
  "level": "info",
  "time": "2026-01-01T00:00:00.000Z",
  "type": "http_access",
  "requestId": "8f14e45f-ceea-467a-9f2c-9d4c1a5f0f21",
  "method": "POST",
  "path": "/credentials",
  "status": 201,
  "durationMs": 42,
  "ip": "10.0.0.5",
  "userAgent": "curl/8.4.0",
  "contentLength": "128",
  "apiKeyId": "key_01",
  "userTier": "pro",
  "msg": "http request completed"
}
```

### Correlation IDs

An inbound `X-Request-ID` is honoured; otherwise one is generated. The value is
echoed on the response, carried in AsyncLocalStorage, and mixed into every log
line emitted while handling that request — so an application log and its access
record share one id.

### Client IP

`X-Forwarded-For` and `X-Real-IP` are only consulted when `TRUST_PROXY=true`.
Without it the socket address is used, because any client can set those headers
and would otherwise be able to forge the logged IP. Behind a proxy the first
hop in the chain is taken.

### Payloads and redaction

`LOG_PAYLOADS=true` adds the request and response bodies; `LOG_HEADERS=true`
adds the request headers. Both are redacted before they reach the log:

- Headers: `authorization`, `x-api-key`, `cookie`, `set-cookie`,
  `proxy-authorization`, `x-auth-token`
- Body fields at any depth: `password`, `secret`, `token`, `apiKey`,
  `privateKey`, `secretKey`, `seed`, `mnemonic`, `signature`, `credential`, and
  their snake_case and kebab-case spellings

Recursion is depth-bounded, and a body over `LOG_PAYLOAD_MAX_BYTES` is
truncated to a preview plus its real size, so one large upload cannot flood the
log.

### Rotation

Setting `ACCESS_LOG_PATH` additionally writes each record to a file that
rotates at `ACCESS_LOG_MAX_BYTES`, keeping `ACCESS_LOG_MAX_FILES` generations
(`access.log.1` … `access.log.N`) and dropping the rest. Rotation is checked on
write rather than on a timer, so an idle process does not accumulate empty
rotations and a burst cannot overshoot the limit while waiting for a tick.

An endpoint denial is reported as such and does **not** carry the upgrade
prompt, because upgrading a subscription does not raise a per-endpoint limit.
Tier denials keep the existing upgrade payload.

### Whitelisting

`RATE_LIMIT_WHITELIST` accepts exact addresses and IPv4 CIDR ranges
(`10.0.0.5,10.0.0.0/24`). Whitelisted callers skip both budgets and are
answered with `X-RateLimit-Bypass: whitelist`.

Whitelist matching uses the socket address unless `TRUST_PROXY=true`. Without
that, a caller could whitelist itself simply by sending an `X-Forwarded-For`
header.

### Violations and memory

Every denial is logged at `warn` with `type: "rate_limit_violation"`, the rule,
scope, IP, method, path, API key id, and user agent. Expired buckets are
evicted once the map reaches `RATE_LIMIT_MAX_BUCKETS`, so a stream of distinct
client addresses cannot grow it without bound. Eviction runs on write, not on a
timer, so an idle process does no work.
The client is implemented directly against `node:net`/`node:tls` in
`src/redis-client.js`, because this server ships with pino as its only runtime
dependency. It speaks RESP, supports `redis://` and `rediss://` with optional
auth and database selection, and covers GET, SET with TTL, DEL, SCAN, and PING
with connection retry and per-command timeouts.
A file-sink failure is logged and swallowed: it never breaks the response, and
a log file that cannot be opened at startup falls back to stdout-only logging
rather than preventing the server from booting.

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
