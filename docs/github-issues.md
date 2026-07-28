# GitHub Issues — Soroban Identity (40 Issues)

Categories: Bug · Fix · API · Proxy/Server · Smart Contract
Each issue includes: Scope, Guidelines, and Definition of Done (DoD).

---

## SMART CONTRACT ISSUES (10)

---

### [SC-01] Bug: `MetadataTooLarge` error returned when service endpoint cap is exceeded
**Labels:** `bug` `smart-contract` `identity-registry`

**Scope**
`contracts/identity-registry/src/lib.rs` — `add_service()` returns `MetadataTooLarge` (error code 9) when the 10-service cap is hit, which is semantically incorrect.

**Guidelines**
- The cap is `MAX_SERVICES = 10` per DID document.
- Introduce a new `ContractError::MaxServicesReached` variant with a distinct code.
- Update the `add_service` guard to use the new error.
- Keep existing `MetadataTooLarge` for byte-size violations only.

**DoD**
- [ ] New `MaxServicesReached` error variant added to `ContractError`.
- [ ] `add_service` returns `MaxServicesReached` (not `MetadataTooLarge`) when cap hit.
- [ ] Existing tests pass; new test confirms the correct error variant.
- [ ] `shared-errors` updated if the variant is shared.

---

### [SC-02] Bug: Credential issuance panics when subject has no active DID
**Labels:** `bug` `smart-contract` `credential-manager`

**Scope**
`contracts/credential-manager/src/lib.rs` — Cross-contract call to `identity-registry` to verify subject DID panics with an opaque error instead of a typed `ContractError`.

**Guidelines**
- Wrap the cross-contract `has_active_did` call in proper error handling.
- Return `ContractError::Unauthorized` (or a new `SubjectHasNoDid` variant) with a clear message.
- Do not let the panic bubble up as an unhandled host error.

**DoD**
- [ ] Cross-contract call wrapped with error propagation.
- [ ] Clear typed error returned when subject lacks an active DID.
- [ ] Integration test: issuing to a subject with no DID returns the typed error (not a panic).

---

### [SC-03] Bug: Dispute expiry check missing in `resolve_dispute` path
**Labels:** `bug` `smart-contract` `reputation`

**Scope**
`contracts/reputation/src/lib.rs` — `resolve_dispute` checks `DisputeExpired` but doesn't validate whether the underlying score entry's ledger is still within bounds, allowing stale resolves.

**Guidelines**
- Confirm the current ledger sequence against `DISPUTE_WINDOW_LEDGERS = 17_280` at resolution time.
- Return `DisputeExpired` if the window has passed.
- Ensure `dispute_score` stores the opening ledger for comparison.

**DoD**
- [ ] `resolve_dispute` correctly rejects disputes opened outside the window.
- [ ] Test: dispute opened, ledger advanced past window, resolve attempt returns `DisputeExpired`.
- [ ] No regression on in-window resolutions.

---

### [SC-04] Bug: Issuer credential ring-buffer silently drops oldest entries
**Labels:** `bug` `smart-contract` `credential-manager`

**Scope**
`contracts/credential-manager/src/lib.rs` — The `MAX_ISSUER_CREDS = 10_000` ring-buffer evicts without any contract event or recoverable signal.

**Guidelines**
- Emit a contract event `{ topic: "issuer_creds_evicted", data: { issuer, evicted_id } }` before eviction.
- Document the ring-buffer semantics in `contracts/credential-manager/README.md`.
- Ensure the eviction event is parseable by the event schema in `docs/contract-events.md`.

**DoD**
- [ ] Eviction emits a typed event matching the schema in `docs/contract-events.md`.
- [ ] README updated with ring-buffer behaviour.
- [ ] Test confirms event is emitted on cap overflow.

---

### [SC-05] Fix: `deactivate_did` should emit a contract event
**Labels:** `fix` `smart-contract` `identity-registry`

**Scope**
`contracts/identity-registry/src/lib.rs` — DID deactivation is silent on-chain; no event is emitted for downstream consumers.

**Guidelines**
- Emit `{ topic: "did_deactivated", data: { controller, ledger } }` after state write.
- Follow existing event format in `docs/contract-events.md`.
- Add the event definition to the docs.

**DoD**
- [ ] Event emitted on every successful `deactivate_did` call.
- [ ] Event documented in `docs/contract-events.md`.
- [ ] Test confirms event presence after deactivation.

---

### [SC-06] Fix: Hard issuer cap (`MAX_ISSUERS = 100`) lacks admin override path
**Labels:** `fix` `smart-contract` `credential-manager`

**Scope**
`contracts/credential-manager/src/lib.rs` — `add_issuer` returns `MaxIssuersReached` with no escape path. A governance mechanism is needed.

**Guidelines**
- Add a new admin-only `set_max_issuers(admin, new_max)` function.
- Apply the same admin two-phase commit pattern used elsewhere in the contract.
- Enforce a hard ceiling (e.g. `ABSOLUTE_MAX_ISSUERS = 500`) on `new_max`.
- Emit an `admin_config_changed` event.

