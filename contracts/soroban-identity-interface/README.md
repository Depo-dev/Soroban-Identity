# soroban-identity-interface

Stable Rust trait ABI for the Soroban Identity contracts:

- `IdentityRegistryInterface` — `identity-registry`
- `CredentialManagerInterface` — `credential-manager`
- `ReputationInterface` — `reputation`

## Why

Previously, external Soroban contracts integrating with Soroban Identity had
no stable, compile-time-checked surface to code against — only the
contracts' own inherent `#[contractimpl]` methods, which offer no guarantee
against a silent function rename breaking downstream integrations.

This crate defines one trait per contract, mirroring its public entry
points exactly, plus blanket `impl <Trait> for <Contract>` blocks so the
trait and the deployed contract can never drift apart (a rename or
signature change to a contract's inherent methods will fail to compile
here until the trait is updated too).

## Usage

Add this crate as a dependency to depend on the trait definitions and their
associated types without depending on the underlying contract's
implementation details:

```toml
[dependencies]
soroban-identity-interface = { path = "../soroban-identity-interface" }
```

```rust
use soroban_identity_interface::{IdentityRegistryInterface, DidDocument};

fn resolve<T: IdentityRegistryInterface>(env: Env, controller: Address) -> Option<DidDocument> {
    T::resolve_did(env, controller).ok()
}
```

## Types

Each trait's associated `#[contracttype]`/`#[contracterror]` types are
re-exported from this crate under a per-contract-prefixed name where a
collision would otherwise occur (e.g. `IdentityRegistryError`,
`CredentialManagerError`, `ReputationError` for each contract's
`ContractError`), so there is exactly one canonical definition of each
type and its wire (XDR) representation — this crate does not duplicate
them.
