#!/usr/bin/env bash
# Back up Soroban Identity application data and configuration.
#
# Produces a single timestamped tar.gz archive containing:
#   - a Redis snapshot (when a Redis instance is configured)
#   - the server data directory (credentials, webhooks, audit and notification logs)
#   - environment configuration files
#   - a manifest describing what was captured
#
# Usage:
#   scripts/backup.sh [--backup-dir DIR] [--data-dir DIR] [--redis-url URL]
#                     [--retention-days N] [--no-redis] [--quiet]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
DATA_DIR="${DATA_DIR:-$REPO_ROOT/server/data}"
REDIS_URL="${REDIS_URL:-}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
INCLUDE_REDIS=1
QUIET=0

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "[backup] $*"
  fi
}

fail() {
  echo "[backup] ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --redis-url) REDIS_URL="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --no-redis) INCLUDE_REDIS=0; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  fail "--retention-days must be a non-negative integer, got: $RETENTION_DAYS"
fi

command -v tar >/dev/null 2>&1 || fail "tar is required but was not found on PATH"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="soroban-identity-backup-$TIMESTAMP.tar.gz"
ARCHIVE_PATH="$BACKUP_DIR/$ARCHIVE_NAME"

STAGING_DIR="$(mktemp -d)"
# Always clean the staging directory, including on failure, so a partial run
# never leaves credential data lying around in the temp directory.
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
mkdir -p "$STAGING_DIR/payload"

REDIS_STATUS="skipped"
DATA_STATUS="skipped"
CONFIG_FILES=()

# --- Redis snapshot ---------------------------------------------------------
if [[ "$INCLUDE_REDIS" -eq 1 && -n "$REDIS_URL" ]]; then
  if ! command -v redis-cli >/dev/null 2>&1; then
    fail "REDIS_URL is set but redis-cli was not found on PATH (use --no-redis to skip)"
  fi

  log "Dumping Redis keyspace from $REDIS_URL"
  # --rdb streams a point-in-time RDB snapshot over the connection, so the
  # backup does not depend on filesystem access to the Redis host.
  if redis-cli -u "$REDIS_URL" --rdb "$STAGING_DIR/payload/redis-dump.rdb" >/dev/null 2>&1; then
    REDIS_STATUS="ok"
  else
    fail "Redis dump failed for $REDIS_URL"
  fi
elif [[ "$INCLUDE_REDIS" -eq 1 ]]; then
  log "No REDIS_URL configured; skipping Redis snapshot"
fi

# --- Application data directory --------------------------------------------
if [[ -d "$DATA_DIR" ]]; then
  log "Copying data directory $DATA_DIR"
  mkdir -p "$STAGING_DIR/payload/data"
  # Copy contents rather than the directory itself so restore does not depend
  # on the source directory's basename.
  cp -R "$DATA_DIR/." "$STAGING_DIR/payload/data/"
  DATA_STATUS="ok"
else
  log "Data directory $DATA_DIR does not exist; skipping"
fi

# --- Environment configuration ---------------------------------------------
mkdir -p "$STAGING_DIR/payload/config"
for candidate in .env .env.local .env.production deployed.env .env.deployed server/.env frontend/.env; do
  if [[ -f "$REPO_ROOT/$candidate" ]]; then
    target="$STAGING_DIR/payload/config/$(echo "$candidate" | tr '/' '_')"
    cp "$REPO_ROOT/$candidate" "$target"
    # Environment files hold secrets; keep them owner-only inside the archive.
    chmod 600 "$target"
    CONFIG_FILES+=("$candidate")
    log "Captured config $candidate"
  fi
done

if [[ "$REDIS_STATUS" != "ok" && "$DATA_STATUS" != "ok" && ${#CONFIG_FILES[@]} -eq 0 ]]; then
  fail "Nothing to back up: no Redis snapshot, no data directory, no config files"
fi

# --- Manifest ---------------------------------------------------------------
config_json=""
for file in ${CONFIG_FILES+"${CONFIG_FILES[@]}"}; do
  config_json="$config_json\"$file\","
done
config_json="${config_json%,}"

cat > "$STAGING_DIR/payload/manifest.json" <<MANIFEST
{
  "version": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "timestamp": "$TIMESTAMP",
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "redis": "$REDIS_STATUS",
  "data_dir": "$DATA_DIR",
  "data": "$DATA_STATUS",
  "config_files": [$config_json]
}
MANIFEST

# --- Archive ----------------------------------------------------------------
tar -czf "$ARCHIVE_PATH" -C "$STAGING_DIR/payload" .
chmod 600 "$ARCHIVE_PATH"
log "Wrote $ARCHIVE_PATH ($(wc -c < "$ARCHIVE_PATH") bytes)"

# --- Retention --------------------------------------------------------------
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  pruned=0
  while IFS= read -r old; do
    rm -f "$old"
    pruned=$((pruned + 1))
    log "Pruned $(basename "$old")"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'soroban-identity-backup-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" 2>/dev/null)
  log "Retention: kept backups from the last $RETENTION_DAYS day(s), pruned $pruned"
fi

echo "$ARCHIVE_PATH"