**DoD**
- [ ] `set_max_issuers` function implemented and admin-gated.
- [ ] Hard ceiling applied.
- [ ] Event emitted on change.
- [ ] Tests: normal admin raises cap; non-admin rejected; ceiling enforced.

---

### [SC-07] Fix: Score floor at 0 uses saturating sub but negative delta should be validated
**Labels:** `fix` `smart-contract` `reputation`

**Scope**
`contracts/reputation/src/lib.rs` — `submit_score` accepts any `delta` (including very large negative values). Saturating subtraction masks overflow but the reporter's intent (large negative) should be validated.

**Guidelines**
- Define a `MAX_DELTA: i64` and `MIN_DELTA: i64` constant (e.g. ±1000).
- Return a new `InvalidDelta` error if outside bounds.
- Document accepted delta range in README and API docs.

**DoD**
- [ ] Delta range constants defined and enforced.
- [ ] `InvalidDelta` error variant added.
- [ ] Tests: boundary values accepted, out-of-bound values rejected.
- [ ] OpenAPI spec updated with delta constraints.

---

### [SC-08] Fix: `register_schema` should validate non-empty hash
**Labels:** `fix` `smart-contract` `credential-manager`

**Scope**
`contracts/credential-manager/src/lib.rs` — `register_schema` accepts a zero-length `schema_hash` bytes value, which allows credentials to reference a vacuous schema.

**Guidelines**
- Validate that `schema_hash.len() > 0` (ideally == 32 bytes for SHA-256).
- Return a new `InvalidSchemaHash` error on failure.
- Update `types.rs` if the type needs a minimum length constraint.

**DoD**
- [ ] Validation added with correct error.
- [ ] Test: zero-length hash rejected, 32-byte hash accepted.
- [ ] Error documented in `shared-errors` if cross-contract.

---

### [SC-09] Fix: Reputation rate-limit window should be configurable by admin
**Labels:** `fix` `smart-contract` `reputation`

**Scope**
`contracts/reputation/src/lib.rs` — `MIN_INTERVAL = 100` ledgers is a compile-time constant. Different deployments may need different cooldowns.

**Guidelines**
- Store `min_interval` in contract persistent storage, settable by admin.
- Add `set_min_interval(admin, ledgers)` with sensible floor (e.g. 10) and ceiling (e.g. 50_000).
- Initialise with current default `100` on `initialize`.

**DoD**
- [ ] `set_min_interval` function implemented, admin-gated.
- [ ] Floor and ceiling enforced.
- [ ] Tests: default used on init, admin can change, floor/ceiling respected.

---

### [SC-10] Fix: Lifecycle integration test only covers happy path
**Labels:** `fix` `smart-contract` `testing`

**Scope**
`contracts/tests/lifecycle.rs` — No negative-path coverage: revoked credentials, deactivated DIDs, unauthorized callers, or cross-contract error propagation.

**Guidelines**
- Add test cases for each `ContractError` variant across all three contracts.
- Cover: issue to deactivated DID, verify revoked credential, sybil check below threshold, dispute after expiry.
- Keep tests deterministic (fixed ledger sequences).

**DoD**
- [ ] At least 15 negative-path test cases added.
- [ ] Each `ContractError` variant tested at least once.
- [ ] All tests pass with `cargo test`.


---

## API ISSUES (10)

---

### [API-01] Bug: Scope validation inconsistent across admin endpoints
**Labels:** `bug` `api` `security`

**Scope**
`server/src/app.js` — Some `/admin/*` routes check both the admin key and a scope; others only check the admin key. This creates inconsistent access control.

**Guidelines**
- Audit every `/admin/*` route for scope enforcement.
- All read admin routes must require `admin:read` scope; write routes require `admin:write`.
- Centralise scope checking in `requireAuth()` in `http-utils.js`.
- Return `403` with `{ error: { code: "INSUFFICIENT_SCOPE" } }` on mismatch.

**DoD**
- [ ] All admin routes consistently enforce scope.
- [ ] `requireAuth` accepts an optional `scope` parameter and validates it.
- [ ] Test: each endpoint returns `403` when called with wrong scope.
- [ ] No regression on existing auth tests.

---

### [API-02] Bug: `X-Request-ID` not propagated to all structured log entries
**Labels:** `bug` `api` `observability`

**Scope**
`server/src/logger.js` + `server/src/request-context.js` — Request ID is set via `AsyncLocalStorage` but not pulled into every log call inside background jobs and storage operations.

**Guidelines**
- Extend `logger.js` to auto-read `requestId` from `requestContextStore` and include it in every log entry.
- Ensure background expiry job logs use a synthetic `requestId` (e.g. `expiry-job-<timestamp>`).
- Verify `X-Request-ID` appears in error logs, not just access logs.

**DoD**
- [ ] Every structured log line includes `requestId`.
- [ ] Background job logs use a traceable synthetic ID.
- [ ] Test: log output captured in test; assert `requestId` present in all entries.

