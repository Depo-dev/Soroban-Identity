#!/usr/bin/env bash
# Install, remove, or inspect the daily Soroban Identity backup cron entry.
#
# Usage:
#   scripts/schedule-backup.sh install [--time HH:MM] [--retention-days N] [--redis-url URL]
#   scripts/schedule-backup.sh uninstall
#   scripts/schedule-backup.sh status
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# soroban-identity-backup"

ACTION="${1:-status}"
shift || true

TIME="02:30"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
REDIS_URL="${REDIS_URL:-}"
LOG_FILE="${BACKUP_LOG_FILE:-$REPO_ROOT/backups/backup.log}"

fail() {
  echo "[schedule-backup] ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --time) TIME="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --redis-url) REDIS_URL="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

command -v crontab >/dev/null 2>&1 || fail "crontab is required but was not found on PATH"

case "$ACTION" in
  install)
    [[ "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || fail "--time must be HH:MM in 24-hour form, got: $TIME"
    [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "--retention-days must be a non-negative integer"

    hour="${TIME%%:*}"
    minute="${TIME##*:}"
    # Strip a leading zero so cron does not read the value as octal.
    hour="$((10#$hour))"
    minute="$((10#$minute))"

    cmd="$REPO_ROOT/scripts/backup.sh --retention-days $RETENTION_DAYS --quiet"
    [[ -n "$REDIS_URL" ]] && cmd="$cmd --redis-url '$REDIS_URL'"
    entry="$minute $hour * * * $cmd >> '$LOG_FILE' 2>&1 $MARKER"

    mkdir -p "$(dirname "$LOG_FILE")"
    # Replace any previous entry so repeated installs stay idempotent.
    { crontab -l 2>/dev/null | grep -v -F "$MARKER" || true; echo "$entry"; } | crontab -
    echo "[schedule-backup] Installed daily backup at $TIME (retention: $RETENTION_DAYS days)"
    echo "[schedule-backup] Logging to $LOG_FILE"
    ;;

  uninstall)
    if crontab -l 2>/dev/null | grep -q -F "$MARKER"; then
      crontab -l 2>/dev/null | grep -v -F "$MARKER" | crontab -
      echo "[schedule-backup] Removed the scheduled backup entry"
    else
      echo "[schedule-backup] No scheduled backup entry found"
    fi
    ;;

  status)
    if crontab -l 2>/dev/null | grep -F "$MARKER"; then
      exit 0
    fi
    echo "[schedule-backup] No scheduled backup entry installed"
    ;;

  *)
    fail "Unknown action: $ACTION (expected install, uninstall, or status)"
    ;;
esac
