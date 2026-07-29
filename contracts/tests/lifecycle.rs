use credential_manager::{
    ContractError as CredentialError, CredentialManager, CredentialManagerClient, CredentialType,
};
use identity_registry::{ContractError as IdentityError, IdentityRegistry, IdentityRegistryClient};
use reputation::{ContractError as ReputationError, Reputation, ReputationClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Map, String,
};

fn register_clients(
    env: &Env,
) -> (
    IdentityRegistryClient<'_>,
    CredentialManagerClient<'_>,
    ReputationClient<'_>,
) {
    let identity_id = env.register_contract(None, IdentityRegistry);
    let credential_id = env.register_contract(None, CredentialManager);
    let reputation_id = env.register_contract(None, Reputation);

    (
        IdentityRegistryClient::new(env, &identity_id),
        CredentialManagerClient::new(env, &credential_id),
        ReputationClient::new(env, &reputation_id),
    )
}

#[test]
fn did_and_credential_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let (identity, credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    identity.initialize(&admin);
    credentials.initialize(&admin);
    reputation.initialize(&admin);

    // Create a DID before issuing credentials so the subject has an on-chain identity.
    let metadata = Map::new(&env);
    let did = identity.create_did(&subject, &metadata);
    let mut did_bytes = [0u8; 68];
    did.copy_into_slice(&mut did_bytes);
    assert_eq!(&did_bytes[..12], b"did:stellar:");

    let document = identity.resolve_did(&subject);
    assert!(document.active);
    assert_eq!(document.controller, subject);

    // Issue a KYC credential to the DID controller and verify it is usable.
    credentials.add_issuer(&issuer);
    let claims = Map::new(&env);
    let claims_hash = BytesN::from_array(&env, &[7u8; 32]);
    let signature = Bytes::from_array(&env, &[1u8; 64]);
    let credential_id = credentials.issue_credential(
        &issuer,
        &subject,
        &CredentialType::Kyc,
        &claims,
        &claims_hash,
        &signature,
        &0u64,
    );

    assert!(credentials.verify_credential(&credential_id));
    let credential = credentials.get_credential(&credential_id);
    assert_eq!(credential.subject, subject);
    assert_eq!(credential.issuer, issuer);

    // Revocation must immediately make the same credential fail verification.
    credentials.revoke_credential(&issuer, &credential_id);
    assert!(!credentials.verify_credential(&credential_id));
}

#[test]
fn reputation_lifecycle_and_sybil_gate() {
    let env = Env::default();
    env.mock_all_auths();

    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);

    reputation.initialize(&admin);
    reputation.add_reporter(&reporter);

    // A positive score from a trusted reporter should satisfy the sybil gate.
    let reason = String::from_str(&env, "completed onboarding");
    reputation.submit_score(&reporter, &subject, &75, &reason);
    let record = reputation.get_reputation(&subject);
    assert_eq!(record.score, 75);
    assert_eq!(record.reporter_count, 1);
    assert!(reputation.passes_sybil_check(&subject, &50, &1));

    // Advance beyond the per-reporter rate limit, then submit a penalty.
    env.ledger().with_mut(|li| li.sequence_number += 101);
    let penalty = String::from_str(&env, "fraud report");
    reputation.submit_score(&reporter, &subject, &-75, &penalty);

    let record = reputation.get_reputation(&subject);
    assert_eq!(record.score, 0);
    assert!(!reputation.passes_sybil_check(&subject, &50, &1));
}
#[test]
fn contracts_expose_ping_version() {
    let env = Env::default();
    let (identity, credentials, reputation) = register_clients(&env);

    assert_eq!(identity.ping(), 1);
    assert_eq!(credentials.ping(), 1);
    assert_eq!(reputation.ping(), 1);
}

