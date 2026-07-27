#!/usr/bin/env bash
#
# Run all fuzz targets with a time budget.
#
# Usage:
#   ./run_fuzz.sh [time_per_target_seconds]
#
# Example:
#   ./run_fuzz.sh 60    # Run each target for 60 seconds
#   ./run_fuzz.sh 300   # Run each target for 5 minutes

set -euo pipefail

TIME_BUDGET="${1:-60}"
TARGETS=("fuzz_create_did" "fuzz_issue_credential" "fuzz_submit_score")

echo "Running fuzz tests with ${TIME_BUDGET}s budget per target..."
echo

has_crashes=0

for target in "${TARGETS[@]}"; do
  echo "===================================="
  echo "Running: $target"
  echo "===================================="
  
  if cargo +nightly fuzz run "$target" -- \
      -max_total_time="$TIME_BUDGET" \
      -rss_limit_mb=2048 \
      -print_final_stats=1; then
    echo "✅ $target completed without crashes"
  else
    echo "❌ $target found crashes"
    has_crashes=1
    
    # List crash artifacts if any
    if [ -d "artifacts/$target" ]; then
      echo "Crash artifacts:"
      ls -lh "artifacts/$target"
    fi
  fi
  
  echo
done

echo "===================================="
echo "Summary"
echo "===================================="

if [ $has_crashes -eq 0 ]; then
  echo "✅ All fuzz targets passed without crashes"
  exit 0
else
  echo "❌ Some fuzz targets found crashes. See artifacts/ for reproducers."
  echo
  echo "To reproduce a crash:"
  echo "  cargo +nightly fuzz run <target> artifacts/<target>/<crash-file>"
  echo
  echo "To minimize a crash:"
  echo "  cargo +nightly fuzz tmin <target> artifacts/<target>/<crash-file>"
  exit 1
fi
