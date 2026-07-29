//! Stable trait ABI for the `credential-manager` contract.

use credential_manager::{
    Credential, CredentialIdsPage, CredentialManager, CredentialStorageStats, CredentialType,
    ContractError, IssuersPage,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, Map, String, Vec};

/// Public entry points exposed by the `credential-manager` contract.
///
/// Integrators can depend on this trait (and the `credential-manager`
/// crate's re-exported types) to code against a stable ABI without needing
/// to track the contract's internal implementation.
pub trait CredentialManagerInterface {
    fn ping(env: Env) -> u32;

    fn initialize(
        env: Env,
        admin: Address,
        identity_registry_id: Address,
    ) -> Result<(), ContractError>;

    fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError>;

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>;

    fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError>;

    fn remove_issuer(env: Env, issuer: Address) -> Result<(), ContractError>;

    fn register_schema(
        env: Env,
        issuer: Address,
        schema_hash: BytesN<32>,
    ) -> Result<(), ContractError>;

    #[allow(clippy::too_many_arguments)]
    fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        claims_hash: BytesN<32>,
        signature: Bytes,
        expires_at: u64,
        schema_hash: Option<BytesN<32>>,
    ) -> Result<BytesN<32>, ContractError>;

    fn revoke_credential(
        env: Env,
        issuer: Address,
        credential_id: BytesN<32>,
    ) -> Result<(), ContractError>;

    fn expire_credential(
        env: Env,
        caller: Address,
        credential_id: BytesN<32>,
    ) -> Result<(), ContractError>;

    fn verify_credential(env: Env, credential_id: BytesN<32>) -> Result<(), ContractError>;

    fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, ContractError>;

    fn verify_claims_hash(env: Env, credential_id: BytesN<32>, hash: BytesN<32>) -> bool;

    fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>>;

    fn list_subject_credentials(
        env: Env,
        subject: Address,
        cursor: Option<u64>,
        limit: u32,
        credential_type: Option<CredentialType>,
    ) -> CredentialIdsPage;

    fn get_credential_count(env: Env, subject: Address) -> u32;

    fn get_issuers(env: Env) -> Vec<Address>;

    fn list_issuers(env: Env, cursor: Option<u64>, limit: u32) -> IssuersPage;

    fn get_issuer_credentials(env: Env, issuer: Address) -> Vec<BytesN<32>>;

    fn list_issuer_credentials(
        env: Env,
        issuer: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> CredentialIdsPage;

    fn get_storage_stats(env: Env) -> CredentialStorageStats;
}

/// Blanket implementation delegating to `CredentialManager`'s existing
/// `#[contractimpl]` entry points, so the trait impl and the deployed
/// contract can never drift apart.
impl CredentialManagerInterface for CredentialManager {
    fn ping(env: Env) -> u32 {
        Self::ping(env)
    }

    fn initialize(
        env: Env,
        admin: Address,
        identity_registry_id: Address,
    ) -> Result<(), ContractError> {
        Self::initialize(env, admin, identity_registry_id)
    }

    fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        Self::transfer_admin(env, current_admin, new_admin)
    }

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        Self::upgrade(env, admin, new_wasm_hash)
    }

    fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::add_issuer(env, issuer)
    }

    fn remove_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::remove_issuer(env, issuer)
    }

    fn register_schema(
        env: Env,
        issuer: Address,
        schema_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        Self::register_schema(env, issuer, schema_hash)
    }

    fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        claims_hash: BytesN<32>,
        signature: Bytes,
        expires_at: u64,
        schema_hash: Option<BytesN<32>>,
    ) -> Result<BytesN<32>, ContractError> {
        Self::issue_credential(
            env,
            issuer,
            subject,
            credential_type,
            claims,
            claims_hash,
            signature,
            expires_at,
            schema_hash,
        )
    }

    fn revoke_credential(
        env: Env,
        issuer: Address,
        credential_id: BytesN<32>,
    ) -> Result<(), ContractError> {
        Self::revoke_credential(env, issuer, credential_id)
    }

    fn expire_credential(
        env: Env,
        caller: Address,
        credential_id: BytesN<32>,
    ) -> Result<(), ContractError> {
        Self::expire_credential(env, caller, credential_id)
    }

    fn verify_credential(env: Env, credential_id: BytesN<32>) -> Result<(), ContractError> {
        Self::verify_credential(env, credential_id)
    }

    fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, ContractError> {
        Self::get_credential(env, credential_id)
    }

    fn verify_claims_hash(env: Env, credential_id: BytesN<32>, hash: BytesN<32>) -> bool {
        Self::verify_claims_hash(env, credential_id, hash)
    }

    fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::get_subject_credentials(env, subject)
    }

    fn list_subject_credentials(
        env: Env,
        subject: Address,
        cursor: Option<u64>,
        limit: u32,
        credential_type: Option<CredentialType>,
    ) -> CredentialIdsPage {
        Self::list_subject_credentials(env, subject, cursor, limit, credential_type)
    }

    fn get_credential_count(env: Env, subject: Address) -> u32 {
        Self::get_credential_count(env, subject)
    }

    fn get_issuers(env: Env) -> Vec<Address> {
        Self::get_issuers(env)
    }

    fn list_issuers(env: Env, cursor: Option<u64>, limit: u32) -> IssuersPage {
        Self::list_issuers(env, cursor, limit)
    }

    fn get_issuer_credentials(env: Env, issuer: Address) -> Vec<BytesN<32>> {
        Self::get_issuer_credentials(env, issuer)
    }

    fn list_issuer_credentials(
        env: Env,
        issuer: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> CredentialIdsPage {
        Self::list_issuer_credentials(env, issuer, cursor, limit)
    }

    fn get_storage_stats(env: Env) -> CredentialStorageStats {
        Self::get_storage_stats(env)
    }
}
