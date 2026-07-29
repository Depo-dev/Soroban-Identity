#![no_std]
//! # soroban-identity-interface
//!
//! Stable Rust trait ABI for the three Soroban Identity contracts
//! (`identity-registry`, `credential-manager`, `reputation`).
//!
//! Each contract implements the corresponding trait from this crate, so
//! external Soroban contracts and off-chain integrators that want a
//! compile-time-checked contract against a specific set of entry points can
//! depend on this crate instead of hand-copying function signatures (which
//! silently drifts when a contract function is renamed).
//!
//! Note: this crate re-exports the `#[contracttype]`/`#[contracterror]`
//! types used by each trait's signatures directly from their owning
//! contract crate, rather than duplicating them, so there is exactly one
//! canonical definition of each type and its wire (XDR) representation.

// Local trait modules are named distinctly from the `identity-registry` /
// `credential-manager` / `reputation` extern crate dependencies (via
// `#[path]`) to avoid a name collision at the crate root between the
// module and the crate of the same name.
#[path = "credential_manager.rs"]
mod credential_manager_trait;
#[path = "identity_registry.rs"]
mod identity_registry_trait;
#[path = "reputation.rs"]
mod reputation_trait;

pub use credential_manager_trait::CredentialManagerInterface;
pub use identity_registry_trait::IdentityRegistryInterface;
pub use reputation_trait::ReputationInterface;

// Re-export the types referenced by the traits above, so a crate that only
// depends on `soroban-identity-interface` doesn't also need direct
// dependencies on `identity-registry` / `credential-manager` / `reputation`
// just to name the types in those trait signatures.
pub use identity_registry::{
    ContractError as IdentityRegistryError, DidDocument, IdentityStorageStats, ServiceEndpoint,
};

pub use credential_manager::{
    Credential, CredentialIdsPage, CredentialStorageStats, CredentialType,
    ContractError as CredentialManagerError, IssuersPage,
};

pub use reputation::{
    ContractError as ReputationError, ReportersPage, ReputationRecord, ReputationStorageStats,
    ScoreEntriesPage, ScoreEntry,
};
