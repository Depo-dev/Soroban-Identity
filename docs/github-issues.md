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