---

### [API-03] Bug: Expiry notification webhook has no retry on delivery failure
**Labels:** `bug` `api` `reliability`

**Scope**
`server/src/expiry.js` — Webhook POST fires once; on 5xx or network error the notification is silently lost.

**Guidelines**
- Implement exponential backoff retry (max 3 attempts, base delay 1s, factor 2).
- Log each failed attempt with status code and attempt number.
- After exhausting retries, emit a `webhook_delivery_failed` metric counter.
- Do not block the expiry job loop; use non-blocking retry scheduling.

**DoD**
- [ ] Retry logic implemented with configurable `MAX_WEBHOOK_RETRIES` env var (default 3).
- [ ] Failed deliveries logged and counted in metrics.
- [ ] Test: mock webhook endpoint returns 503 twice then 200; assert 3 attempts made.

---

### [API-04] Bug: `/credentials` cursor pagination accepts out-of-range `limit`
**Labels:** `bug` `api` `validation`

**Scope**
`server/src/app.js` — The `limit` query param for `GET /credentials` is not validated against the documented max of 200, allowing arbitrarily large queries.

**Guidelines**
- Validate `limit` in the request handler: must be a positive integer ≤ 200.
- Return `400` with `{ error: { code: "INVALID_INPUT", message: "limit must be 1–200" } }` on violation.
- Apply the same validation to any other paginated endpoint (`/admin/expiry-report`).

**DoD**
- [ ] `limit` validated on all paginated routes.
- [ ] `400` returned for `limit=0`, `limit=-1`, `limit=201`, `limit=abc`.
- [ ] Tests cover boundary values.

---

### [API-05] Fix: Storage adapter missing runtime interface validation
**Labels:** `fix` `api` `reliability`

**Scope**
`server/src/storage.js` — Custom `STORAGE_ADAPTER` is loaded dynamically but never validated for the required `{ read, write, delete, list }` interface at startup.

**Guidelines**
- On server startup, assert that the loaded adapter exports all four methods.
- Throw a descriptive startup error if any method is missing (fail fast, not at request time).
- Add a `validateStorageAdapter(adapter)` helper in `storage.js`.

**DoD**
- [ ] Validation runs at startup before the HTTP server binds.
- [ ] Missing method produces a clear error message naming the missing method.
- [ ] Test: adapter missing `delete` causes startup failure with informative message.

---

### [API-06] Fix: Audit log rotation does not clean up logs older than retention window
**Labels:** `fix` `api` `operations`

**Scope**
`server/src/storage.js` — `AUDIT_LOG_RETENTION_DAYS` is read from config but the cleanup job that deletes old `audit-YYYY-MM-DD.ndjson` files is not implemented.

**Guidelines**
- Implement `pruneAuditLogs(retentionDays)` that deletes files older than `retentionDays`.
- Run it once at startup and then on a daily interval.
- Log deleted file names at `info` level.

**DoD**
- [ ] `pruneAuditLogs` implemented and called at startup + daily.
- [ ] Test: create synthetic old log files; confirm they are removed after prune.
- [ ] Retention uses `AUDIT_LOG_RETENTION_DAYS` env var (default 30).

---

### [API-07] Fix: Circuit breaker state changes not exported to Prometheus metrics
**Labels:** `fix` `api` `observability`

**Scope**
`server/src/circuit-breaker.js` + `server/src/metrics.js` — The circuit breaker transitions (closed → open → half-open) are not tracked as metrics counters.

**Guidelines**
- Add `circuit_breaker_opened_total` and `circuit_breaker_closed_total` Prometheus counters.
- Increment them on each state transition inside `circuit-breaker.js`.
- Label counters with `contract` (identity_registry, credential_manager, reputation).

**DoD**
- [ ] Two new counters added and registered in `metrics.js`.
- [ ] Counters incremented on each transition.
- [ ] `/metrics` output includes both counters after a simulated trip.

---

### [API-08] Fix: `GET /health` returns 200 when circuit breaker is open
**Labels:** `fix` `api` `reliability`

**Scope**
`server/src/app.js` — Health check calls `soroban.pingAllContracts()` which may return cached/stale results when the circuit breaker is open, masking real degradation.

**Guidelines**
- Include circuit breaker state per contract in the health response body.
- If any circuit is open, force the response status to `503` regardless of ping result.
- Add `circuitState: "open" | "closed" | "half-open"` per contract in the response JSON.

**DoD**
- [ ] Health response includes `circuitState` per contract.
- [ ] Open circuit forces `503`.
- [ ] Test: trip circuit breaker, call `/health`, assert `503` and `circuitState: "open"`.

---

### [API-09] Fix: `POST /admin/issuers` does not validate Stellar address format
**Labels:** `fix` `api` `validation`

**Scope**
`server/src/app.js` — The issuer address from the request body is passed directly to the Soroban contract without validating that it is a valid bech32 Stellar `G...` address.

