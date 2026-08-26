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
