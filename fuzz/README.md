# Fuzz Testing for Soroban Identity Contracts

This directory contains [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) targets for the Soroban Identity smart contracts. Fuzzing uses [libFuzzer](https://llvm.org/docs/LibFuzzer.html) to generate arbitrary inputs and surface unexpected panics, integer overflows, or storage key collisions that deterministic unit tests would miss.

## Prerequisites

Install `cargo-fuzz`:

```bash
cargo install cargo-fuzz
```

Requires a nightly Rust toolchain:

```bash
rustup install nightly
```

## Available Fuzz Targets

### 1. `fuzz_create_did`

Exercises `identity-registry::create_did` with arbitrary metadata maps.

**What it tests:**
- Metadata maps with random keys, values, and entry counts
- Boundary cases (empty maps, max-size maps, oversized strings)
- Sequential operations: `create_did` → `update_did` → `deactivate_did`
- Invariants: `did_exists` and `has_active_did` consistency

**Run:**
```bash
cd fuzz
cargo +nightly fuzz run fuzz_create_did -- -max_total_time=60
```

### 2. `fuzz_issue_credential`

Exercises `credential-manager::issue_credential` with arbitrary claims and expiry values.

**What it tests:**
- Claim maps with random keys and values
- Expiry timestamps including edge cases (0, `u64::MAX`, near-current values)
- All four `CredentialType` variants (`Kyc`, `Reputation`, `Achievement`, `Custom`)
- Revocation and verification after issuance
- Arithmetic overflows in expiry comparisons

**Run:**
```bash
cd fuzz
cargo +nightly fuzz run fuzz_issue_credential -- -max_total_time=60
```

### 3. `fuzz_submit_score`

Exercises `reputation::submit_score` with boundary delta values.

**What it tests:**
- Score deltas including `i64::MIN`, `i64::MAX`, zero, and random values
- Accumulation of multiple score submissions (potential overflow)
- Reason strings of arbitrary length and content
- Sybil check thresholds at boundary values
- History retrieval after arbitrary submissions

**Run:**
```bash
cd fuzz
cargo +nightly fuzz run fuzz_submit_score -- -max_total_time=60
```

## Running All Targets

To run all fuzz targets sequentially with a time budget of 60 seconds each:

```bash
cd fuzz
for target in fuzz_create_did fuzz_issue_credential fuzz_submit_score; do
  echo "Running $target..."
  cargo +nightly fuzz run $target -- -max_total_time=60 || true
done
```

## Interpreting Results

### No crashes

If fuzzing completes without finding crashes, you'll see output like:

```
#2097152 DONE   cov: 534 ft: 1234 corp: 56/12Kb exec/s: 34952 rss: 128Mb
```

This means libFuzzer executed 2,097,152 inputs and found no panics.

### Crash found

If fuzzing discovers a crash, it will:
1. Save the input that caused the crash to `fuzz/artifacts/<target>/crash-<hash>`
2. Print a stack trace showing the panic location

**Example:**
```
#42 CRASHED: <error message>
artifact_prefix='fuzz/artifacts/fuzz_create_did/'; Test unit written to crash-abc123
```

To reproduce the crash:

```bash
cargo +nightly fuzz run fuzz_create_did fuzz/artifacts/fuzz_create_did/crash-abc123
```

### Minimizing crashes

If a crash is found, you can minimize the input to the smallest test case that still triggers the issue:

```bash
cargo +nightly fuzz tmin fuzz_create_did fuzz/artifacts/fuzz_create_did/crash-abc123
```

## Coverage Reports

Generate a coverage report showing which lines were exercised:

```bash
cargo +nightly fuzz coverage fuzz_create_did
cargo cov -- show target/x86_64-unknown-linux-gnu/coverage/x86_64-unknown-linux-gnu/release/fuzz_create_did \
    --format=html --instr-profile=fuzz/coverage/fuzz_create_did/coverage.profdata > coverage.html
```

Open `coverage.html` in a browser to see line-by-line coverage for the contract code.

## CI Integration

Add fuzz targets to your CI pipeline with a time-boxed budget (e.g., 60 seconds per target) to catch regressions:

**.github/workflows/fuzz.yml**:

```yaml
name: Fuzz Testing
on: [push, pull_request]

jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: dtolnay/rust-toolchain@nightly
      - run: cargo install cargo-fuzz
      - name: Fuzz create_did
        run: cd fuzz && cargo +nightly fuzz run fuzz_create_did -- -max_total_time=60 -rss_limit_mb=2048
      - name: Fuzz issue_credential
        run: cd fuzz && cargo +nightly fuzz run fuzz_issue_credential -- -max_total_time=60 -rss_limit_mb=2048
      - name: Fuzz submit_score
        run: cd fuzz && cargo +nightly fuzz run fuzz_submit_score -- -max_total_time=60 -rss_limit_mb=2048
      - name: Upload artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: fuzz-artifacts
          path: fuzz/artifacts/
```

## Corpus Management

libFuzzer builds a corpus of interesting inputs as it runs. The corpus is stored in `fuzz/corpus/<target>/` and can be re-used across runs to maintain coverage:

```bash
# Run with existing corpus
cargo +nightly fuzz run fuzz_create_did

# Add seed inputs (e.g., hand-crafted edge cases)
echo "your-seed-input" > fuzz/corpus/fuzz_create_did/seed1
```

Commit useful corpus entries to version control so that future runs start with better coverage.

## Troubleshooting

### Out of memory

If fuzzing hits memory limits, increase `rss_limit_mb`:

```bash
cargo +nightly fuzz run fuzz_create_did -- -rss_limit_mb=4096
```

### Slow progress

If fuzzing makes slow progress (low `exec/s`), try:

- Reducing the time budget (`-max_total_time=30`)
- Running with more cores (`-workers=4`)
- Profiling the target to identify slow paths

### False positives

If fuzzing finds a "crash" that is actually a graceful contract error (e.g., `MetadataTooLarge`), verify that the contract returns `Result<_, ContractError>` and does not panic. Fuzz targets should use `try_*` methods and ignore expected errors.

## References

- [cargo-fuzz book](https://rust-fuzz.github.io/book/cargo-fuzz.html)
- [libFuzzer documentation](https://llvm.org/docs/LibFuzzer.html)
- [Arbitrary crate](https://docs.rs/arbitrary/latest/arbitrary/)

## Related Issues

- [#558](https://github.com/fridaypetra55-afk/Soroban-Identity/issues/558) — Add fuzz testing
- [#561](https://github.com/fridaypetra55-afk/Soroban-Identity/issues/561) — Duplicate of #558