**Guidelines**
- Validate the address with `StrKey.isValidEd25519PublicKey` (from `@stellar/stellar-sdk`) before invoking the contract.
- Return `400` with `{ error: { code: "INVALID_INPUT", message: "Invalid Stellar address" } }` on failure.
- Apply the same validation to `DELETE /admin/issuers`.

**DoD**
- [ ] Stellar address validated before contract call on both add/remove routes.
- [ ] `400` returned for invalid addresses.
- [ ] Tests: valid address passes, invalid string returns `400`.

---

### [API-10] Fix: Server lacks graceful shutdown — in-flight requests dropped on SIGTERM
**Labels:** `fix` `api` `reliability`

**Scope**
`server/src/index.js` — No `SIGTERM` / `SIGINT` handler; the process exits immediately, dropping active connections and background jobs.

**Guidelines**
- Register `process.on('SIGTERM')` and `process.on('SIGINT')` handlers.
- Stop accepting new connections, wait up to 10s for in-flight requests to complete.
- Cancel the expiry job interval before exit.
- Log `{ event: "shutdown", reason }` at `info` level.

**DoD**
- [ ] Graceful shutdown implemented with configurable `SHUTDOWN_TIMEOUT_MS` (default 10000).
- [ ] Expiry job interval cleared on shutdown.
- [ ] Test: send SIGTERM while a request is in flight; assert response completes before exit.

---

## PROXY / SERVER ISSUES (10)

---

### [PRX-01] Bug: CORS preflight response missing `Access-Control-Max-Age` header
**Labels:** `bug` `proxy` `cors`

**Scope**
`server/src/http-utils.js` — `setCorsHeaders` handles OPTIONS preflight but does not set `Access-Control-Max-Age`, causing browsers to re-send preflight on every request.

**Guidelines**
- Add `Access-Control-Max-Age: 86400` (24h) to all `204` preflight responses.
- Make the value configurable via `CORS_MAX_AGE` env var.
- Update `server/src/cors.test.js` to assert the header is present.

**DoD**
- [ ] `Access-Control-Max-Age` header present on all `204` OPTIONS responses.
- [ ] Configurable via env var with default of `86400`.
- [ ] Existing CORS tests updated; new test asserts header value.

---

### [PRX-02] Bug: RPC cache does not invalidate on contract state mutation
**Labels:** `bug` `proxy` `caching`

**Scope**
`server/src/rpc-cache.js` — Read results are cached but the cache is never invalidated when a write (issuer add/remove, credential issue/revoke) succeeds, returning stale data.

**Guidelines**
- Expose a `cache.invalidate(key)` and `cache.invalidatePrefix(prefix)` method.
- Call `invalidatePrefix('issuers')` after successful `add_issuer` / `remove_issuer`.
- Call `invalidate('credential:<id>')` after successful credential revocation.
- Document cache TTL strategy in `docs/server-operations.md`.

**DoD**
- [ ] `invalidate` and `invalidatePrefix` implemented on the cache.
- [ ] Mutation routes clear relevant cache entries.
- [ ] Test: cache populated → mutation → subsequent read hits source (not cache).

---

### [PRX-03] Bug: Soroban worker thread errors not surfaced to main thread response
**Labels:** `bug` `proxy` `reliability`

**Scope**
`server/src/soroban-worker.js` — Unhandled rejections inside the worker thread are swallowed; the main thread times out with no error detail.

**Guidelines**
- Add `process.on('unhandledRejection')` inside the worker to post structured error back via `parentPort`.
- Main thread must reject the pending promise with the received error payload.
- Ensure `requestId` is included in the error message posted back.

**DoD**
- [ ] Worker unhandled rejections forwarded to main thread.
- [ ] Main thread propagates the error to the HTTP response as `500`.
- [ ] Test: inject a rejection in the worker; assert `500` with error detail returned.

---

### [PRX-04] Bug: `soroban.js` retries on all errors, including client errors (4xx-equivalent)
**Labels:** `bug` `proxy` `reliability`

**Scope**
`server/src/soroban.js` — The Soroban RPC wrapper retries all failed simulations including contract errors (`INVOKE_HOST_FUNCTION_FAILED`) that will never succeed on retry.

**Guidelines**
- Distinguish retriable errors (transport, 503, timeout) from non-retriable (contract-level `ContractError`, auth failures).
- Only retry on retriable errors; return immediately on non-retriable.
- Log a `warn` with `{ retrying: false, reason }` on non-retriable skip.

**DoD**
- [ ] Non-retriable errors skip the retry loop and return immediately.
- [ ] `ContractError` codes correctly classified as non-retriable.
- [ ] Test: contract returns `CredentialNotFound`; assert no retry, fast failure.

---

### [PRX-05] Bug: Metrics endpoint (`/metrics`) leaks internal error details in plain text
**Labels:** `bug` `proxy` `security`

**Scope**
`server/src/app.js` — If metrics collection throws, the raw error stack is returned in the `text/plain` metrics response body, potentially exposing internal paths.

