#!/usr/bin/env bash
# Restore a Soroban Identity backup archive produced by scripts/backup.sh.
#
# Usage:
#   scripts/restore.sh ARCHIVE [--data-dir DIR] [--redis-url URL]
#                              [--config-dir DIR] [--dry-run] [--force] [--quiet]
#
# Without --force the script refuses to overwrite a non-empty data directory.
# Existing data is moved aside to a timestamped .pre-restore directory rather
# than deleted, so a bad restore is recoverable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARCHIVE=""
DATA_DIR="${DATA_DIR:-$REPO_ROOT/server/data}"
CONFIG_DIR="${CONFIG_DIR:-$REPO_ROOT}"
REDIS_URL="${REDIS_URL:-}"
DRY_RUN=0
FORCE=0
QUIET=0

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "[restore] $*"
  fi
}

fail() {
  echo "[restore] ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --redis-url) REDIS_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "Unknown option: $1 (use --help)" ;;
    *)
      [[ -n "$ARCHIVE" ]] && fail "Only one archive may be given"
      ARCHIVE="$1"
      shift
      ;;
  esac
done

[[ -n "$ARCHIVE" ]] || fail "An archive path is required (use --help)"
[[ -f "$ARCHIVE" ]] || fail "Archive not found: $ARCHIVE"
command -v tar >/dev/null 2>&1 || fail "tar is required but was not found on PATH"

STAGING_DIR="$(mktemp -d)"
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT

log "Extracting $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$STAGING_DIR" || fail "Failed to extract archive (corrupt or not a backup archive?)"

[[ -f "$STAGING_DIR/manifest.json" ]] || fail "Archive has no manifest.json; refusing to restore"

if [[ "$QUIET" -eq 0 ]]; then
  echo "[restore] Manifest:"
  sed 's/^/  /' "$STAGING_DIR/manifest.json"
fi

RESTORE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# --- Application data directory --------------------------------------------
if [[ -d "$STAGING_DIR/data" ]]; then
  if [[ -d "$DATA_DIR" ]] && [[ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]] && [[ "$FORCE" -eq 0 ]]; then
    fail "$DATA_DIR is not empty; re-run with --force to move it aside and restore"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY RUN: would restore data directory into $DATA_DIR"
  else
    if [[ -d "$DATA_DIR" ]] && [[ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]]; then
      backup_aside="$DATA_DIR.pre-restore-$RESTORE_STAMP"
      mv "$DATA_DIR" "$backup_aside"
      log "Moved existing data directory to $backup_aside"
    fi
    mkdir -p "$DATA_DIR"
    cp -R "$STAGING_DIR/data/." "$DATA_DIR/"
    log "Restored data directory into $DATA_DIR"
  fi
else
  log "Archive contains no data directory; skipping"
fi

# --- Environment configuration ---------------------------------------------
if [[ -d "$STAGING_DIR/config" ]] && [[ -n "$(ls -A "$STAGING_DIR/config" 2>/dev/null)" ]]; then
  for stored in "$STAGING_DIR/config"/*; do
    [[ -f "$stored" ]] || continue
    # backup.sh flattens nested paths with underscores; reverse that here.
    relative="$(basename "$stored" | sed 's/_/\//g')"
    target="$CONFIG_DIR/$relative"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRY RUN: would restore config $relative"
      continue
    fi

    if [[ -f "$target" ]] && [[ "$FORCE" -eq 0 ]]; then
      log "Skipping existing config $relative (use --force to overwrite)"
      continue
    fi

    if [[ -f "$target" ]]; then
      cp "$target" "$target.pre-restore-$RESTORE_STAMP"
      log "Saved previous $relative alongside as $relative.pre-restore-$RESTORE_STAMP"
    fi

    mkdir -p "$(dirname "$target")"
    cp "$stored" "$target"
    chmod 600 "$target"
    log "Restored config $relative"
  done
else
  log "Archive contains no config files; skipping"
fi

# --- Redis ------------------------------------------------------------------
if [[ -f "$STAGING_DIR/redis-dump.rdb" ]]; then
  if [[ -z "$REDIS_URL" ]]; then
    log "Archive contains a Redis snapshot but no --redis-url was given; leaving $STAGING_DIR/redis-dump.rdb unrestored"
    # Preserve the dump outside the staging directory so it is not lost on exit.
    cp "$STAGING_DIR/redis-dump.rdb" "$(dirname "$ARCHIVE")/redis-dump-$RESTORE_STAMP.rdb"
    log "Copied Redis snapshot to $(dirname "$ARCHIVE")/redis-dump-$RESTORE_STAMP.rdb"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY RUN: would import Redis snapshot into $REDIS_URL"
  else
    command -v redis-cli >/dev/null 2>&1 || fail "redis-cli is required to restore the Redis snapshot"
    log "Importing Redis snapshot into $REDIS_URL"
    # An RDB file cannot be pushed over the wire, so the snapshot is written to
    # the Redis data directory and the server is asked to reload it. This
    # requires redis-cli access to a server whose dir is writable by this host.
    redis_dir="$(redis-cli -u "$REDIS_URL" CONFIG GET dir | tail -n 1)"
    [[ -n "$redis_dir" ]] || fail "Could not determine the Redis data directory"
    redis_dbfile="$(redis-cli -u "$REDIS_URL" CONFIG GET dbfilename | tail -n 1)"
    [[ -n "$redis_dbfile" ]] || redis_dbfile="dump.rdb"

    [[ -w "$redis_dir" ]] || fail "Redis data directory $redis_dir is not writable from this host"

    if [[ -f "$redis_dir/$redis_dbfile" ]]; then
      cp "$redis_dir/$redis_dbfile" "$redis_dir/$redis_dbfile.pre-restore-$RESTORE_STAMP"
      log "Saved previous RDB as $redis_dbfile.pre-restore-$RESTORE_STAMP"
    fi

    cp "$STAGING_DIR/redis-dump.rdb" "$redis_dir/$redis_dbfile"
    redis-cli -u "$REDIS_URL" DEBUG RELOAD >/dev/null \
      || fail "Redis reload failed; the snapshot is in place but the server must be restarted manually"
    log "Redis snapshot imported"
  fi
else
  log "Archive contains no Redis snapshot; skipping"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run complete; nothing was written"
else
  log "Restore complete"
fi
