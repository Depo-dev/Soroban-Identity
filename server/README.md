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

## Metrics

The server exposes a Prometheus-compatible scrape endpoint at `GET /metrics`,
rendered by [prom-client](https://github.com/siimon/prom-client). The endpoint
is exempt from rate limiting and from request-id assignment so a scraper does
not consume a caller's quota.

```bash
curl http://localhost:3001/metrics
```

Each `MetricsService` owns a private registry, so metrics never leak between
instances (which matters for tests). Sample scrape config:

```yaml
scrape_configs:
  - job_name: soroban-identity
    static_configs:
      - targets: ['localhost:3001']
```

### HTTP metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status_code` | Requests handled. |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Request latency. Buckets: 5ms - 10s. |
| `http_requests_in_flight` | gauge | — | Requests currently being processed. |

`route` is the matched route *pattern*, never the raw path: `/credentials/abc`
is labelled `/credentials/:id`. Unrecognised paths collapse to `unmatched`, so
a scanner probing random URLs cannot inflate series cardinality.

### Business metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `dids_created_total` | counter | — | DIDs created, from on-chain events. |
| `credentials_issued_total` | counter | — | Credentials issued, from on-chain events. |
| `credentials_revoked_total` | counter | — | Credentials revoked, from on-chain events. |
| `reputation_scores_submitted_total` | counter | — | Reputation scores submitted. |
| `credentials_verified_total` | counter | `result` | Verification attempts. `result` is `verified`, `revoked`, `expired` or `not_found`. |
| `active_dids` | gauge | — | Distinct DIDs holding at least one active credential. |
| `active_credentials` | gauge | `type` | Active credentials per credential type. |
| `credential_types` | gauge | — | Distinct credential types in the store. |

A credential counts as active when it is not revoked and either has no expiry
(`expiresAt` of `0`) or expires in the future. The gauges are recomputed at
scrape time from the credential store, so they reflect current state rather
than the state at the last write.

### RPC metrics

| Metric | Type | Meaning |
| --- | --- | --- |
| `soroban_rpc_call_latency_seconds` | histogram | Soroban RPC call latency. Buckets: 50ms - 10s. |
| `rpc_cache_hits_total` | counter | RPC cache hits. |
| `rpc_cache_misses_total` | counter | RPC cache misses. |
| `rpc_retries_total` | counter | RPC call retries. |

### Node.js runtime metrics

`prom-client`'s default collectors are registered, so the scrape also carries
process and runtime series: `process_cpu_user_seconds_total`,
`process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`,
`nodejs_eventloop_lag_seconds`, `nodejs_active_handles`, GC durations and
version info.

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