**Guidelines**
- Wrap the metrics serialization in a try/catch.
- On error, return `500` with a generic `# metrics unavailable` text body.
- Log the actual error internally at `error` level with full stack.

**DoD**
- [ ] Metrics endpoint never exposes stack traces externally.
- [ ] `500` + generic body returned on collection failure.
- [ ] Test: simulate metrics error; assert no stack in response body.

---

### [PRX-06] Fix: Add request rate limiting middleware to the server layer
**Labels:** `fix` `proxy` `security`

**Scope**
`server/src/app.js` — The server has no HTTP-level rate limiting. Contract-level rate limiting (100 ledgers) is insufficient for API abuse protection.

**Guidelines**
- Implement a token-bucket rate limiter in `server/src/rate-limit.js`.
- Default: 60 req/min per IP for read endpoints, 20 req/min for write endpoints.
- Return `429` with `Retry-After` header and `{ error: { code: "RATE_LIMITED" } }` body.
- Make limits configurable via `RATE_LIMIT_READ` and `RATE_LIMIT_WRITE` env vars.

**DoD**
- [ ] Rate limiter middleware implemented and applied in `app.js`.
- [ ] `429` returned with `Retry-After` when limit exceeded.
- [ ] `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers on every response.
- [ ] Tests: exceed limit, assert `429`; within limit, assert `200`.

---

### [PRX-07] Fix: SSE `/events` endpoint has no heartbeat — connections silently die
**Labels:** `fix` `proxy` `reliability`

**Scope**
`server/src/app.js` (SSE handler) — Long-lived SSE connections time out via proxy/load-balancer without a keepalive signal.

**Guidelines**
- Send a `comment` (`: heartbeat\n\n`) SSE keepalive every 30s.
- Make the interval configurable via `SSE_HEARTBEAT_MS` env var (default 30000).
- Clear the interval on client disconnect (`res.on('close')`).

**DoD**
- [ ] Heartbeat comments sent at configured interval.
- [ ] Interval cleared cleanly on disconnect.
- [ ] Test: connect to SSE; advance fake timers 30s; assert heartbeat comment received.

---

### [PRX-08] Fix: `soroban.js` does not honour `STELLAR_RPC_URL` rotation on failure
**Labels:** `fix` `proxy` `reliability`

**Scope**
`server/src/soroban.js` — The RPC URL is a single static string from config. If the primary RPC endpoint is degraded, there is no fallback.

**Guidelines**
- Support `STELLAR_RPC_URLS` as a comma-separated list of RPC endpoints.
- On failure, rotate to the next URL in round-robin fashion.
- After a full rotation with all failures, throw and trip the circuit breaker.
- Log which URL is currently active at `debug` level.

**DoD**
- [ ] Multi-URL support implemented with round-robin rotation.
- [ ] Circuit breaker tripped only after all URLs fail.
- [ ] Test: first URL fails, second URL succeeds; assert request completes.

---

### [PRX-09] Fix: No structured logging for inbound request body size
**Labels:** `fix` `proxy` `observability`

**Scope**
`server/src/app.js` + `server/src/body-size-limit.js` — When a `413` is returned for oversized bodies, the actual received content-length is not logged, making abuse detection difficult.

**Guidelines**
- Log `{ event: "body_too_large", contentLength, limit, path, requestId }` at `warn` level before returning `413`.
- Add a Prometheus counter `http_request_body_too_large_total` labelled by `path`.

**DoD**
- [ ] Warn log emitted with size and path on every `413`.
- [ ] Prometheus counter incremented.
- [ ] Test: send oversized body; assert log entry and counter value.

---

### [PRX-10] Fix: DID resolution endpoint (`GET /1.0/identifiers/:did`) missing input sanitisation
**Labels:** `fix` `proxy` `security`

**Scope**
`server/src/app.js` — The `did` path parameter is passed directly to the Soroban simulation without validating the `did:stellar:<address>` format, enabling malformed inputs to reach the contract layer.

**Guidelines**
- Validate format with a regex: `^did:stellar:[A-Z2-7]{56}$`.
- Return `400` with `{ error: { code: "INVALID_INPUT", message: "Invalid DID format" } }` on mismatch.
- Strip any URL-encoded characters before validation.

**DoD**
- [ ] DID format validated before contract call.
- [ ] `400` on malformed DID.
- [ ] Tests: valid DID passes, malformed string returns `400`, URL-encoded input sanitised.

---

## FRONTEND ISSUES (10)

---

### [FE-01] Bug: Credentials panel returns empty array instead of fetching from contract
**Labels:** `bug` `frontend` `sdk`

**Scope**
`frontend/src/App.tsx` — TODO comment references issue #226: `CredentialClient.getCredentialsBySubject()` is not yet wired up; the panel shows no credentials.

**Guidelines**
- Replace the mock empty array with a call to `CredentialClient.list_subject_credentials(subject, cursor, limit)`.
- Handle loading, empty, and error states.
- Use the existing `SkeletonCard` for the loading state.
- Paginate: load first 20, add "Load more" button.

**DoD**
- [ ] Credentials fetched from contract via SDK on wallet connect.
- [ ] Loading skeleton shown during fetch.
- [ ] Empty state message shown when no credentials found.
- [ ] Pagination "Load more" works correctly.
- [ ] TODO comment removed.

---

### [FE-02] Bug: Metadata editor allows duplicate keys without client-side validation
**Labels:** `bug` `frontend` `ux`

**Scope**
`frontend/src/components/IdentityPanel.tsx` — The metadata key/value editor does not validate for duplicate keys before submitting, causing the transaction to fail on-chain.

**Guidelines**
- On every key change, check for duplicates across all `metadataEntries`.
- Show an inline field-level error: `"Duplicate key"` below the offending input.
- Disable the submit button while any field-level error exists.
- Limit key length to 64 chars and value length to 256 chars with live counters.

**DoD**
- [ ] Duplicate key error shown inline, submit blocked.
- [ ] Key max 64 chars, value max 256 chars enforced with character counters.
- [ ] No on-chain call made when validation fails.
- [ ] Existing tests updated; new test covers duplicate key scenario.

---

### [FE-03] Bug: Freighter wallet detection has no retry when extension not yet loaded
**Labels:** `bug` `frontend` `wallet`

**Scope**
`frontend/src/hooks/useWalletConnection.ts` — Freighter availability is checked once on mount. If the extension loads slowly, the UI permanently shows "Freighter not installed".

**Guidelines**
- Poll for Freighter availability up to 3 times with 500ms intervals on initial load.
- Show a spinner during detection; only show the "not installed" message after all retries exhausted.
- Expose a `retryDetection()` function callable from the UI.

**DoD**
- [ ] Retry logic implemented (3 attempts, 500ms apart).
- [ ] Spinner shown during detection phase.
- [ ] `retryDetection` callable from `WalletButton`.
- [ ] Tests updated for async detection flow.

---

### [FE-04] Bug: Address history not cleared from localStorage on wallet disconnect
**Labels:** `bug` `frontend` `state`

**Scope**
`frontend/src/hooks/useAddressHistory.ts` — `clearHistory()` removes in-memory state but does not clear the `localStorage` key, so history reappears on page reload.

**Guidelines**
- `clearHistory` must call `localStorage.removeItem(HISTORY_KEY)` in addition to resetting state.
- Add a `useEffect` that re-hydrates from `localStorage` only when a wallet is connected.

**DoD**
- [ ] `clearHistory` clears both memory and `localStorage`.
- [ ] Re-hydration only on connected wallet.
- [ ] Test: clear history, reload page, assert empty history.

---

### [FE-05] Bug: Anti-Sybil check form submits with non-numeric `minScore` / `minReporters`
**Labels:** `bug` `frontend` `validation`

**Scope**
`frontend/src/components/IdentityPanel.tsx` — `minScore` and `minReporters` are stored as strings; no validation prevents submitting `"abc"` which causes a runtime error in the SDK call.

**Guidelines**
- Validate both fields as positive integers before submission.
- Show field-level error messages for invalid values.
- Disable the check button while either field is invalid.
- Clamp `minScore` to 0–10000 and `minReporters` to 1–100.

**DoD**
- [ ] Validation implemented for both fields.
- [ ] Button disabled on invalid state.
- [ ] Error messages shown inline.
- [ ] Tests cover invalid input cases.

---

### [FE-06] Fix: QR code displayed inline with no export or size control
**Labels:** `fix` `frontend` `ux`

**Scope**
`frontend/src/components/IdentityPanel.tsx` — The `QRCodeSVG` component renders inline at a fixed small size with no option to download or resize.

**Guidelines**
- Add a "Download QR" button that exports the SVG as a PNG via `canvas` or a data URL.
- Allow the user to toggle between small (128px) and large (256px) size.
- Ensure the downloaded file is named `did-<truncated-address>.png`.

**DoD**
- [ ] Download QR button implemented and functional.
- [ ] Size toggle (small/large) available.
- [ ] Downloaded file named correctly.
- [ ] Accessible: button has `aria-label`.

---

### [FE-07] Fix: No UI warning when DID service endpoint limit (10) is about to be reached
**Labels:** `fix` `frontend` `ux`

**Scope**
`frontend/src/components/IdentityPanel.tsx` — The contract enforces a 10-service limit per DID. The UI does not show how many slots are used or warn when the cap is near.

**Guidelines**
- Display `Services: X / 10` counter in the services section.
- Show a warning banner when count ≥ 8.
- Disable the "Add Service" button when count = 10.

**DoD**
- [ ] Usage counter displayed.
- [ ] Warning at ≥ 8 services.
- [ ] Add button disabled at 10.
- [ ] Tests cover each threshold state.

---

### [FE-08] Fix: Contract event listener (`useContractEvents`) has no reconnect on drop
**Labels:** `fix` `frontend` `reliability`

**Scope**
`frontend/src/hooks/useContractEvents.ts` — The SSE / polling connection to contract events does not reconnect if the server drops the connection or the network is temporarily unavailable.

**Guidelines**
- Implement exponential backoff reconnection (max 5 attempts, base 1s).
- Show a dismissible "Reconnecting…" toast while retrying.
- Reset backoff counter on successful reconnect.
- Emit `events_reconnected` metric if the metrics hook is available.

**DoD**
- [ ] Reconnection logic implemented with backoff.
- [ ] Toast shown during reconnect attempts.
- [ ] Test: simulate disconnect; assert reconnection attempt made.

---

### [FE-09] Fix: Dark/light theme preference not persisted to `localStorage`
**Labels:** `fix` `frontend` `ux`

**Scope**
`frontend/src/hooks/useTheme.ts` — Theme selection is held in memory only; refreshing the page resets to system default.

**Guidelines**
- Persist selected theme to `localStorage` under key `si-theme`.
- On mount, read from `localStorage` before falling back to system preference.
- Sync to `document.documentElement` class on every change.

**DoD**
- [ ] Theme persisted to `localStorage`.
- [ ] Preference restored on page load.
- [ ] `useTheme` tests updated to cover persistence.

---

### [FE-10] Fix: Missing i18n keys cause silent render of raw key strings
**Labels:** `fix` `frontend` `i18n`

**Scope**
`frontend/src/locales/` + `frontend/scripts/validate-locales.js` — The locale validation script exists but is not run in CI, allowing missing keys in `es.json` to ship silently.

**Guidelines**
- Add `npm run validate-locales` as a step in the CI workflow (`.github/workflows/`).
- Update `validate-locales.js` to exit with code `1` on any missing key.
- Add all keys present in `en.json` but absent from `es.json`.

**DoD**
- [ ] CI workflow runs locale validation on every PR.
- [ ] `validate-locales.js` exits `1` on missing keys.
- [ ] All missing `es.json` keys backfilled (can be English placeholder with `// TODO: translate`).
- [ ] Test: remove a key from `es.json`; assert script exits `1`.

