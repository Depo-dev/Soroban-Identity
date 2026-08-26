# Backup and Restore

Operational scripts for backing up and restoring Soroban Identity application
data and configuration.

| Script | Purpose |
| --- | --- |
| `scripts/backup.sh` | Create a timestamped archive of Redis, the data directory, and env config |
| `scripts/restore.sh` | Restore an archive produced by `backup.sh` |
| `scripts/schedule-backup.sh` | Install, remove, or inspect the daily backup cron entry |
| `scripts/test-backup-restore.sh` | Round-trip verification of the backup and restore procedure |

## What is backed up

A backup archive is a single `tar.gz` named
`soroban-identity-backup-<UTC timestamp>.tar.gz` containing:

- `redis-dump.rdb` — a point-in-time Redis snapshot, when `REDIS_URL` is set
- `data/` — the server data directory: credentials, webhooks, webhook logs,
  the notification log, the expiry watermark, and rotated audit logs
- `config/` — any of `.env`, `.env.local`, `.env.production`, `deployed.env`,
  `.env.deployed`, `server/.env`, `frontend/.env` that exist
- `manifest.json` — what was captured, when, and from which host

Archives and captured env files are written mode `600` because they contain
secrets and credential data. Keep `backups/` out of version control — it is
already gitignored.

## Creating a backup

```bash
# Defaults: ./backups, ./server/data, 30-day retention, no Redis
scripts/backup.sh

# Include a Redis snapshot
scripts/backup.sh --redis-url redis://localhost:6379

# Custom locations and retention
scripts/backup.sh --backup-dir /var/backups/soroban --data-dir /srv/data --retention-days 14
```

The script prints the archive path on stdout (everything else goes through
`[backup]` log lines, or is silenced with `--quiet`), so it composes with other
tooling:

```bash
ARCHIVE="$(scripts/backup.sh --quiet)"
aws s3 cp "$ARCHIVE" "s3://my-bucket/$(basename "$ARCHIVE")"
```

If there is nothing to capture — no Redis, no data directory, no config files —
the script exits non-zero rather than writing an empty archive.

## Retention

`--retention-days N` (default 30, also settable via `BACKUP_RETENTION_DAYS`)
prunes archives in the backup directory older than N days. Only files matching
`soroban-identity-backup-*.tar.gz` are considered, so unrelated files in the
directory are never touched. `--retention-days 0` disables pruning.

## Scheduling daily backups

```bash
# Daily at 02:30 with a 30-day window
scripts/schedule-backup.sh install

# Daily at 04:00, 14-day window, including Redis
scripts/schedule-backup.sh install --time 04:00 --retention-days 14 --redis-url redis://localhost:6379

scripts/schedule-backup.sh status
scripts/schedule-backup.sh uninstall
```

Installs are idempotent — a second install replaces the previous entry rather
than adding a duplicate. Output is appended to `backups/backup.log` by default
(`--log-file` to change it).

On hosts without `crontab`, run `scripts/backup.sh` from systemd timers, a
Kubernetes CronJob, or your platform's scheduler instead; the script has no
cron-specific behaviour.

## Restoring

```bash
# Inspect the manifest and confirm what would happen, writing nothing
scripts/restore.sh backups/soroban-identity-backup-20260101T023000Z.tar.gz --dry-run

# Restore into an empty data directory
scripts/restore.sh backups/soroban-identity-backup-20260101T023000Z.tar.gz

# Overwrite an existing deployment
scripts/restore.sh backups/soroban-identity-backup-20260101T023000Z.tar.gz --force

# Also restore the Redis snapshot
scripts/restore.sh backups/... --force --redis-url redis://localhost:6379
```

Safety behaviour:

- Without `--force`, restore refuses to write into a non-empty data directory
  and skips config files that already exist.
- With `--force`, the existing data directory is **moved** to
  `<data-dir>.pre-restore-<timestamp>` and each overwritten config file is
  copied alongside as `<name>.pre-restore-<timestamp>`. Nothing is deleted.
- An archive without a `manifest.json` is rejected, as is a corrupt archive.

### Redis restore

An RDB snapshot cannot be pushed over the Redis wire protocol. The script reads
`CONFIG GET dir` / `CONFIG GET dbfilename`, saves the current RDB aside, writes
the snapshot in its place, and issues `DEBUG RELOAD`. That requires `redis-cli`
access to a server whose data directory is writable from the restoring host —
typically a local or sidecar Redis.

When `--redis-url` is omitted, the snapshot is extracted next to the archive as
`redis-dump-<timestamp>.rdb` and left for manual import, rather than being
silently discarded.

Stop the application server before restoring, and restart it afterwards, so it
does not write over the restored state mid-restore.

## Verifying the procedure

```bash
scripts/test-backup-restore.sh
```

This exercises the full round trip in a temp directory — archive creation and
naming, manifest presence, byte-for-byte data restore, the non-empty-target
refusal, `--force` set-aside behaviour, `--dry-run`, corrupt-archive rejection,
and retention pruning. It touches nothing in the working tree, so it is safe to
run in CI and worth running before you depend on a real restore.
