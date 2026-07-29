#!/usr/bin/env bash
# Check Soroban WASM contract sizes against defined budgets
set -euo pipefail

# Default size budgets in bytes (can be overridden via env vars)
IDENTITY_REGISTRY_SIZE_BUDGET="${IDENTITY_REGISTRY_SIZE_BUDGET:-65536}"  # 64KB
CREDENTIAL_MANAGER_SIZE_BUDGET="${CREDENTIAL_MANAGER_SIZE_BUDGET:-65536}"  # 64KB
REPUTATION_SIZE_BUDGET="${REPUTATION_SIZE_BUDGET:-65536}"  # 64KB

CONTRACTS_DIR="${CONTRACTS_DIR:-contracts/target/wasm32-unknown-unknown/release}"

echo "========================================"
echo "  WASM Size Budget Check"
echo "========================================"
echo ""

# Track if any contract exceeds its budget
BUDGET_EXCEEDED=0

# Function to check a single contract
check_contract() {
  local contract_name="$1"
  local wasm_file="$2"
  local budget="$3"
  
  if [[ ! -f "$wasm_file" ]]; then
    echo "❌ ERROR: WASM file not found: $wasm_file"
    return 1
  fi
  
  local actual_size
  actual_size=$(stat -c%s "$wasm_file" 2>/dev/null || stat -f%z "$wasm_file" 2>/dev/null || echo "0")
  
  local actual_kb=$((actual_size / 1024))
  local budget_kb=$((budget / 1024))
  local percentage=$((actual_size * 100 / budget))
  
  printf "%-25s: %6d bytes (%3d KB) / %6d bytes (%3d KB) - " \
    "$contract_name" "$actual_size" "$actual_kb" "$budget" "$budget_kb"
  
  if [[ $actual_size -le $budget ]]; then
    echo "✅ PASS ($percentage%)"
  else
    echo "❌ FAIL ($percentage%)"
    echo "  ⚠️  Contract exceeds budget by $((actual_size - budget)) bytes"
    BUDGET_EXCEEDED=1
  fi
}

# Check each contract
check_contract "identity-registry" \
  "$CONTRACTS_DIR/identity_registry.wasm" \
  "$IDENTITY_REGISTRY_SIZE_BUDGET"

check_contract "credential-manager" \
  "$CONTRACTS_DIR/credential_manager.wasm" \
  "$CREDENTIAL_MANAGER_SIZE_BUDGET"

check_contract "reputation" \
  "$CONTRACTS_DIR/reputation.wasm" \
  "$REPUTATION_SIZE_BUDGET"

echo ""
echo "========================================"

if [[ $BUDGET_EXCEEDED -eq 1 ]]; then
  echo "❌ WASM size budget check FAILED"
  echo ""
  echo "One or more contracts exceed their size budget."
  echo "To fix this:"
  echo "  1. Review recent changes for code bloat"
  echo "  2. Consider removing unused dependencies"
  echo "  3. Enable link-time optimization (LTO)"
  echo "  4. Use cargo-bloat to identify large functions"
  echo ""
  echo "To adjust budgets, set environment variables:"
  echo "  IDENTITY_REGISTRY_SIZE_BUDGET=<bytes>"
  echo "  CREDENTIAL_MANAGER_SIZE_BUDGET=<bytes>"
  echo "  REPUTATION_SIZE_BUDGET=<bytes>"
  echo "========================================"
  exit 1
else
  echo "✅ All contracts within size budget"
  echo "========================================"
  exit 0
fi