---

## BUG / CROSS-CUTTING ISSUES (10)

---

### [BUG-01] Bug: SDK `classifyError` regex is brittle against contract error message format changes
**Labels:** `bug` `sdk` `reliability`

**Scope**
`sdk/src/errors.ts` — `classifyError(msg)` uses regex on raw error strings. Any format change in the Soroban host error messages silently breaks classification, returning `UNKNOWN`.

**Guidelines**
- Replace regex-based classification with numeric error code extraction from the Soroban `ContractError` value.
- Map numeric codes (e.g. `3` → `NOT_FOUND`) per-contract using exported constant maps.
- Keep regex as a final fallback with a `warn` log when used.

**DoD**
- [ ] Numeric code extraction implemented for all three contracts.
- [ ] Constant maps exported and tested.
- [ ] Regex fallback retained with warning.
- [ ] Tests: known codes map correctly; unknown code falls through to regex.

---

### [BUG-02] Bug: `wrapError` does not preserve original error stack in production
**Labels:** `bug` `sdk` `observability`

**Scope**
`sdk/src/errors.ts` — `wrapError` creates a new `SorobanIdentityError` but does not chain the original error's stack via `Error.cause`.

**Guidelines**
- Pass the original error as `{ cause: originalError }` in the `SorobanIdentityError` constructor.
- Ensure `SorobanIdentityError` extends `Error` with `cause` support.
- Verify stack traces are inspectable in Node 16+ and modern browsers.

