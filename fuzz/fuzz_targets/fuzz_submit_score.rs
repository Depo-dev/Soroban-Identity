//! Fuzz target: `submit_score` with boundary delta values.
//!
//! Exercises the reputation contract's `submit_score` function with arbitrary
//! score deltas, including i64::MIN, i64::MAX, and values that would cause
//! overflow when accumulated. The goal is to surface arithmetic panics or
//! unexpected behavior that deterministic unit tests miss.
//!
//! Run with cargo-fuzz:
//!   cargo fuzz run fuzz_submit_score -- -max_total_time=60
#![no_main]

use arbitrary::Arbitrary;
use reputation::{Reputation, ReputationClient};
use soroban_sdk::{testutils::Address as _, Env, String as SorobanString};

#[derive(Arbitrary, Debug)]
struct FuzzString {
    data: Vec<u8>,
}

impl FuzzString {
    fn to_soroban(&self, env: &Env) -> SorobanString {
        let limited = if self.data.len() > 128 { &self.data[..128] } else { &self.data };
        let s = std::string::String::from_utf8_lossy(limited).into_owned();
        SorobanString::from_str(env, &s)
    }
}

/// The structured fuzz input for the `submit_score` target.
#[derive(Arbitrary, Debug)]
struct SubmitScoreInput {
    /// The score delta to submit (can be negative, zero, or positive)
    delta: i64,
    /// Arbitrary reason string
    reason: FuzzString,
    /// Number of sequential submissions from the same reporter
    /// (to test accumulation and overflow edge cases)
    num_submissions: u8,
}

libfuzzer_sys::fuzz_target!(|input: SubmitScoreInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, Reputation);
    let client = ReputationClient::new(&env, &contract_id);

    let admin = soroban_sdk::Address::generate(&env);
    // Initialize with a permissive default threshold (0 score, 0 reporters)
    let _ = client.try_initialize(&admin, &0, &0);

    // Register a reporter
    let reporter = soroban_sdk::Address::generate(&env);
    let _ = client.try_add_reporter(&reporter);

    let subject = soroban_sdk::Address::generate(&env);
    let reason = input.reason.to_soroban(&env);

    // Submit the score 1-10 times (bounded to keep fuzz runs fast)
    let num_submissions = (input.num_submissions % 10).max(1) as usize;
    for _ in 0..num_submissions {
        // submit_score must never panic regardless of delta
        let _ = client.try_submit_score(&reporter, &subject, &input.delta, &reason);
    }

    // After submissions, get_reputation should not panic
    let _ = client.try_get_reputation(&subject);

    // passes_sybil_check with various thresholds should not panic
    let _ = client.try_passes_sybil_check(&subject, &i64::MIN, &0);
    let _ = client.try_passes_sybil_check(&subject, &0, &0);
    let _ = client.try_passes_sybil_check(&subject, &i64::MAX, &100);

    // get_history should not panic
    let _ = client.try_get_history(&subject, &reporter);
});
