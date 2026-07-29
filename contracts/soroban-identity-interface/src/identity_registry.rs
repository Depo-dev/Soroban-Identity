//! Stable trait ABI for the `identity-registry` contract.

use identity_registry::{
    ContractError, DidDocument, IdentityRegistry, IdentityStorageStats, ServiceEndpoint,
};
use soroban_sdk::{Address, BytesN, Env, Map, String, Vec};

/// Public entry points exposed by the `identity-registry` contract.
///
/// Integrators can depend on this trait (and the `identity-registry` crate's
/// re-exported types) to code against a stable ABI without needing to track
/// the contract's internal implementation or risk breakage from an
/// unannounced function rename.
pub trait IdentityRegistryInterface {
    fn ping(env: Env) -> u32;

    fn initialize(env: Env, admin: Address) -> Result<(), ContractError>;

    fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError>;

    fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError>;

    fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError>;

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>;

    fn create_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<String, ContractError>;

    fn add_service(
        env: Env,
        controller: Address,
        service: ServiceEndpoint,
    ) -> Result<(), ContractError>;

    fn update_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<(), ContractError>;

    fn deactivate_did(env: Env, controller: Address) -> Result<(), ContractError>;

    fn reactivate_did(env: Env, admin: Address, controller: Address) -> Result<(), ContractError>;

    fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, ContractError>;

    fn has_active_did(env: Env, controller: Address) -> bool;

    fn did_exists(env: Env, controller: Address) -> bool;

    fn get_did_count(env: Env) -> u32;

    fn get_storage_stats(env: Env) -> IdentityStorageStats;

    fn remove_service(
        env: Env,
        controller: Address,
        service_id: String,
    ) -> Result<(), ContractError>;

    fn get_services(env: Env, controller: Address) -> Result<Vec<ServiceEndpoint>, ContractError>;
}

/// Blanket implementation delegating to `IdentityRegistry`'s existing
/// `#[contractimpl]` entry points, so the trait impl and the deployed
/// contract can never drift apart.
impl IdentityRegistryInterface for IdentityRegistry {
    fn ping(env: Env) -> u32 {
        Self::ping(env)
    }

    fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        Self::initialize(env, admin)
    }

    fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        Self::transfer_admin(env, current_admin, new_admin)
    }

    fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError> {
        Self::propose_admin(env, admin, proposed)
    }

    fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError> {
        Self::accept_admin(env, proposed)
    }

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        Self::upgrade(env, admin, new_wasm_hash)
    }

    fn create_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<String, ContractError> {
        Self::create_did(env, controller, metadata)
    }

    fn add_service(
        env: Env,
        controller: Address,
        service: ServiceEndpoint,
    ) -> Result<(), ContractError> {
        Self::add_service(env, controller, service)
    }

    fn update_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<(), ContractError> {
        Self::update_did(env, controller, metadata)
    }

    fn deactivate_did(env: Env, controller: Address) -> Result<(), ContractError> {
        Self::deactivate_did(env, controller)
    }

    fn reactivate_did(env: Env, admin: Address, controller: Address) -> Result<(), ContractError> {
        Self::reactivate_did(env, admin, controller)
    }

    fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, ContractError> {
        Self::resolve_did(env, controller)
    }

    fn has_active_did(env: Env, controller: Address) -> bool {
        Self::has_active_did(env, controller)
    }

    fn did_exists(env: Env, controller: Address) -> bool {
        Self::did_exists(env, controller)
    }

    fn get_did_count(env: Env) -> u32 {
        Self::get_did_count(env)
    }

    fn get_storage_stats(env: Env) -> IdentityStorageStats {
        Self::get_storage_stats(env)
    }

    fn remove_service(
        env: Env,
        controller: Address,
        service_id: String,
    ) -> Result<(), ContractError> {
        Self::remove_service(env, controller, service_id)
    }

    fn get_services(env: Env, controller: Address) -> Result<Vec<ServiceEndpoint>, ContractError> {
        Self::get_services(env, controller)
    }
}
