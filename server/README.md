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
| `HEALTH_PROBE_TIMEOUT_MS` | Per-dependency timeout for health and readiness probes. | `2000` |
| `REDIS_URL` | Redis connection URL. Unset means the cache dependency reports `disabled`. | unset |

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

| Endpoint | Purpose | Codes |
| --- | --- | --- |
| `GET /health` | Full dependency report with version and uptime | `200` healthy or degraded, `503` unhealthy |
| `GET /ready` | Kubernetes readiness probe | `200` ready, `503` not ready |
| `GET /live` | Kubernetes liveness probe | always `200` while the process responds |

All three skip authentication and rate limiting.

`/health` probes storage, RPC, contracts, and Redis in parallel, each with its
own `HEALTH_PROBE_TIMEOUT_MS` budget, and reports per-dependency status, latency,
and error message:

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "uptimeSeconds": 3742,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "nodeVersion": "v20.11.0",
  "dependencies": {
    "storage":   { "status": "up",       "latencyMs": 2,  "dataDir": "data", "writable": true },
    "rpc":       { "status": "up",       "latencyMs": 41, "rpcStatus": "healthy", "latestLedger": 51234 },
    "contracts": { "status": "degraded", "latencyMs": 88, "reachable": 2, "total": 3 },
    "redis":     { "status": "disabled", "latencyMs": 0,  "reason": "REDIS_URL is not configured" }
  }
}
```

Dependency states are `up`, `degraded`, `down`, and `disabled`. A `disabled`
dependency is one that is not configured, and never counts against overall
health. Overall `status` is `unhealthy` if any dependency is `down`, `degraded`
if any is `degraded`, otherwise `healthy`.

`/health` returns `503` only when the overall status is `unhealthy`, so a
partially degraded deployment is not pulled out of a load balancer.

`/ready` gates on storage and RPC alone — the dependencies required to answer a
request — and names what is failing. Unreachable contracts or a cold cache leave
most endpoints serviceable, so they are reported by `/health` but do not block
readiness. `/live` probes nothing at all, so a dependency outage never causes an
orchestrator to restart an otherwise healthy process.

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
