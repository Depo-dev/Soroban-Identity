//! Fuzz target: `issue_credential` with arbitrary claims and expiry values.
//!
//! Exercises the credential-manager contract with arbitrary claim maps,
//! expiry timestamps (including boundary values like 0, u64::MAX, and values
//! near the current ledger timestamp), and all four `CredentialType` variants.
//!
//! The goal is to surface panics, arithmetic overflows in expiry arithmetic,
//! or storage key collisions that deterministic unit tests miss.
//!
//! Run with cargo-fuzz:
//!   cargo fuzz run fuzz_issue_credential -- -max_total_time=60
#![no_main]

use arbitrary::Arbitrary;
use credential_manager::{CredentialManager, CredentialManagerClient, CredentialType};
use identity_registry::{IdentityRegistry, IdentityRegistryClient};
use soroban_sdk::{
    testutils::Address as _,
    Bytes, BytesN, Env, Map, String as SorobanString,
};

#[derive(Arbitrary, Debug)]
struct FuzzString {
    data: Vec<u8>,
}

impl FuzzString {
    fn to_soroban(&self, env: &Env) -> SorobanString {
        let limited = if self.data.len() > 256 { &self.data[..256] } else { &self.data };
        let s = std::string::String::from_utf8_lossy(limited).into_owned();
        SorobanString::from_str(env, &s)
    }
}

/// Map an arbitrary byte to one of the four CredentialType variants.
fn pick_credential_type(b: u8) -> CredentialType {
    match b % 4 {
        0 => CredentialType::Kyc,
        1 => CredentialType::Reputation,
        2 => CredentialType::Achievement,
        _ => CredentialType::Custom,
    }
}

/// The structured fuzz input for the `issue_credential` target.
#[derive(Arbitrary, Debug)]
struct IssueCredentialInput {
    /// Claim key-value pairs to embed in the credential
    claims: Vec<(FuzzString, FuzzString)>,
    /// Raw 32-byte claims hash
    claims_hash: [u8; 32],
    /// Raw 64-byte signature (the test harness mocks auth so validity is irrelevant)
    signature: [u8; 64],
    /// Expiry timestamp in seconds (0 = no expiry; fuzz covers edge cases)
    expires_at: u64,
    /// Selector for which CredentialType to use
    credential_type_sel: u8,
    /// Whether to attempt revocation after issuance
    do_revoke: bool,
    /// Whether to attempt verify after issuance
    do_verify: bool,
}

libfuzzer_sys::fuzz_target!(|input: IssueCredentialInput| {
    let env = Env::default();
    env.mock_all_auths();

    // ── Set up identity-registry (required by credential-manager initialize) ──
    let identity_contract = env.register_contract(None, IdentityRegistry);
    let identity_client = IdentityRegistryClient::new(&env, &identity_contract);
    let admin = soroban_sdk::Address::generate(&env);
    let _ = identity_client.try_initialize(&admin);

    // ── Set up credential-manager ─────────────────────────────────────────────
    let cred_contract = env.register_contract(None, CredentialManager);
    let cred_client = CredentialManagerClient::new(&env, &cred_contract);
    let _ = cred_client.try_initialize(&admin, &identity_contract);

    // Register a trusted issuer
    let issuer = soroban_sdk::Address::generate(&env);
    let _ = cred_client.try_add_issuer(&issuer);

    let subject = soroban_sdk::Address::generate(&env);

    // Build the claims map
    let mut claims: Map<SorobanString, SorobanString> = Map::new(&env);
    for (k, v) in input.claims.iter().take(12) {
        claims.set(k.to_soroban(&env), v.to_soroban(&env));
    }

    let claims_hash: BytesN<32> = BytesN::from_array(&env, &input.claims_hash);
    let signature: Bytes = Bytes::from_slice(&env, &input.signature);
    let cred_type = pick_credential_type(input.credential_type_sel);

    // Issue the credential — must never panic regardless of inputs
    let result = cred_client.try_issue_credential(
        &issuer,
        &subject,
        &cred_type,
        &claims,
        &claims_hash,
        &signature,
        &input.expires_at,
        &None,
    );

    if let Ok(Ok(credential_id)) = result {
        // Get the credential back — should not panic
        let _ = cred_client.try_get_credential(&credential_id);

        // Verify the credential
        if input.do_verify {
            let _ = cred_client.try_verify_credential(&credential_id);
        }

        // Optionally revoke
        if input.do_revoke {
            let _ = cred_client.try_revoke_credential(&issuer, &credential_id);

            // After revocation, verify should indicate revoked status
            let verify_result = cred_client.try_verify_credential(&credential_id);
            // We don't assert a specific error here — just ensure it doesn't panic
            let _ = verify_result;
        }
    }
});
