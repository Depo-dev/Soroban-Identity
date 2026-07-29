//! Fuzz target: `create_did` with arbitrary metadata maps.
//!
//! Exercises the identity-registry `create_did`, `update_did`, `resolve_did`,
//! `did_exists`, and `deactivate_did` functions with arbitrary string inputs.
//! The goal is to surface unexpected panics, integer overflows, or storage key
//! collisions that deterministic unit tests would miss.
//!
//! Run with cargo-fuzz:
//!   cargo fuzz run fuzz_create_did -- -max_total_time=60
#![no_main]

use arbitrary::Arbitrary;
use identity_registry::{IdentityRegistry, IdentityRegistryClient};
use soroban_sdk::{testutils::Address as _, Env, Map, String as SorobanString};

/// A fuzz-generated string that safely converts to Soroban's `String` type.
#[derive(Arbitrary, Debug)]
struct FuzzString {
    data: Vec<u8>,
}

impl FuzzString {
    /// Convert to a Soroban SDK string, replacing non-UTF-8 bytes with the
    /// replacement character sequence to keep the length bounded.
    fn to_soroban(&self, env: &Env) -> SorobanString {
        // Cap at 300 bytes to keep individual values well within storage limits
        let limited = if self.data.len() > 300 {
            &self.data[..300]
        } else {
            &self.data
        };
        let s = std::string::String::from_utf8_lossy(limited).into_owned();
        SorobanString::from_str(env, &s)
    }
}

/// The structured fuzz input for the `create_did` target.
#[derive(Arbitrary, Debug)]
struct CreateDidInput {
    /// Metadata key-value pairs to pass to `create_did`.
    /// Limited to 15 entries to avoid hitting the contract's MetadataTooLarge
    /// guard on every run (limit is 10 — values above that should produce a
    /// graceful error, not a panic).
    entries: Vec<(FuzzString, FuzzString)>,
    /// Whether to attempt an `update_did` after creation.
    do_update: bool,
    /// Whether to attempt a `deactivate_did` after creation.
    do_deactivate: bool,
}

libfuzzer_sys::fuzz_target!(|input: CreateDidInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, IdentityRegistry);
    let client = IdentityRegistryClient::new(&env, &contract_id);

    let admin = soroban_sdk::Address::generate(&env);
    // Initialize — ignore error if already initialized (not possible in a
    // fresh Env but guards against any future stateful harness re-use)
    let _ = client.try_initialize(&admin);

    let controller = soroban_sdk::Address::generate(&env);

    // Build metadata from fuzz input
    let mut metadata: Map<SorobanString, SorobanString> = Map::new(&env);
    for (k, v) in input.entries.iter().take(15) {
        metadata.set(k.to_soroban(&env), v.to_soroban(&env));
    }

    // The main call under test — must never panic regardless of inputs
    let result = client.try_create_did(&controller, &metadata);

    if result.is_ok() {
        // Existence check — must return true for a freshly-created DID
        assert!(
            client.did_exists(&controller),
            "did_exists must return true after successful create_did"
        );
        assert!(
            client.has_active_did(&controller),
            "has_active_did must return true after successful create_did"
        );

        // Resolve — must succeed for an active DID
        let doc = client.resolve_did(&controller);
        assert!(doc.active);
        assert_eq!(doc.controller, controller);

        // Optionally update metadata
        if input.do_update {
            let mut update_meta: Map<SorobanString, SorobanString> = Map::new(&env);
            // Use at least one entry so update_did doesn't return EmptyMetadata
            if let Some((k, v)) = input.entries.first() {
                update_meta.set(k.to_soroban(&env), v.to_soroban(&env));
            } else {
                update_meta.set(
                    SorobanString::from_str(&env, "k"),
                    SorobanString::from_str(&env, "v"),
                );
            }
            let _ = client.try_update_did(&controller, &update_meta);
        }

        // Optionally deactivate
        if input.do_deactivate {
            let _ = client.try_deactivate_did(&controller);
            // After deactivation: did_exists still true, has_active_did false
            assert!(
                client.did_exists(&controller),
                "did_exists must still return true after deactivate_did"
            );
            assert!(
                !client.has_active_did(&controller),
                "has_active_did must return false after deactivate_did"
            );
        }
    } else {
        // Creation failed — the DID must not exist
        assert!(
            !client.did_exists(&controller),
            "did_exists must return false when create_did failed"
        );
    }
});