**DoD**
- [ ] `Error.cause` set on all wrapped errors.
- [ ] Original stack accessible via `err.cause.stack`.
- [ ] Test: wrap an error; assert `cause` is the original.

---

### [BUG-03] Bug: `CredentialClient` does not validate `claims_hash` length before submission
**Labels:** `bug` `sdk` `validation`

**Scope**
`sdk/src/` — The SDK sends `claims_hash` to `issue_credential` without verifying it is exactly 32 bytes (SHA-256), allowing the contract to reject it with an opaque error.

**Guidelines**
- Validate `claims_hash` is a `Uint8Array` or `Buffer` of exactly 32 bytes.
- Return a `SorobanIdentityError` with code `VALIDATION_ERROR` if invalid.
- Document the expected format in the SDK JSDoc.

**DoD**
- [ ] Validation added to `CredentialClient.issueCredential`.
- [ ] Clear `VALIDATION_ERROR` thrown on invalid hash.
- [ ] JSDoc updated.
- [ ] Tests: 32-byte hash passes, 31-byte hash throws.

---

### [BUG-04] Bug: OpenAPI spec `docs/openapi.yaml` missing `429` and `503` response schemas
**Labels:** `bug` `api` `documentation`

**Scope**
`docs/openapi.yaml` — Several endpoints document `200`, `400`, `401`, `403`, and `404` but omit `429 Too Many Requests` and `503 Service Unavailable`, which the server actually returns.

**Guidelines**
- Add `429` response schema (with `Retry-After` header) to all endpoints.
- Add `503` response schema to `GET /health` and any contract-calling endpoint.
- Use `$ref` to a shared `ErrorEnvelope` schema component.

