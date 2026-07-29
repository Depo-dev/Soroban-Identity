#![no_std]
#![deny(clippy::all)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};
use soroban_sdk::xdr::ToXdr;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;

const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");
const SUBJECT: Symbol = symbol_short!("sub");
const CRED_CNT: Symbol = symbol_short!("CREDCNT");
const REVOKED_CNT: Symbol = symbol_short!("REVCNT");
const TOTAL_ISSUED_CNT: Symbol = symbol_short!("TOTALCNT");
const ISSUER_CREDS: Symbol = symbol_short!("ISSCREDS");
/// Per (issuer, subject, credential_type) issuance counter, mixed into the
/// credential ID so re-issuing after a revocation never collides with the
/// original storage key. See issue #467.
const ISS_NONCE: Symbol = symbol_short!("ISSNONCE");

const MAX_ISSUERS: u32 = 100;
const SCHEMA: Symbol = symbol_short!("SCHEMA");
const IDENTITY_REGISTRY: Symbol = symbol_short!("IDREGIST");
/// Issue #551: reentrancy guard flag. Set for the duration of any function
/// that performs a cross-contract call (e.g. `issue_credential` calling
/// into `identity-registry`), so a re-invocation of a guarded function
/// during that call is rejected instead of observing half-updated state.
const EXECUTING: Symbol = symbol_short!("EXEC");

const MAX_ISSUERS: u32 = 100;
const ABSOLUTE_MAX_ISSUERS: u32 = 500;
const MAX_ISSUER_CREDS: u32 = 10_000;
const TTL_MAX: u32 = 6_312_000;
const TTL_MIN: u32 = 17_280;
const PAGE_CAP: u32 = 100;

