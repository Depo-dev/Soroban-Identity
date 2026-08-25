# API Versioning Strategy & Deprecation Policy

Soroban Identity implements a flexible API versioning strategy designed for backward compatibility, predictable evolution, and seamless client migration.

---

## 1. Supported Versioning Mechanisms

The API supports three complementary version negotiation methods:

### A. URL Path Prefix (Recommended)
Prepend the version identifier directly in the route path:
```http
GET /v1/credentials
GET /v2/credentials
POST /v1/webhooks
GET /v1/graphql
```

### B. Accept-Version Header
Specify the version in a dedicated HTTP header:
```http
GET /credentials HTTP/1.1
Host: api.soroban-identity.example
Accept-Version: v2
```

### C. Vendor Accept MIME Type
Negotiate version via the standard `Accept` header:
```http
GET /credentials HTTP/1.1
Host: api.soroban-identity.example
Accept: application/vnd.soroban-identity.v2+json
```

### D. Default Fallback (Backward Compatibility)
Requests to unversioned endpoints (e.g. `/credentials`, `/health`, `/info`) default to **`v1`** without breaking legacy integrations.

---

## 2. Supported Versions

| Version | Status | Release Date | Deprecation Date | Sunset Date |
| :--- | :--- | :--- | :--- | :--- |
| **`v1`** | `Active` (Default) | 2024-01-01 | — | — |
| **`v2`** | `Active` | 2024-06-01 | — | — |

---

## 3. Version Differences (v1 vs v2)

### Credential Listing (`GET /credentials` or `GET /v2/credentials`)

- **v1 Response:**
  ```json
  {
    "items": [...],
    "nextCursor": "cred-xyz"
  }
  ```

- **v2 Response:**
  ```json
  {
    "apiVersion": "v2",
    "data": {
      "items": [...],
      "pageInfo": {
        "nextCursor": "cred-xyz",
        "hasNextPage": true,
        "count": 50
      }
    },
    "meta": {
      "timestamp": "2026-08-25T11:00:00.000Z"
    }
  }
  ```

### Health Check Endpoint (`GET /health` or `GET /v1/health` or `GET /v2/health`)

All health responses include versioning metadata:
```json
{
  "status": "ok",
  "apiVersion": "v1",
  "supportedVersions": ["v1", "v2"],
  "deprecatedVersions": [],
  "defaultVersion": "v1",
  "contracts": {
    "identity": true,
    "credential": true,
    "reputation": true
  },
  "circuitBreaker": {
    "state": "CLOSED"
  }
}
```

---

## 4. Deprecation & Sunset Policy

To provide stability for enterprise integrators, the API follows a strict deprecation timeline:

1. **Announcement & Grace Period:**
   - Any version scheduled for deprecation will remain fully operational for at least **6 months** prior to sunset.
2. **Deprecation Headers:**
   - When a client invokes a deprecated version or endpoint, the response includes standard HTTP deprecation headers:
     - `Deprecation: true`
     - `Sunset: <RFC-3339 timestamp>` (date of removal)
     - `Link: <documentation URL>; rel="deprecation"`
     - `X-API-Version: <version>`
3. **Sunset / Retirement:**
   - Following the sunset date, requests to retired versions will return `HTTP 410 Gone` with migration guidelines.