**DoD**
- [ ] All endpoints include `429` and `503` responses in the spec.
- [ ] Shared `ErrorEnvelope` component defined and referenced.
- [ ] Spec validates with `spectral lint docs/openapi.yaml`.

---

### [BUG-05] Bug: Deploy script `scripts/deploy.sh` does not verify contract IDs after deployment
**Labels:** `bug` `devops` `scripts`

**Scope**
`scripts/deploy.sh` — After deploying, contract IDs are written to `deployed.env` but the script does not verify each ID is a valid 56-character Stellar contract address.

**Guidelines**
- After each deploy step, validate the returned contract ID with a regex `^C[A-Z2-7]{55}$`.
- If validation fails, print a clear error and exit non-zero.
- Add a `verify_deployed_env` function that checks all three IDs at the end.

**DoD**
- [ ] Each contract ID validated immediately after deployment.
- [ ] Script exits non-zero on invalid ID.
- [ ] `verify_deployed_env` function implemented and called.

---

### [BUG-06] Fix: No end-to-end test covering the full credential lifecycle
**Labels:** `fix` `testing` `integration`

**Scope**
Project-wide — There is no test that covers the full flow: create DID → register issuer → issue credential → verify credential → revoke → verify returns false.

**Guidelines**
- Create `contracts/tests/e2e_credential_lifecycle.rs` (or a JS integration test under `server/test/`).
- Use a local Soroban sandbox or mock RPC for determinism.
- Cover happy path and revocation path.

**DoD**
- [ ] End-to-end test file created.
- [ ] Happy path and revocation path covered.
- [ ] Test runs in CI without network access.
- [ ] `cargo test` or `npm test` includes the new test.

---

### [BUG-07] Fix: `docs/contract-events.md` missing events for `reputation` contract
**Labels:** `fix` `documentation` `smart-contract`

**Scope**
`docs/contract-events.md` — The reputation contract emits events for `score_submitted`, `dispute_opened`, and `dispute_resolved` but none of these are documented.

**Guidelines**
- Add event schema entries for all three reputation events.
- Follow the existing format: topic array, data fields, example payload.
- Cross-reference with `contracts/reputation/src/lib.rs` for exact field names.

**DoD**
- [ ] All three reputation events documented with schema and example.
- [ ] Format matches existing entries in the file.
- [ ] PR reviewed by someone with contract knowledge.

---

### [BUG-08] Fix: SDK `ReputationClient.getHistory` uses offset pagination but contract uses cursor
**Labels:** `fix` `sdk` `api`

**Scope**
`sdk/src/reputation.ts` — `getHistory` passes `offset` + `limit` to `get_history`, but the contract's `list_history` function uses cursor-based pagination. Offset skips are O(n) on-chain.

**Guidelines**
- Switch `getHistory` to call `list_history(subject, reporter, cursor, limit)`.
- Update return type to include `nextCursor` for client-side pagination.
- Deprecate the offset-based overload with a `console.warn`.

**DoD**
- [ ] `getHistory` uses cursor-based `list_history`.
- [ ] Return type includes `nextCursor`.
- [ ] Old offset-based path deprecated with warning.
- [ ] Tests updated for cursor semantics.

---

### [BUG-09] Fix: Frontend build has no environment variable validation at startup
**Labels:** `fix` `frontend` `devops`

**Scope**
`frontend/src/config.ts` — Missing `VITE_*` env vars cause silent `undefined` values that only fail at runtime during contract calls, making misconfiguration hard to diagnose.

**Guidelines**
- At module load time, validate all required `VITE_*` vars are non-empty strings.
- Throw a descriptive error listing the missing variables if any are absent.
- Provide a `validateConfig()` function called in `main.tsx` before React renders.

**DoD**
- [ ] `validateConfig()` implemented and called before app mount.
- [ ] Missing vars produce a clear error listing all missing keys.
- [ ] Test: missing env var causes `validateConfig` to throw with correct message.

---

### [BUG-10] Fix: Pagination semantics (cursor vs offset) inconsistently documented across SDK, server, and contracts
**Labels:** `fix` `documentation` `api`

**Scope**
`docs/api-server.md`, `docs/openapi.yaml`, SDK JSDoc — Some endpoints use cursor-based pagination, others use offset. Neither pattern is documented consistently, and the two are mixed in the OpenAPI spec.

**Guidelines**
- Add a "Pagination" section to `docs/api-server.md` explaining both patterns and when each is used.
- Audit the OpenAPI spec and ensure cursor endpoints use `cursor` + `limit` params (not `page` + `offset`).
- Audit SDK methods and add JSDoc `@param` descriptions for cursor fields.
- Add a pagination example to the README.

**DoD**
- [ ] Pagination section added to `docs/api-server.md`.
- [ ] OpenAPI spec uses consistent parameter names per pagination style.
- [ ] SDK JSDoc updated for all paginated methods.
- [ ] README includes a pagination usage example.