/// End-to-end cross-contract lifecycle test (#400):
/// Deploys all three contracts in one Env, registers a DID, issues a credential
/// for that DID, submits a reputation score, and asserts final state across all
/// three contracts is consistent.
#[test]
fn cross_contract_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let identity_id = env.register_contract(None, IdentityRegistry);
    let credential_id = env.register_contract(None, CredentialManager);
    let reputation_id = env.register_contract(None, Reputation);

    let identity = IdentityRegistryClient::new(&env, &identity_id);
    let credentials = CredentialManagerClient::new(&env, &credential_id);
    let reputation = ReputationClient::new(&env, &reputation_id);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);

    // Initialize all three contracts
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity_id);
    reputation.initialize(&admin);

    // 1. Register DID in identity-registry
    let did = identity.create_did(&subject, &Map::new(&env));
    assert!(identity.has_active_did(&subject));
    let doc = identity.resolve_did(&subject);
    assert!(doc.active);
    assert_eq!(doc.controller, subject);
    let mut did_bytes = [0u8; 68];
    did.copy_into_slice(&mut did_bytes);
    assert_eq!(&did_bytes[..12], b"did:stellar:");

    // 2. Issue a credential for that DID subject in credential-manager
    credentials.add_issuer(&issuer);
    let cred_id = credentials.issue_credential(
        &issuer,
        &subject,
        &CredentialType::Kyc,
        &Map::new(&env),
        &BytesN::from_array(&env, &[0u8; 32]),
        &Bytes::from_array(&env, &[1u8; 64]),
        &0u64,
    );
    assert!(credentials.verify_credential(&cred_id));
    let cred = credentials.get_credential(&cred_id);
    assert_eq!(cred.subject, subject);

    // 3. Submit a reputation score for the same subject in reputation
    reputation.add_reporter(&reporter);
    let reason = String::from_str(&env, "kyc verified");
    reputation.submit_score(&reporter, &subject, &60, &reason);

    // Assert final state across all three contracts is consistent
    assert!(identity.has_active_did(&subject));          // DID still active
    assert!(credentials.verify_credential(&cred_id));    // credential still valid
    let rec = reputation.get_reputation(&subject);
    assert!(rec.score > 0);                              // reputation score is non-zero
    assert_eq!(rec.reporter_count, 1);
    assert!(reputation.passes_sybil_check(&subject, &50, &1));
}

// ── SC-10: negative-path coverage ───────────────────────────────────────────
//
// Each test below drives one `ContractError` variant (or an explicit panic
// path) called out in issue #546, across all three contracts.

// -- identity-registry ------------------------------------------------------

#[test]
fn create_did_twice_returns_did_already_exists() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);

    identity.create_did(&subject, &Map::new(&env));
    assert_eq!(
        identity.try_create_did(&subject, &Map::new(&env)),
        Err(Ok(IdentityError::DidAlreadyExists))
    );
}

#[test]
fn update_did_with_empty_metadata_returns_empty_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);
    identity.create_did(&subject, &Map::new(&env));

    assert_eq!(
        identity.try_update_did(&subject, &Map::new(&env)),
        Err(Ok(IdentityError::EmptyMetadata))
    );
}

#[test]
fn resolve_unknown_did_returns_did_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let stranger = Address::generate(&env);
    identity.initialize(&admin);

    assert_eq!(
        identity.try_resolve_did(&stranger),
        Err(Ok(IdentityError::DidNotFound))
    );
}

#[test]
fn update_did_after_deactivation_returns_did_deactivated() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);
    identity.create_did(&subject, &Map::new(&env));
    identity.deactivate_did(&subject);

    let mut metadata = Map::new(&env);
    metadata.set(String::from_str(&env, "k"), String::from_str(&env, "v"));
    assert_eq!(
        identity.try_update_did(&subject, &metadata),
        Err(Ok(IdentityError::DidDeactivated))
    );
}

#[test]
fn accept_admin_without_pending_returns_no_pending_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let rando = Address::generate(&env);
    identity.initialize(&admin);

    assert_eq!(
        identity.try_accept_admin(&rando),
        Err(Ok(IdentityError::NoPendingAdmin))
    );
}

#[test]
fn accept_admin_with_wrong_address_returns_not_pending_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let proposed = Address::generate(&env);
    let impostor = Address::generate(&env);
    identity.initialize(&admin);
    identity.propose_admin(&admin, &proposed);

    assert_eq!(
        identity.try_accept_admin(&impostor),
        Err(Ok(IdentityError::NotPendingAdmin))
    );
}

#[test]
fn propose_admin_before_initialize_returns_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, _credentials, _reputation) = register_clients(&env);
    let someone = Address::generate(&env);
    let proposed = Address::generate(&env);

    // Contract was registered but `initialize` was never called.
    assert_eq!(
        identity.try_propose_admin(&someone, &proposed),
        Err(Ok(IdentityError::NotInitialized))
    );
}

// -- credential-manager ------------------------------------------------------

#[test]
fn issue_credential_to_deactivated_did_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity.address);
    credentials.add_issuer(&issuer);
    identity.create_did(&subject, &Map::new(&env));
    identity.deactivate_did(&subject);

    // issue_credential panics (rather than returning a typed ContractError)
    // when the subject has no active DID.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        credentials.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[1u8; 64]),
            &0u64,
            &None,
        )
    }));
    assert!(result.is_err(), "issuing to a deactivated DID should panic");
}

#[test]
fn verify_revoked_credential_returns_credential_revoked() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity.address);
    identity.create_did(&subject, &Map::new(&env));
    credentials.add_issuer(&issuer);

    let cred_id = credentials.issue_credential(
        &issuer,
        &subject,
        &CredentialType::Kyc,
        &Map::new(&env),
        &BytesN::from_array(&env, &[9u8; 32]),
        &Bytes::from_array(&env, &[1u8; 64]),
        &0u64,
        &None,
    );
    credentials.revoke_credential(&issuer, &cred_id);

    assert_eq!(
        credentials.try_verify_credential(&cred_id),
        Err(Ok(CredentialError::CredentialRevoked))
    );
}

