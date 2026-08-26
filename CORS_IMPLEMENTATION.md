# CORS Implementation

## Summary

CORS is configured entirely through environment variables so one build serves
local development, staging and production without a code change. The full
reference lives in [server/README.md](server/README.md#cors); this file records
the shape of the implementation.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CORS_ORIGIN` | `*` in development, none in production | A single origin, a comma-separated list, or `*`. |
| `CORS_ALLOWED_ORIGINS` | — | Legacy alias for `CORS_ORIGIN`. `CORS_ORIGIN` wins when both are set. |
| `CORS_CREDENTIALS` | `false` | Send `Access-Control-Allow-Credentials`. Accepts `true/false`, `1/0`, `yes/no`, `on/off`. |
| `CORS_METHODS` | `GET,POST,PUT,PATCH,DELETE,OPTIONS` | Methods advertised on a preflight. |
| `CORS_ALLOWED_HEADERS` | `Content-Type,Authorization,X-API-Key,X-Request-ID,X-Actor,X-User-Tier,X-API-Version` | Request headers a browser may send. |
| `CORS_EXPOSED_HEADERS` | `X-Request-ID,Content-Type,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-API-Version` | Response headers readable by browser JavaScript. |
| `CORS_MAX_AGE` | `86400` | Seconds a browser may cache a preflight. `0` disables caching. |

## Components

### `server/src/config.js`

- `parseCorsOrigins()` reads `CORS_ORIGIN`, falling back to
  `CORS_ALLOWED_ORIGINS`. Accepts one origin, a comma-separated list, or `*`.
  Defaults to `*` in development and to an empty list in production, so a
  production deployment must name its origins rather than inherit a permissive
  default.
- `parseBoolean()` and `parseList()` back `CORS_CREDENTIALS` and the
  method/header lists. An unparseable value falls back to the default instead
  of being silently treated as false or empty.
- `validateConfig()` rejects, at startup:
  - an origin that is not an absolute URL;
  - an origin carrying a path, query or fragment — an `Origin` header never
    has one, so such a value could never match a real request;
  - an unparseable `CORS_CREDENTIALS`;
  - `CORS_CREDENTIALS=true` together with a wildcard origin, which the CORS
    spec forbids and every browser rejects;
  - a non-numeric `CORS_MAX_AGE`.

### `server/src/http-utils.js`

- `getAllowedOrigin()` matches the request origin against the configured list.
  An exact match is required, so `https://app.example.com.evil.com` never
  matches `https://app.example.com`. With a wildcard list and credentials
  enabled it reflects the request's own origin, because `*` and credentials
  cannot be combined.
- `setCorsHeaders()` sets `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Credentials` (only for a specific origin, only when
  enabled) and `Access-Control-Expose-Headers`, and answers a preflight with
  the configured methods, allowed headers and `Access-Control-Max-Age`.
- `Vary: Origin` is set whenever the allowed origin depends on the request, so
  a shared cache cannot serve one origin's response to another.

### `server/src/app.js`

- Calls `setCorsHeaders()` before routing and answers OPTIONS with 204.

### `server/test/cors.test.js`

34 tests covering environment parsing, startup validation, origin matching,
preflight contents, the credentials rules, `Vary`, and the headers observed on
live requests to every route type.

## Examples

```bash
# Development — allows all origins by default
npm start

# Production with two origins
NODE_ENV=production CORS_ORIGIN=https://app.example.com,https://admin.example.com npm start

# Credentialed dashboard
NODE_ENV=production CORS_ORIGIN=https://app.example.com CORS_CREDENTIALS=true npm start

# Read-only public API with a short preflight cache
NODE_ENV=production CORS_ORIGIN=https://app.example.com CORS_METHODS=GET,OPTIONS CORS_MAX_AGE=300 npm start
```
