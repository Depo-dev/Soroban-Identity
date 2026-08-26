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
| `CORS_ORIGIN` | Allowed browser origins. A single origin, a comma-separated list, or `*`. | `*` in development, none in production |
| `CORS_CREDENTIALS` | Whether to send `Access-Control-Allow-Credentials`. Cannot be combined with `CORS_ORIGIN=*`. | `false` |
| `CORS_METHODS` | Comma-separated methods advertised on a preflight. | `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| `CORS_ALLOWED_HEADERS` | Comma-separated request headers a browser may send. | `Content-Type,Authorization,X-API-Key,X-Request-ID,X-Actor,X-User-Tier,X-API-Version` |
| `CORS_EXPOSED_HEADERS` | Comma-separated response headers readable by browser JavaScript. | `X-Request-ID,Content-Type,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-API-Version` |
| `CORS_MAX_AGE` | Seconds a browser may cache a preflight result. `0` disables caching. | `86400` |

## CORS

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
