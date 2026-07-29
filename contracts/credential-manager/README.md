# credential-manager

Soroban smart contract for issuing, verifying, and revoking verifiable credentials.

## Module structure

```
src/
  lib.rs          — Contract entry point; thin wrappers that delegate to submodules
  types.rs        — CredentialType enum and Credential struct
  keys.rs         — Storage key constants and key-builder helpers
  issuer.rs       — Issuer registry: add_issuer, remove_issuer, require_issuer
  credential.rs   — Credential lifecycle: issue_credential, get_credential, get_subject_credentials
  revocation.rs   — Revocation: revoke_credential, verify_credential
```

## Contract functions

| Function | Description |
|---|---|
| `initialize(admin)` | Set the contract admin |
| `add_issuer(issuer)` | Register a trusted issuer (admin only) |
| `remove_issuer(issuer)` | Remove a trusted issuer (admin only) |
| `issue_credential(issuer, subject, type, claims, sig, expires_at)` | Issue a credential; returns its 32-byte ID |
| `revoke_credential(issuer, credential_id)` | Revoke a credential (original issuer only) |
| `verify_credential(credential_id)` | Return true if credential exists, is not revoked, and is not expired |
| `get_credential(credential_id)` | Fetch a credential by ID |
| `get_subject_credentials(subject)` | List all credential IDs issued to a subject |

## Issuer credential ring buffer

Each issuer's reverse-lookup index (`get_issuer_credentials`) is capped at `MAX_ISSUER_CREDS` (10,000) entries. Once an issuer reaches the cap, issuing a new credential evicts the oldest entry (FIFO) to make room — the credential itself is **not** deleted or revoked, only its reference in that issuer's index is dropped. An `evicted` event (topic `CRED,evicted`, payload `[eventVersion, issuer, evictedId]`, see [docs/contract-events.md](../../docs/contract-events.md)) is emitted whenever this happens, so off-chain indexers can detect the eviction and re-index the dropped credential ID by other means (e.g. `get_subject_credentials`) if needed.
