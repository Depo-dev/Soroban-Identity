//! Stable trait ABI for the `reputation` contract.

use reputation::{
    ContractError, Reputation, ReportersPage, ReputationRecord, ReputationStorageStats,
    ScoreEntriesPage, ScoreEntry,
};
use soroban_sdk::{Address, BytesN, Env, String, Vec};

/// Public entry points exposed by the `reputation` contract.
///
/// Integrators can depend on this trait (and the `reputation` crate's
/// re-exported types) to code against a stable ABI without needing to track
/// the contract's internal implementation.
pub trait ReputationInterface {
    fn ping(env: Env) -> u32;

    fn initialize(env: Env, admin: Address) -> Result<(), ContractError>;

    fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError>;

    fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError>;

    fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError>;

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>;

    fn add_reporter(env: Env, reporter: Address) -> Result<(), ContractError>;

    fn remove_reporter(env: Env, reporter: Address) -> Result<(), ContractError>;

    fn update_thresholds(
        env: Env,
        min_score: i64,
        min_reporters: u32,
    ) -> Result<(), ContractError>;

    fn set_default_threshold(
        env: Env,
        min_score: i64,
        min_reporters: u32,
    ) -> Result<(), ContractError>;

    fn submit_score(
        env: Env,
        reporter: Address,
        subject: Address,
        delta: i64,
        reason: String,
    ) -> Result<(), ContractError>;

    fn get_reputation(env: Env, subject: Address) -> ReputationRecord;

    fn get_history(
        env: Env,
        subject: Address,
        reporter: Address,
        offset: u32,
        limit: u32,
        from_timestamp: Option<u64>,
        to_timestamp: Option<u64>,
    ) -> Result<Vec<ScoreEntry>, ContractError>;

    fn passes_sybil_check(
        env: Env,
        subject: Address,
        min_score: i64,
        min_reporters: u32,
    ) -> bool;

    fn passes_sybil_check_default(env: Env, subject: Address) -> Result<bool, ContractError>;

    fn get_reporters_list(env: Env) -> Vec<Address>;

    fn list_reporters(env: Env, cursor: Option<u64>, limit: u32) -> ReportersPage;

    fn list_history(
        env: Env,
        subject: Address,
        reporter: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<ScoreEntriesPage, ContractError>;

    fn get_storage_stats(env: Env) -> ReputationStorageStats;

    fn dispute_score(
        env: Env,
        subject: Address,
        reporter: Address,
        delta_index: u32,
    ) -> Result<u32, ContractError>;

    fn resolve_dispute(
        env: Env,
        admin: Address,
        dispute_id: u32,
        accepted: bool,
    ) -> Result<(), ContractError>;
}

/// Blanket implementation delegating to `Reputation`'s existing
/// `#[contractimpl]` entry points, so the trait impl and the deployed
/// contract can never drift apart.
impl ReputationInterface for Reputation {
    fn ping(env: Env) -> u32 {
        Self::ping(env)
    }

    fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        Self::initialize(env, admin)
    }

    fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError> {
        Self::propose_admin(env, admin, proposed)
    }

    fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError> {
        Self::accept_admin(env, proposed)
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

    fn add_reporter(env: Env, reporter: Address) -> Result<(), ContractError> {
        Self::add_reporter(env, reporter)
    }

    fn remove_reporter(env: Env, reporter: Address) -> Result<(), ContractError> {
        Self::remove_reporter(env, reporter)
    }

    fn update_thresholds(
        env: Env,
        min_score: i64,
        min_reporters: u32,
    ) -> Result<(), ContractError> {
        Self::update_thresholds(env, min_score, min_reporters)
    }

    fn set_default_threshold(
        env: Env,
        min_score: i64,
        min_reporters: u32,
    ) -> Result<(), ContractError> {
        Self::set_default_threshold(env, min_score, min_reporters)
    }

    fn submit_score(
        env: Env,
        reporter: Address,
        subject: Address,
        delta: i64,
        reason: String,
    ) -> Result<(), ContractError> {
        Self::submit_score(env, reporter, subject, delta, reason)
    }

    fn get_reputation(env: Env, subject: Address) -> ReputationRecord {
        Self::get_reputation(env, subject)
    }

    fn get_history(
        env: Env,
        subject: Address,
        reporter: Address,
        offset: u32,
        limit: u32,
        from_timestamp: Option<u64>,
        to_timestamp: Option<u64>,
    ) -> Result<Vec<ScoreEntry>, ContractError> {
        Self::get_history(env, subject, reporter, offset, limit, from_timestamp, to_timestamp)
    }

    fn passes_sybil_check(
        env: Env,
        subject: Address,
        min_score: i64,
        min_reporters: u32,
    ) -> bool {
        Self::passes_sybil_check(env, subject, min_score, min_reporters)
    }

    fn passes_sybil_check_default(env: Env, subject: Address) -> Result<bool, ContractError> {
        Self::passes_sybil_check_default(env, subject)
    }

    fn get_reporters_list(env: Env) -> Vec<Address> {
        Self::get_reporters_list(env)
    }

    fn list_reporters(env: Env, cursor: Option<u64>, limit: u32) -> ReportersPage {
        Self::list_reporters(env, cursor, limit)
    }

    fn list_history(
        env: Env,
        subject: Address,
        reporter: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<ScoreEntriesPage, ContractError> {
        Self::list_history(env, subject, reporter, cursor, limit)
    }

    fn get_storage_stats(env: Env) -> ReputationStorageStats {
        Self::get_storage_stats(env)
    }

    fn dispute_score(
        env: Env,
        subject: Address,
        reporter: Address,
        delta_index: u32,
    ) -> Result<u32, ContractError> {
        Self::dispute_score(env, subject, reporter, delta_index)
    }

    fn resolve_dispute(
        env: Env,
        admin: Address,
        dispute_id: u32,
        accepted: bool,
    ) -> Result<(), ContractError> {
        Self::resolve_dispute(env, admin, dispute_id, accepted)
    }
}
