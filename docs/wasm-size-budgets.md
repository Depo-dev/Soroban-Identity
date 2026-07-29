# WASM Size Budget Enforcement

Soroban smart contracts are deployed as WASM binaries. Larger contracts cost more to deploy and may hit network size limits. This project enforces size budgets in CI to prevent bloat accumulation.

## Size Budgets

Current budgets (configured in `.github/workflows/contracts-ci.yml`):

| Contract | Budget | Notes |
|----------|--------|-------|
| identity-registry | 64 KB | DID registration and resolution |
| credential-manager | 64 KB | Credential issuance and verification |
| reputation | 64 KB | Reputation tracking |

## CI Enforcement

The `scripts/check_wasm_size.sh` script runs after contract builds in CI:

1. Builds all contracts with `cargo build --release --target wasm32-unknown-unknown`
2. Checks each `.wasm` file size against its budget
3. **Fails the build** if any contract exceeds its budget
4. Passes if all contracts are within budget

### Example CI Output

**Pass:**
```
========================================
  WASM Size Budget Check
========================================

identity-registry        :  45678 bytes ( 44 KB) /  65536 bytes ( 64 KB) - ✅ PASS (69%)
credential-manager       :  52340 bytes ( 51 KB) /  65536 bytes ( 64 KB) - ✅ PASS (79%)
reputation               :  38912 bytes ( 38 KB) /  65536 bytes ( 64 KB) - ✅ PASS (59%)

========================================
✅ All contracts within size budget
========================================
```

**Fail:**
```
========================================
  WASM Size Budget Check
========================================

identity-registry        :  68000 bytes ( 66 KB) /  65536 bytes ( 64 KB) - ❌ FAIL (103%)
  ⚠️  Contract exceeds budget by 2464 bytes
credential-manager       :  52340 bytes ( 51 KB) /  65536 bytes ( 64 KB) - ✅ PASS (79%)
reputation               :  38912 bytes ( 38 KB) /  65536 bytes ( 64 KB) - ✅ PASS (59%)

========================================
❌ WASM size budget check FAILED

One or more contracts exceed their size budget.
To fix this:
  1. Review recent changes for code bloat
  2. Consider removing unused dependencies
  3. Enable link-time optimization (LTO)
  4. Use cargo-bloat to identify large functions
========================================
```

## Adjusting Budgets

Budgets are defined as environment variables in `.github/workflows/contracts-ci.yml`:

```yaml
env:
  IDENTITY_REGISTRY_SIZE_BUDGET: 65536
  CREDENTIAL_MANAGER_SIZE_BUDGET: 65536
  REPUTATION_SIZE_BUDGET: 65536
```

To change a budget:

1. Edit the env var in `contracts-ci.yml`
2. Commit with a clear justification (e.g., "Increase credential-manager budget to 80KB for new claim validation logic")
3. Open a PR for review

**Do not increase budgets without understanding why the contract grew.**

## Running Locally

Check WASM sizes before pushing:

```bash
# Build contracts
cd contracts
cargo build --target wasm32-unknown-unknown --release

# Check sizes
cd ..
./scripts/check_wasm_size.sh
```

### Custom Budgets Locally

Override budgets with environment variables:

```bash
IDENTITY_REGISTRY_SIZE_BUDGET=70000 \
CREDENTIAL_MANAGER_SIZE_BUDGET=70000 \
REPUTATION_SIZE_BUDGET=70000 \
./scripts/check_wasm_size.sh
```

## Reducing Contract Size

If a contract exceeds its budget:

### 1. Enable Link-Time Optimization (LTO)

Add to contract's `Cargo.toml`:

```toml
[profile.release]
lto = true
opt-level = "z"  # Optimize for size
codegen-units = 1
strip = true
```

### 2. Analyze with cargo-bloat

```bash
cargo install cargo-bloat
cd contracts/identity-registry
cargo bloat --release --target wasm32-unknown-unknown
```

Identifies largest functions contributing to binary size.

### 3. Remove Unused Dependencies

```bash
cargo install cargo-udeps
cargo +nightly udeps --target wasm32-unknown-unknown
```

### 4. Review Recent Changes

Use `git diff` to identify what changed:

```bash
# Compare WASM sizes between commits
git show HEAD~1:contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm | wc -c
git show HEAD:contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm | wc -c
```

### 5. Audit Dependencies

Check dependency tree:

```bash
cargo tree --target wasm32-unknown-unknown
```

Look for:
- Duplicate dependencies (different versions)
- Heavy crates pulled transitively
- Feature flags that could be disabled

## Why Size Matters

- **Deployment Cost**: Stellar charges based on transaction size
- **Network Limits**: Soroban has maximum transaction size limits
- **Performance**: Larger contracts take longer to load and instantiate
- **Maintainability**: Bloat often correlates with complexity

## References

- [Soroban WASM Optimization](https://soroban.stellar.org/docs/learn/optimize-contracts)
- [Rust WASM Size Optimization](https://rustwasm.github.io/book/reference/code-size.html)
- [cargo-bloat Documentation](https://github.com/RazrFalcon/cargo-bloat)
