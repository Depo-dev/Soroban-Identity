#!/usr/bin/env bash
# Round-trip verification for scripts/backup.sh and scripts/restore.sh.
#
# Creates a throwaway data directory and config file, backs them up, wipes the
# originals, restores from the archive, and asserts the contents match. Runs
# entirely in a temp directory and touches nothing in the working tree, so it is
# safe to run in CI or before relying on a real restore.
#
# Usage: scripts/test-backup-restore.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SH="$REPO_ROOT/scripts/backup.sh"
RESTORE_SH="$REPO_ROOT/scripts/restore.sh"

PASSED=0
FAILED=0

pass() { echo "  ok   - $*"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL - $*" >&2; FAILED=$((FAILED + 1)); }

assert_equal() {
  local expected="$1" actual="$2" what="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$what"
  else
    fail "$what (expected '$expected', got '$actual')"
  fi
}

assert_file() {
  if [[ -f "$1" ]]; then
    pass "$2"
  else
    fail "$2 (missing: $1)"
  fi
}

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

DATA_DIR="$WORK_DIR/data"
BACKUP_DIR="$WORK_DIR/backups"
CONFIG_DIR="$WORK_DIR/config"

mkdir -p "$DATA_DIR/audit" "$CONFIG_DIR"
echo '{"credentials":[{"id":"cred-1","subject":"GSUBJECT"}]}' > "$DATA_DIR/credentials.json"
echo '{"webhooks":[]}' > "$DATA_DIR/webhooks.json"
printf '{"credentialId":"cred-1","channel":"email","status":"delivered"}\n' > "$DATA_DIR/notification-log.ndjson"
echo 'entry' > "$DATA_DIR/audit/audit-2026-01-01.ndjson"

echo "== backup =="
ARCHIVE="$("$BACKUP_SH" --backup-dir "$BACKUP_DIR" --data-dir "$DATA_DIR" --no-redis --quiet)"
assert_file "$ARCHIVE" "archive created"

case "$(basename "$ARCHIVE")" in
  soroban-identity-backup-*.tar.gz) pass "archive name is timestamped" ;;
  *) fail "archive name is timestamped (got $(basename "$ARCHIVE"))" ;;
esac

if tar -tzf "$ARCHIVE" | grep -q './manifest.json'; then
  pass "archive contains a manifest"
else
  fail "archive contains a manifest"
fi

if tar -tzf "$ARCHIVE" | grep -q './data/credentials.json'; then
  pass "archive contains credential data"
else
  fail "archive contains credential data"
fi

echo "== restore into an empty directory =="
RESTORED_DIR="$WORK_DIR/restored"
"$RESTORE_SH" "$ARCHIVE" --data-dir "$RESTORED_DIR" --config-dir "$CONFIG_DIR" --quiet

assert_file "$RESTORED_DIR/credentials.json" "credentials.json restored"
assert_file "$RESTORED_DIR/webhooks.json" "webhooks.json restored"
assert_file "$RESTORED_DIR/notification-log.ndjson" "notification log restored"
assert_file "$RESTORED_DIR/audit/audit-2026-01-01.ndjson" "nested audit log restored"

assert_equal \
  "$(cat "$DATA_DIR/credentials.json")" \
  "$(cat "$RESTORED_DIR/credentials.json")" \
  "restored credentials match the original byte-for-byte"

echo "== restore refuses to clobber a non-empty directory =="
if "$RESTORE_SH" "$ARCHIVE" --data-dir "$RESTORED_DIR" --config-dir "$CONFIG_DIR" --quiet >/dev/null 2>&1; then
  fail "restore without --force is refused for a non-empty target"
else
  pass "restore without --force is refused for a non-empty target"
fi

echo "== --force moves existing data aside =="
echo 'stale' > "$RESTORED_DIR/stale.json"
"$RESTORE_SH" "$ARCHIVE" --data-dir "$RESTORED_DIR" --config-dir "$CONFIG_DIR" --force --quiet
assert_file "$RESTORED_DIR/credentials.json" "data restored again with --force"

if compgen -G "$RESTORED_DIR.pre-restore-*" > /dev/null; then
  pass "previous data directory preserved as .pre-restore-*"
else
  fail "previous data directory preserved as .pre-restore-*"
fi

if [[ ! -f "$RESTORED_DIR/stale.json" ]]; then
  pass "stale file is not carried into the restored directory"
else
  fail "stale file is not carried into the restored directory"
fi

echo "== dry run writes nothing =="
DRY_DIR="$WORK_DIR/dry"
"$RESTORE_SH" "$ARCHIVE" --data-dir "$DRY_DIR" --config-dir "$CONFIG_DIR" --dry-run --quiet
if [[ ! -d "$DRY_DIR" ]]; then
  pass "--dry-run leaves the target untouched"
else
  fail "--dry-run leaves the target untouched"
fi

echo "== restore rejects a corrupt archive =="
BAD_ARCHIVE="$WORK_DIR/bad.tar.gz"
echo 'not an archive' > "$BAD_ARCHIVE"
if "$RESTORE_SH" "$BAD_ARCHIVE" --data-dir "$WORK_DIR/bad-target" --quiet >/dev/null 2>&1; then
  fail "corrupt archive is rejected"
else
  pass "corrupt archive is rejected"
fi

echo "== retention prunes archives older than the window =="
OLD_ARCHIVE="$BACKUP_DIR/soroban-identity-backup-19700101T000000Z.tar.gz"
cp "$ARCHIVE" "$OLD_ARCHIVE"
# Backdate well beyond any sane retention window.
touch -t 200001010000 "$OLD_ARCHIVE"
"$BACKUP_SH" --backup-dir "$BACKUP_DIR" --data-dir "$DATA_DIR" --no-redis --retention-days 30 --quiet >/dev/null
if [[ ! -f "$OLD_ARCHIVE" ]]; then
  pass "archive older than the retention window is pruned"
else
  fail "archive older than the retention window is pruned"
fi

if [[ -f "$ARCHIVE" ]]; then
  pass "recent archive is retained"
else
  fail "recent archive is retained"
fi

echo "== retention 0 disables pruning =="
touch -t 200001010000 "$OLD_ARCHIVE" 2>/dev/null || cp "$ARCHIVE" "$OLD_ARCHIVE"
touch -t 200001010000 "$OLD_ARCHIVE"
"$BACKUP_SH" --backup-dir "$BACKUP_DIR" --data-dir "$DATA_DIR" --no-redis --retention-days 0 --quiet >/dev/null
if [[ -f "$OLD_ARCHIVE" ]]; then
  pass "retention 0 keeps every archive"
else
  fail "retention 0 keeps every archive"
fi

echo
echo "passed: $PASSED   failed: $FAILED"
[[ "$FAILED" -eq 0 ]]
