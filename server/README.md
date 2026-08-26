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
| `ACCESS_LOG_ENABLED` | Emit one structured record per completed request. | `true` |
| `ACCESS_LOG_PATH` | Also write access records to this file, with rotation. Unset means stdout only. | unset |
| `ACCESS_LOG_MAX_BYTES` | Size at which the access log file rotates. | `10485760` |
| `ACCESS_LOG_MAX_FILES` | Rotated files to retain. | `5` |
| `LOG_PAYLOADS` | Include redacted request and response bodies in access records. | `false` |
| `LOG_HEADERS` | Include redacted request headers in access records. | `false` |
| `LOG_PAYLOAD_MAX_BYTES` | Size at which a logged payload is truncated. | `2048` |
| `TRUST_PROXY` | Trust `X-Forwarded-For` / `X-Real-IP` for the client IP. | `false` |

## API Request Logging

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