#[contracterror]
#[derive(Clone, Debug, PartialEq, Copy)]
pub enum ContractError {
    AlreadyInitialized = 1,
    UnauthorizedIssuer = 2,
    CredentialNotFound = 3,
    CredentialRevoked = 4,
    CredentialAlreadyExists = 5,
    NotInitialized = 6,
    Unauthorized = 7,
    MaxIssuersReached = 8,
    CredentialExpired = 9,
    NoPendingAdmin = 10,
    NotPendingAdmin = 11,
    SchemaNotFound = 12,
    CredentialNotExpiredYet = 13,
    /// Issue #551: a guarded function was re-entered while a prior
    /// invocation (which is mid cross-contract call) had not yet completed.
    ReentrantCall = 14,
    SubjectHasNoDid = 15,
}

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct CredentialStorageStats {
    pub total_credentials: u32,
    pub revoked_credentials: u32,
    pub active_credentials: u32,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum CredentialType {
    Kyc,
    Reputation,
    Achievement,
    Custom,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CredentialIdsPage {
    pub items: Vec<BytesN<32>>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct IssuersPage {
    pub items: Vec<Address>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub id: BytesN<32>,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: CredentialType,
    pub claims: Map<String, String>,
    pub claims_hash: BytesN<32>,
    pub signature: Bytes,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub schema_hash: Option<BytesN<32>>,
}

// ── Reentrancy guard (Issue #551) ──────────────────────────────────────────────
//
// Cross-contract call order for this contract:
//   credential-manager::issue_credential -> identity-registry::has_active_did
// `has_active_did` is a read-only query on identity-registry and does not
// call back into credential-manager, so there is no circular invocation
// path today. This guard exists as defense-in-depth: it makes any future
// cross-contract call added to a guarded function fail closed (reject
// reentrant invocations) rather than silently allowing partially-applied
// state if the called contract were ever changed to call back into us.

/// RAII guard: sets the `EXECUTING` instance-storage flag on construction
/// and clears it on drop, so the flag is cleared on every normal exit path
/// (including early returns via `?`) without needing to remember to clear
/// it manually at each return site.
struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    fn acquire(env: &'a Env) -> Result<Self, ContractError> {
        if env.storage().instance().get(&EXECUTING).unwrap_or(false) {
            return Err(ContractError::ReentrantCall);
        }
        env.storage().instance().set(&EXECUTING, &true);
        Ok(Self { env })
    }
}

impl<'a> Drop for ReentrancyGuard<'a> {
    fn drop(&mut self) {
        self.env.storage().instance().remove(&EXECUTING);
    }
}

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    pub fn ping(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn initialize(env: Env, admin: Address, identity_registry_id: Address) -> Result<(), ContractError> {
        Self::require_uninitialized(&env)?;
        Self::set_admin(&env, &admin);
        env.storage().instance().set(&IDENTITY_REGISTRY, &identity_registry_id);
        env.events().publish((ADMIN, symbol_short!("init")), (EVENT_VERSION, admin));
        Ok(())
    }

    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), ContractError> {
        current_admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != current_admin {
            return Err(ContractError::Unauthorized);
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish((ADMIN, symbol_short!("transfer")), (EVENT_VERSION, current_admin, new_admin));
        Ok(())
    }

    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin {
            return Err(ContractError::Unauthorized);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut issuers = Self::get_issuers_internal(&env);
        if !issuers.contains(&issuer) {
            if issuers.len() >= Self::effective_max_issuers(&env) {
                return Err(ContractError::MaxIssuersReached);
            }
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), (EVENT_VERSION, issuer));
        }
        Ok(())
    }

    pub fn set_max_issuers(env: Env, admin: Address, new_max: u32) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin {
            return Err(ContractError::Unauthorized);
        }
        if new_max == 0 || new_max > ABSOLUTE_MAX_ISSUERS {
            return Err(ContractError::InvalidMaxIssuers);
        }
        let old_max = Self::get_max_issuers_internal(&env);
        env.storage().instance().set(&MAX_ISSUERS_CFG, &new_max);
        env.events().publish(
            (ADMIN, Symbol::new(&env, "admin_config_changed")),
            (EVENT_VERSION, symbol_short!("max_iss"), old_max, new_max),
        );
        Ok(())
    }

    pub fn get_max_issuers(env: Env) -> u32 {
        Self::get_max_issuers_internal(&env)
    }

    pub fn remove_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let issuers = Self::get_issuers_internal(&env);
        let mut updated = Vec::new(&env);
        for i in issuers.iter() {
            if i != issuer {
                updated.push_back(i);
            }
        }
        env.storage().instance().set(&ISSUER, &updated);
        Ok(())
    }

    pub fn register_schema(env: Env, issuer: Address, schema_hash: BytesN<32>) -> Result<(), ContractError> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;
        if schema_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(ContractError::InvalidSchemaHash);
        }
        let schema_key = (SCHEMA, issuer.clone(), schema_hash.clone());
        env.storage().persistent().set(&schema_key, &true);
        env.storage().persistent().extend_ttl(&schema_key, TTL_MAX, TTL_MAX);
        env.events().publish((CRED, symbol_short!("sch_reg")), (EVENT_VERSION, issuer, schema_hash));
        Ok(())
    }

    /// Issues a verifiable credential to a subject. Caller must be a registered issuer.
    ///
    /// The credential ID is derived deterministically as
    /// `sha256(issuer_xdr || subject_xdr || type_tag || nonce)`, where `nonce` is
    /// a per-(issuer, subject, type) issuance counter. This means the same issuer
    /// cannot have two *simultaneously active* credentials of the same type for
    /// the same subject (the previous one must be revoked first), but each
    /// issuance still gets a unique ID — re-issuing after a revocation never
    /// overwrites the original record. See issue #467.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `issuer` - The registered issuer address (must sign the transaction).
    /// * `subject` - The address receiving the credential.
    /// * `credential_type` - The type of credential being issued ([`CredentialType`]).
    /// * `claims` - Arbitrary key-value claims to embed in the credential.
    /// * `claims_hash` - SHA-256 hash of the off-chain claims payload (32 bytes).
    ///   Stored on-chain for privacy-preserving verification.
    /// * `signature` - Issuer's signature over the credential data (64 bytes).
    /// * `expires_at` - Unix timestamp in **seconds** after which the credential is invalid.
    ///   Pass `0` for no expiry. Use `Date.now() / 1000` in the SDK, not `Date.now()`.
    ///
    /// # Returns
    /// The 32-byte credential ID as [`BytesN<32>`].
    ///
    /// # Errors
    /// Returns [`ContractError::CredentialAlreadyExists`] if a non-revoked credential
    /// with the same issuer + subject + type already exists.
    ///
    /// # Panics
    /// Panics with `"CredentialAlreadyExpired"` if `expires_at` is in the past.
    /// Panics with `"not a registered issuer"` if the caller is not registered.
    pub fn issue_credential(
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
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;

        if let Some(ref sh) = schema_hash {
            let schema_key = (SCHEMA, issuer.clone(), sh.clone());
            if !env.storage().persistent().has(&schema_key) {
                return Err(ContractError::SchemaNotFound);
            }
        }

        // Issue #551: guard the cross-contract call into identity-registry.
        let _guard = ReentrancyGuard::acquire(&env)?;

        let registry_id: Address = env.storage().instance().get(&IDENTITY_REGISTRY).ok_or(ContractError::NotInitialized)?;
        let mut registry_args: Vec<Val> = Vec::new(&env);
        registry_args.push_back(subject.clone().into_val(&env));
        // Wrap the cross-contract call so a missing/deactivated DID (or any
        // failure in identity-registry) surfaces as a typed error instead of
        // an opaque panic.
        let has_did: bool = match env.try_invoke_contract::<bool, soroban_sdk::Error>(
            &registry_id,
            &Symbol::new(&env, "has_active_did"),
            registry_args,
        ) {
            Ok(Ok(val)) => val,
            _ => return Err(ContractError::SubjectHasNoDid),
        };
        if !has_did {
            return Err(ContractError::SubjectHasNoDid);
        }

        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            return Err(ContractError::CredentialExpired);
        }

        // Per (issuer, subject, type) issuance counter, mixed into the ID so a
        // re-issuance after revocation never overwrites the original record.
        let nonce_key = Self::nonce_key(&env, &issuer, &subject, &credential_type);
        let current_nonce: u64 = env.storage().persistent().get(&nonce_key).unwrap_or(0);

        // Reject if the most recently issued credential for this triple is not revoked.
        if current_nonce > 0 {
            let existing_id = Self::derive_id(&env, &issuer, &subject, &credential_type, current_nonce);
            let existing_key = Self::cred_key(&existing_id);
            if let Some(existing) = env.storage().persistent().get::<_, Credential>(&existing_key) {
                if !existing.revoked {
                    return Err(ContractError::CredentialAlreadyExists);
                }
        let id = Self::derive_id(&env, &issuer, &subject, &credential_type);
        let key = Self::cred_key(&id);
        if let Some(existing) = env.storage().persistent().get::<_, Credential>(&key) {
            if !existing.revoked {
                return Err(ContractError::CredentialAlreadyExists);
            }
        }

        let next_nonce = current_nonce + 1;
        let id = Self::derive_id(&env, &issuer, &subject, &credential_type, next_nonce);
        let key = Self::cred_key(&id);

        let credential = Credential {
            id: id.clone(),
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type: credential_type.clone(),
            claims,
            claims_hash,
            signature,
            issued_at: now,
            expires_at,
            revoked: false,
            schema_hash,
        };

        env.storage().persistent().set(&key, &credential);
        let ttl = Self::ttl_for_credential(&env, expires_at);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);

        env.storage().persistent().set(&nonce_key, &next_nonce);
        env.storage().persistent().extend_ttl(&nonce_key, TTL_MAX, TTL_MAX);

        // Index credential under subject
        let mut subject_creds = Self::fetch_subject_creds(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&subject);
        env.storage().persistent().set(&subject_key, &subject_creds);
        env.storage().persistent().extend_ttl(&subject_key, TTL_MAX, TTL_MAX);

        // Index credential under issuer for reverse lookup
        // Apply ring-buffer semantics: cap at MAX_ISSUER_CREDS
        let mut issuer_creds = Self::fetch_issuer_creds(&env, &issuer);
        if issuer_creds.len() >= MAX_ISSUER_CREDS {
            // Drop the oldest (head) entry, emitting an event so indexers can
            // detect and recover evicted credential ids instead of silently
            // losing them.
            let evicted_id = issuer_creds.get(0).expect("ring buffer non-empty");
            issuer_creds = issuer_creds.slice(1..issuer_creds.len());
            env.events().publish(
                (CRED, symbol_short!("evicted")),
                (EVENT_VERSION, issuer.clone(), evicted_id),
            );
        }
        issuer_creds.push_back(id.clone());
        let issuer_creds_key = Self::issuer_creds_key(&issuer);
        env.storage().persistent().set(&issuer_creds_key, &issuer_creds);
        env.storage().persistent().extend_ttl(&issuer_creds_key, TTL_MAX, TTL_MAX);

        let cnt_key = (CRED_CNT, subject.clone());
        let cnt: u32 = env.storage().persistent().get(&cnt_key).unwrap_or(0);
        env.storage().persistent().set(&cnt_key, &(cnt + 1));

        let total_issued: u32 = env.storage().instance().get(&TOTAL_ISSUED_CNT).unwrap_or(0);
        env.storage().instance().set(&TOTAL_ISSUED_CNT, &(total_issued + 1));

        env.events().publish(
            (CRED, symbol_short!("issued")),
            (EVENT_VERSION, id.clone(), subject, issuer, credential_type, expires_at),
        );
        Ok(id)
    }

    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) -> Result<(), ContractError> {
        issuer.require_auth();
        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env.storage().persistent().get(&key).ok_or(ContractError::CredentialNotFound)?;
        if cred.issuer != issuer {
            return Err(ContractError::UnauthorizedIssuer);
        }
        if cred.revoked {
            return Err(ContractError::CredentialRevoked);
        }
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        env.events().publish((CRED, symbol_short!("revoked")), (EVENT_VERSION, credential_id, issuer));
        Ok(())
    }

    /// Atomically revoke multiple credentials in a single transaction.
    ///
    /// Issue #602: batch revocation endpoint capped at 50 IDs to stay within
    /// Soroban instruction limits. Any invalid credential ID (not found, already
    /// revoked, or issued by a different issuer) causes the entire transaction to
    /// fail — no partial revocations are written.
    ///
    /// # Errors
    /// - [`ContractError::BatchTooLarge`] if `ids` contains more than 50 entries.
    /// - [`ContractError::CredentialNotFound`] if any ID does not exist in storage.
    /// - [`ContractError::UnauthorizedIssuer`] if any credential was not issued by
    ///   `issuer`.
    /// - [`ContractError::CredentialRevoked`] if any credential is already revoked.
    pub fn revoke_credentials_batch(
        env: Env,
        issuer: Address,
        ids: Vec<BytesN<32>>,
        reason: Symbol,
    ) -> Result<(), ContractError> {
        issuer.require_auth();
        if ids.len() > 50 {
            return Err(ContractError::BatchTooLarge);
        }
        for id in ids.iter() {
            Self::revoke_one(&env, &issuer, &id, &reason)?;
        }
        Ok(())
    }

    pub fn expire_credential(env: Env, caller: Address, credential_id: BytesN<32>) -> Result<(), ContractError> {
        caller.require_auth();
        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env.storage().persistent().get(&key).ok_or(ContractError::CredentialNotFound)?;
        if cred.revoked {
            return Err(ContractError::CredentialRevoked);
        }
        if cred.expires_at == 0 || env.ledger().timestamp() <= cred.expires_at {
            return Err(ContractError::CredentialNotExpiredYet);
        }
        env.events().publish((CRED, symbol_short!("expired")), (EVENT_VERSION, credential_id, caller));
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        Ok(())
    }

    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> Result<(), ContractError> {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => Err(ContractError::CredentialNotFound),
            Some(cred) => {
                if cred.revoked {
                    return Err(ContractError::CredentialRevoked);
                }
                let now = env.ledger().timestamp();
                if cred.expires_at > 0 && now > cred.expires_at {
                    return Err(ContractError::CredentialExpired);
                }
                let ttl = Self::ttl_for_credential(&env, cred.expires_at);
                env.storage().persistent().extend_ttl(&key, ttl, ttl);
                Ok(())
            }
        }
    }

    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, ContractError> {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => Err(ContractError::CredentialNotFound),
            Some(cred) if cred.revoked => Err(ContractError::CredentialRevoked),
            Some(cred) => {
                let ttl = Self::ttl_for_credential(&env, cred.expires_at);
                env.storage().persistent().extend_ttl(&key, ttl, ttl);
                Ok(cred)
            }
        }
    }

    pub fn verify_claims_hash(env: Env, credential_id: BytesN<32>, hash: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => false,
            Some(cred) => cred.claims_hash == hash,
        }
    }

    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::fetch_subject_creds(&env, &subject)
    }

    pub fn list_subject_credentials(
        env: Env,
        subject: Address,
        cursor: Option<u64>,
        limit: u32,
        credential_type: Option<CredentialType>,
    ) -> CredentialIdsPage {
        let all = Self::fetch_subject_creds(&env, &subject);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<BytesN<32>> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            let id = all.get(next as u32).unwrap();
            next += 1;
            let include = match &credential_type {
                None => true,
                Some(filter_type) => {
                    let key = (CRED, id.clone());
                    match env.storage().persistent().get::<_, Credential>(&key) {
                        Some(cred) => cred.credential_type == *filter_type,
                        None => false,
                    }
                }
            };
            if include {
                items.push_back(id);
                taken += 1;
            }
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        CredentialIdsPage { items, next_cursor }
    }

    pub fn get_credential_count(env: Env, subject: Address) -> u32 {
        let cnt_key = (CRED_CNT, subject);
        if env.storage().persistent().has(&cnt_key) {
            env.storage().persistent().extend_ttl(&cnt_key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&cnt_key).unwrap_or(0)
    }

    pub fn get_issuers(env: Env) -> Vec<Address> {
        Self::get_issuers_internal(&env)
    }

    pub fn list_issuers(env: Env, cursor: Option<u64>, limit: u32) -> IssuersPage {
        let all = Self::get_issuers_internal(&env);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<Address> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1;
            taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        IssuersPage { items, next_cursor }
    }

    pub fn get_issuer_credentials(env: Env, issuer: Address) -> Vec<BytesN<32>> {
        Self::fetch_issuer_creds(&env, &issuer)
    }

    pub fn list_issuer_credentials(env: Env, issuer: Address, cursor: Option<u64>, limit: u32) -> CredentialIdsPage {
        let all = Self::fetch_issuer_creds(&env, &issuer);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<BytesN<32>> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1;
            taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        CredentialIdsPage { items, next_cursor }
    }

    pub fn get_storage_stats(env: Env) -> CredentialStorageStats {
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        let total: u32 = env.storage().instance().get(&TOTAL_ISSUED_CNT).unwrap_or(0);
        CredentialStorageStats {
            total_credentials: total,
            revoked_credentials: revoked,
            active_credentials: total.saturating_sub(revoked),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Core single-credential revocation logic shared by [`Self::revoke_credential`]
    /// and [`Self::revoke_credentials_batch`]. Caller must have already called
    /// `issuer.require_auth()`.
    fn revoke_one(
        env: &Env,
        issuer: &Address,
        credential_id: &BytesN<32>,
        reason: &Symbol,
    ) -> Result<(), ContractError> {
        let key = Self::cred_key(credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::CredentialNotFound)?;
        if &cred.issuer != issuer {
            return Err(ContractError::UnauthorizedIssuer);
        }
        if cred.revoked {
            return Err(ContractError::CredentialRevoked);
        }
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        env.events().publish(
            (CRED, symbol_short!("revoked")),
            (EVENT_VERSION, credential_id.clone(), issuer.clone(), reason.clone()),
        );
        Ok(())
    }

    fn require_uninitialized(env: &Env) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        Ok(())
    }

    fn set_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&ADMIN, admin);
    }

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_issuer(env: &Env, issuer: &Address) -> Result<(), ContractError> {
        if !Self::get_issuers_internal(env).contains(issuer) {
            return Err(ContractError::UnauthorizedIssuer);
        }
        Ok(())
    }

    /// Admin-only governance override for the issuer registry cap (Issue #532).
    ///
    /// `new_max` must not exceed [`ABSOLUTE_MAX_ISSUERS`]. Emits
    /// `admin_config_changed` on success.
    pub fn set_max_issuers(env: Env, admin: Address, new_max: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if new_max == 0 || new_max > ABSOLUTE_MAX_ISSUERS {
            return Err(ContractError::MaxIssuersReached);
        }
        env.storage().instance().set(&MAX_ISSUERS_KEY, &new_max);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("cfgchg")),
            (EVENT_VERSION, admin, new_max),
        );
        Ok(())
    }

    /// Current effective issuer cap: the admin-configured value if set via
    /// [`Self::set_max_issuers`], otherwise the default [`MAX_ISSUERS`].
    fn effective_max_issuers(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&MAX_ISSUERS_KEY)
            .unwrap_or(MAX_ISSUERS)
    }

    fn get_issuers_internal(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&ISSUER).unwrap_or_else(|| Vec::new(env))
    }

    /// Derives the deterministic credential ID as
    /// `sha256(issuer_xdr || subject_xdr || type_tag || nonce)`. `nonce` is the
    /// 1-based issuance count for this (issuer, subject, credential_type)
    /// triple (see [`Self::nonce_key`]), so re-issuing after a revocation
    /// always produces a fresh ID instead of colliding with the prior record.
    fn derive_id(
        env: &Env,
        issuer: &Address,
        subject: &Address,
        credential_type: &CredentialType,
        nonce: u64,
    ) -> BytesN<32> {
    fn derive_id(env: &Env, issuer: &Address, subject: &Address, credential_type: &CredentialType) -> BytesN<32> {
        let type_tag: u8 = match credential_type {
            CredentialType::Kyc => 0,
            CredentialType::Reputation => 1,
            CredentialType::Achievement => 2,
            CredentialType::Custom => 3,
        };
        let mut data = Bytes::new(env);
        data.append(&issuer.clone().to_xdr(env));
        data.append(&subject.clone().to_xdr(env));
        data.push_back(type_tag);
        data.extend_from_array(&nonce.to_be_bytes());
        env.crypto().sha256(&data).into()
    }

    fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (CRED, id.clone())
    }

    fn nonce_key(
        env: &Env,
        issuer: &Address,
        subject: &Address,
        credential_type: &CredentialType,
    ) -> (Symbol, BytesN<32>) {
        let type_tag: u8 = match credential_type {
            CredentialType::Kyc => 0,
            CredentialType::Reputation => 1,
            CredentialType::Achievement => 2,
            CredentialType::Custom => 3,
        };
        let mut data = Bytes::new(env);
        data.append(&issuer.clone().to_xdr(env));
        data.append(&subject.clone().to_xdr(env));
        data.push_back(type_tag);
        (ISS_NONCE, env.crypto().sha256(&data).into())
    }

    fn subject_key(subject: &Address) -> (Symbol, Address) {
        (SUBJECT, subject.clone())
    }

    fn issuer_creds_key(issuer: &Address) -> (Symbol, Address) {
        (ISSUER_CREDS, issuer.clone())
    }

    fn fetch_subject_creds(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
        let key = Self::subject_key(subject);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(env))
    }

    fn fetch_issuer_creds(env: &Env, issuer: &Address) -> Vec<BytesN<32>> {
        let key = Self::issuer_creds_key(issuer);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(env))
    }

    fn ttl_for_credential(env: &Env, expires_at: u64) -> u32 {
        if expires_at == 0 {
            return TTL_MAX;
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            return TTL_MIN;
        }
        let ledgers = ((expires_at - now) / 5) as u32;
        ledgers.min(TTL_MAX).max(TTL_MIN)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Bytes, Env, Map, String};

    struct MockIdentityRegistry;
    #[contractimpl]
    impl MockIdentityRegistry {
        pub fn has_active_did(_env: Env, _controller: Address) -> bool { true }
    }

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let registry_id = env.register_contract(None, MockIdentityRegistry);
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &registry_id);
        (env, admin, client)
    }

    fn issue_kyc(env: &Env, client: &CredentialManagerClient, issuer: &Address, subject: &Address) -> BytesN<32> {
        client.issue_credential(
            issuer, subject, &CredentialType::Kyc,
            &Map::new(env), &BytesN::from_array(env, &[1u8; 32]),
            &Bytes::from_array(env, &[0u8; 64]), &0u64, &None,
        )
    }

    #[test]
    fn test_ping_returns_version() {
        let env = Env::default();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        assert_eq!(client.ping(), CONTRACT_VERSION);
    }

    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.verify_credential(&cred_id);
    }

    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.revoke_credential(&issuer, &cred_id);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialRevoked)));
    }

    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialExpired)));
    }

    #[test]
    fn test_duplicate_credential_rejected() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        issue_kyc(&env, &client, &issuer, &subject);
        let result = client.try_issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &None,
        );
        assert_eq!(result, Err(Ok(ContractError::CredentialAlreadyExists)));
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let (env, admin, client) = setup();
        let dummy_registry = Address::generate(&env);
        assert_eq!(client.try_initialize(&admin, &dummy_registry), Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_register_schema_and_issue() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let schema_hash = BytesN::from_array(&env, &[99u8; 32]);

        // Issuing with unregistered schema returns SchemaNotFound
        let result = client.try_issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &Some(schema_hash.clone()),
        );
        assert_eq!(result, Err(Ok(ContractError::SchemaNotFound)));

        // Register schema then issue succeeds
        client.register_schema(&issuer, &schema_hash);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &Some(schema_hash),
        );
        client.verify_credential(&cred_id);
    }

    #[test]
    fn test_schema_optional_no_schema_works() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        // No schema_hash — must work as before
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.verify_credential(&cred_id);
    }

    /// Re-issuing after a revocation must not overwrite the original credential's
    /// storage record: the two IDs must differ and both must remain independently
    /// resolvable — the old one still revoked, the new one active. See issue #467.
    #[test]
    fn test_reissue_after_revoke_does_not_overwrite_original() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let original_id = issue_kyc(&env, &client, &issuer, &subject);
        client.revoke_credential(&issuer, &original_id);

        let new_id = issue_kyc(&env, &client, &issuer, &subject);

        assert_ne!(original_id, new_id);

        // The original record must still exist and still be revoked, untouched
        // by the new issuance (get_credential errors CredentialRevoked rather
        // than CredentialNotFound, proving the record wasn't wiped/overwritten).
        let original_result = client.try_get_credential(&original_id);
        assert_eq!(original_result, Err(Ok(ContractError::CredentialRevoked)));

        // The new record is a fresh, active credential.
        let fresh = client.get_credential(&new_id);
        assert!(!fresh.revoked);
        assert_eq!(fresh.id, new_id);
    }

    #[test]
    fn test_register_schema_rejects_zero_hash() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        client.add_issuer(&issuer);
        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_register_schema(&issuer, &zero_hash);
        assert_eq!(result, Err(Ok(ContractError::InvalidSchemaHash)));
    }

    #[test]
    fn test_set_max_issuers_allows_admin_override() {
        let (env, admin, client) = setup();
        assert_eq!(client.get_max_issuers(), MAX_ISSUERS);

        client.set_max_issuers(&admin, &1);
        let issuer_a = Address::generate(&env);
        let issuer_b = Address::generate(&env);
        client.add_issuer(&issuer_a);
        assert_eq!(
            client.try_add_issuer(&issuer_b),
            Err(Ok(ContractError::MaxIssuersReached))
        );

        client.set_max_issuers(&admin, &2);
        client.add_issuer(&issuer_b);
        assert_eq!(client.get_issuers().len(), 2);
    }

    #[test]
    fn test_set_max_issuers_enforces_absolute_ceiling() {
        let (_env, admin, client) = setup();
        assert_eq!(
            client.try_set_max_issuers(&admin, &(ABSOLUTE_MAX_ISSUERS + 1)),
            Err(Ok(ContractError::InvalidMaxIssuers))
        );
        assert_eq!(
            client.try_set_max_issuers(&admin, &0),
            Err(Ok(ContractError::InvalidMaxIssuers))
        );
        client.set_max_issuers(&admin, &ABSOLUTE_MAX_ISSUERS);
        assert_eq!(client.get_max_issuers(), ABSOLUTE_MAX_ISSUERS);
    }

    #[test]
    fn test_set_max_issuers_rejects_non_admin() {
        let (env, _admin, client) = setup();
        let attacker = Address::generate(&env);
        assert_eq!(
            client.try_set_max_issuers(&attacker, &200),
            Err(Ok(ContractError::Unauthorized))
        );
    }

    #[test]
    fn test_expire_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let caller = Address::generate(&env);
        client.add_issuer(&issuer);

        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );

        // Before expiry returns CredentialNotExpiredYet
        assert_eq!(
            client.try_expire_credential(&caller, &cred_id),
            Err(Ok(ContractError::CredentialNotExpiredYet))
        );

        // After expiry succeeds and marks credential expired
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        client.expire_credential(&caller, &cred_id);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialRevoked)));
    }

    #[test]
    fn test_expire_already_revoked() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let caller = Address::generate(&env);
        client.add_issuer(&issuer);

        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );
        client.revoke_credential(&issuer, &cred_id);
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        assert_eq!(
            client.try_expire_credential(&caller, &cred_id),
            Err(Ok(ContractError::CredentialRevoked))
        );
    }

    #[test]
    fn test_list_subject_credentials_paginates() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        for ct in [CredentialType::Kyc, CredentialType::Reputation, CredentialType::Achievement] {
            client.issue_credential(
                &issuer, &subject, &ct,
                &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
                &Bytes::from_array(&env, &[0u8; 64]), &0u64, &None,
            );
        }
        let page1 = client.list_subject_credentials(&subject, &None, &2, &None);
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.next_cursor, Some(2));
        let page2 = client.list_subject_credentials(&subject, &page1.next_cursor, &2, &None);
        assert_eq!(page2.items.len(), 1);
        assert_eq!(page2.next_cursor, None);
    }

    #[test]
    fn test_storage_key_symbols_are_unique() {
        let keys = [ADMIN, ISSUER, CRED, SUBJECT, CRED_CNT, REVOKED_CNT, ISSUER_CREDS, SCHEMA];
        for (i, left) in keys.iter().enumerate() {
            for right in keys.iter().skip(i + 1) {
                assert_ne!(left, right);
            }
        }
    }

    #[test]
    fn test_error_variants() {
        let (env, admin, client) = setup();

        assert_eq!(client.try_initialize(&admin), Err(Ok(CredentialError::AlreadyInitialized)));

        let fake_id = BytesN::from_array(&env, &[1u8; 32]);
        assert_eq!(client.try_get_credential(&fake_id), Err(Ok(CredentialError::NotFound)));

        let rando = Address::generate(&env);
        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        assert_eq!(
            client.try_issue_credential(&rando, &rando, &CredentialType::Kyc, &claims, &sig, &0u64),
            Err(Ok(CredentialError::NotAnIssuer))
        );
    }

    /// Ring-buffer eviction: when issuer index reaches MAX_ISSUER_CREDS,
    /// issuing the (MAX_ISSUER_CREDS + 1)th credential drops the oldest entry.
    #[test]
    fn test_issuer_credentials_ring_buffer_eviction() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        client.add_issuer(&issuer);

        // Issue MAX_ISSUER_CREDS credentials from different subjects
        let mut first_id = None;
        for i in 0..MAX_ISSUER_CREDS {
            let subject = Address::generate(&env);
            let id = issue_kyc(&env, &client, &issuer, &subject);
            if i == 0 {
                first_id = Some(id);
            }
        }

        // limit=0 → caller wants the default page size (PAGE_CAP=100). All 3
        // credentials fit in one page.
        let page = client.list_subject_credentials(&subject, &None, &0, &None);
        assert_eq!(page.items.len(), 3);
        assert_eq!(page.next_cursor, None);
    }

    /// Storage namespace symbols must be pairwise distinct.
    #[test]
    fn test_storage_key_symbols_are_unique() {
        let keys = [
            ADMIN,
            ISSUER,
            CRED,
            SUBJECT,
            CRED_CNT,
            REVOKED_CNT,
            ISSUER_CREDS,
            ISS_NONCE,
        ];
        for (i, left) in keys.iter().enumerate() {
            for right in keys.iter().skip(i + 1) {
                assert_ne!(left, right);
        // Index should be at MAX_ISSUER_CREDS
        let creds_before = client.get_issuer_credentials(&issuer);
        assert_eq!(creds_before.len(), MAX_ISSUER_CREDS as u32);

        // Issue one more credential — should not panic and index stays at MAX_ISSUER_CREDS
        let new_subject = Address::generate(&env);
        let _new_id = issue_kyc(&env, &client, &issuer, &new_subject);

        let creds_after = client.get_issuer_credentials(&issuer);
        assert_eq!(creds_after.len(), MAX_ISSUER_CREDS as u32);

        // The first credential ID should have been evicted (removed from head)
        if let Some(first) = first_id {
            // Verify first_id is NOT in the list after eviction
            let mut found = false;
            for cred_id in creds_after.iter() {
                if cred_id == first {
                    found = true;
                    break;
                }
            }
            assert!(!found, "First credential ID should have been evicted from the index");
        }
    }
}