#[test]
fn issue_credential_by_non_issuer_returns_unauthorized_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let not_an_issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity.address);
    identity.create_did(&subject, &Map::new(&env));

    let result = credentials.try_issue_credential(
        &not_an_issuer,
        &subject,
        &CredentialType::Kyc,
        &Map::new(&env),
        &BytesN::from_array(&env, &[3u8; 32]),
        &Bytes::from_array(&env, &[1u8; 64]),
        &0u64,
        &None,
    );
    assert_eq!(result, Err(Ok(CredentialError::UnauthorizedIssuer)));
}

#[test]
fn get_unknown_credential_returns_credential_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity.address);

    let fake_id = BytesN::from_array(&env, &[0xAB; 32]);
    assert_eq!(
        credentials.try_get_credential(&fake_id),
        Err(Ok(CredentialError::CredentialNotFound))
    );
}

#[test]
fn add_issuer_beyond_cap_returns_max_issuers_reached() {
    let env = Env::default();
    env.mock_all_auths();
    let (identity, credentials, _reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    identity.initialize(&admin);
    credentials.initialize(&admin, &identity.address);

    // credential-manager's MAX_ISSUERS cap is 100.
    for _ in 0..100 {
        credentials.add_issuer(&Address::generate(&env));
    }
    let one_too_many = Address::generate(&env);
    assert_eq!(
        credentials.try_add_issuer(&one_too_many),
        Err(Ok(CredentialError::MaxIssuersReached))
    );
}

// -- reputation ---------------------------------------------------------------

#[test]
fn submit_score_with_overlong_reason_returns_reason_too_long() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);
    reputation.initialize(&admin);
    reputation.add_reporter(&reporter);

    let too_long = "a".repeat(257);
    let reason = String::from_str(&env, &too_long);
    assert_eq!(
        reputation.try_submit_score(&reporter, &subject, &10, &reason),
        Err(Ok(ReputationError::ReasonTooLong))
    );
}

#[test]
fn sybil_check_below_threshold_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);
    reputation.initialize(&admin);
    reputation.add_reporter(&reporter);

    let reason = String::from_str(&env, "single report");
    reputation.submit_score(&reporter, &subject, &80, &reason);

    // Score clears min_score, but only 1 of the 2 required reporters exist.
    assert!(!reputation.passes_sybil_check(&subject, &50, &2));
}

#[test]
fn sybil_check_default_before_threshold_set_returns_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let subject = Address::generate(&env);
    reputation.initialize(&admin);
    // set_default_threshold / update_thresholds was never called.

    assert_eq!(
        reputation.try_passes_sybil_check_default(&subject),
        Err(Ok(ReputationError::NotInitialized))
    );
}

#[test]
fn reputation_accept_admin_without_pending_returns_no_pending_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let rando = Address::generate(&env);
    reputation.initialize(&admin);

    assert_eq!(
        reputation.try_accept_admin(&rando),
        Err(Ok(ReputationError::NoPendingAdmin))
    );
}

#[test]
fn reputation_accept_admin_with_wrong_address_returns_not_pending_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let proposed = Address::generate(&env);
    let impostor = Address::generate(&env);
    reputation.initialize(&admin);
    reputation.propose_admin(&admin, &proposed);

    assert_eq!(
        reputation.try_accept_admin(&impostor),
        Err(Ok(ReputationError::NotPendingAdmin))
    );
}

#[test]
fn resolve_unknown_dispute_returns_dispute_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    reputation.initialize(&admin);

    assert_eq!(
        reputation.try_resolve_dispute(&admin, &999u32, &false),
        Err(Ok(ReputationError::DisputeNotFound))
    );
}

/// Explicit "dispute after expiry" coverage requested by #546. Note: this
/// mirrors reputation's own `test_dispute_expired` unit test, which is
/// currently failing on `main` due to a pre-existing, unrelated contract
/// instance-TTL bug (the contract instance itself gets archived in the test
/// environment when the ledger sequence is advanced this far without an
/// intervening call). Tracked separately from #545/#546.
#[test]
fn dispute_resolution_after_expiry_returns_dispute_expired() {
    let env = Env::default();
    env.mock_all_auths();
    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);
    reputation.initialize(&admin);
    reputation.add_reporter(&reporter);

    let reason = String::from_str(&env, "activity");
    reputation.submit_score(&reporter, &subject, &20, &reason);
    let dispute_id = reputation.dispute_score(&subject, &reporter, &0);

    // Advance past reputation's private DISPUTE_WINDOW_LEDGERS (17_280 ledgers).
    env.ledger().with_mut(|li| li.sequence_number += 17_281);

    assert_eq!(
        reputation.try_resolve_dispute(&admin, &dispute_id, &true),
        Err(Ok(ReputationError::DisputeExpired))
    );
}
