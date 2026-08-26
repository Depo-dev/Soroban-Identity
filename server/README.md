# Soroban Identity Server

Operational HTTP API server for Soroban Identity smart contracts. It exposes metrics, admin issuer management, and credential expiry tracking.

## Usage

### Run the Server
```bash
npm start
```

### Run Tests
```bash
npm test
```

## Configuration

The server configuration can be customized using the following environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port the server listens on. | `3001` |
| `LOG_LEVEL` | Logging verbosity (trace, debug, info, warn, error, fatal). All logs are structured JSON. | `info` |
| `ADMIN_API_KEY` | Key for authenticating request calls on `/admin/*` endpoints. Supports scoped access (see API Key Scopes below). | unset |
| `DATA_DIR` | Directory path for local file storage. | `./data` |
| `AUDIT_LOG_PATH` | Base file path prefix used for daily rotated audit logs. | `[DATA_DIR]/audit` |
| `AUDIT_LOG_RETENTION_DAYS` | Number of days to retain rotated audit logs. | `30` |
| `CREDENTIAL_STORE_PATH` | Storage location for credential records. | `[DATA_DIR]/credentials.json` |
| `EXPIRY_CONCURRENCY` | Maximum concurrent credential expiry notifications. Controls parallelism to prevent event loop blocking. | `8` |
| `EXPIRY_WARNING_DAYS` | Fallback warning window in days when no reminder threshold applies. | `7` |
| `EXPIRY_REMINDER_THRESHOLDS` | Comma-separated days-before-expiry at which a reminder is sent. | `30,7,1` |
| `EXPIRY_JOB_INTERVAL_MS` | Interval between expiry job runs when no cron schedule is configured. | `3600000` |
| `EXPIRY_CRON_SCHEDULE` | Standard 5-field cron expression for the expiry job. When set it replaces the fixed interval. | unset |
| `NOTIFICATION_WEBHOOK_URL` | Fallback webhook receiving expiry reminders. | unset |
| `SUBJECT_NOTIFICATION_WEBHOOKS` | JSON map of subject address to webhook url. | `{}` |
| `EMAIL_API_URL` | HTTP endpoint of the email provider used for expiry reminders. Enables email delivery together with `EMAIL_FROM`. | unset |
| `EMAIL_API_KEY` | Bearer token sent to `EMAIL_API_URL`. | unset |
| `EMAIL_FROM` | Sender address for reminder emails. Required when `EMAIL_API_URL` is set. | unset |
| `NOTIFICATION_EMAIL` | Fallback recipient address for reminder emails. | unset |
| `SUBJECT_NOTIFICATION_EMAILS` | JSON map of subject address to recipient email. | `{}` |
| `NOTIFICATION_MAX_RETRIES` | Attempts per notification channel before it is recorded as failed. | `3` |
| `NOTIFICATION_RETRY_BASE_MS` | Base delay for exponential backoff between notification attempts. | `500` |

## Credential Expiry Notifications

A background job scans stored credentials and notifies holders before a
credential expires.

### Scheduling

By default the job runs on a fixed interval (`EXPIRY_JOB_INTERVAL_MS`). Setting
`EXPIRY_CRON_SCHEDULE` switches it to a cron schedule instead:

```bash
# Every day at 09:00 local time
EXPIRY_CRON_SCHEDULE="0 9 * * *"

# Every 6 hours
EXPIRY_CRON_SCHEDULE="0 */6 * * *"

# Weekdays at 08:30
EXPIRY_CRON_SCHEDULE="30 8 * * mon-fri"
```

The scheduler supports the standard 5-field syntax — wildcards, lists, ranges,
steps, and three-letter month/day aliases. An invalid expression fails
`validateConfig` at startup rather than silently disabling the job. Overlapping
runs are skipped, so a slow scan never queues up duplicate work.

### Thresholds

`EXPIRY_REMINDER_THRESHOLDS` controls when reminders fire. With the default
`30,7,1` a credential receives at most one reminder per threshold; the sent
thresholds are recorded on the credential so a restart does not re-notify.

### Channels

Two delivery channels run independently for each due credential:

- **Webhook** — POSTs a `credential.expiry_reminder` payload to the
  per-subject webhook, the credential's own webhook, or `NOTIFICATION_WEBHOOK_URL`.
- **Email** — POSTs a JSON message (`from`, `to`, `subject`, `text`, `html`) to
  `EMAIL_API_URL` with an optional bearer token, which fronts SendGrid-style,
  Mailgun-style, or in-house relay endpoints without adding an SMTP dependency.
  The recipient resolves from the credential's own address, then
  `SUBJECT_NOTIFICATION_EMAILS`, then `NOTIFICATION_EMAIL`.

Each channel retries with exponential backoff up to `NOTIFICATION_MAX_RETRIES`.
A credential is marked notified when at least one channel succeeds; if every
configured channel fails, the failure is recorded and the credential stays
eligible for the next run.

### Notification log

Every attempt — delivered, failed, or skipped — is appended to
`[DATA_DIR]/notification-log.ndjson` with the credential id, channel, target,
threshold, attempt number, duration, and error message.

| Endpoint | Scope | Description |
| --- | --- | --- |
| `GET /notifications/logs?limit=&credentialId=&status=` | `admin:read` | Newest attempts, optionally filtered. `limit` caps at 200. |
| `GET /notifications/summary` | `admin:read` | Delivered/failed/skipped counts, overall and per channel. |

## API Key Scopes

The server supports granular access control through API key scopes. Instead of granting full access, you can issue scoped keys for specific operations.

### Scope Format

```
<api-key>:<scope1>,<scope2>,<scope3>
```

### Available Scopes

- **`credentials:read`** - Verify and read credentials
- **`credentials:write`** - Issue new credentials
- **`admin:read`** - View administrative data (issuers, expiry reports)
- **`admin:write`** - Modify administrative settings (add/remove issuers)
- **`*`** - Wildcard grants all permissions

### Examples

```bash
# Read-only dashboard access
X-API-Key: my-key:credentials:read,admin:read

# Issuer integration (write-only)
X-API-Key: my-key:credentials:write

# Full admin access
X-API-Key: my-key:admin:read,admin:write

# Full access (wildcard)
X-API-Key: my-key:*

# Legacy format (no scopes = full access)
X-API-Key: my-key
```

For detailed documentation, see [API Key Scopes](../docs/api-key-scopes.md).

## Audit Log Naming & Rotation

The system generates a new, separate audit log file for each day. The log files are stored in Newline Delimited JSON (NDJSON) format.

### Log File Naming
The log file name is derived by appending the current UTC date to the base log path prefix:
`audit-YYYY-MM-DD.ndjson`

* Day 1 logs are written to `audit-YYYY-MM-Day1.ndjson`.
* Day 2 logs are written to `audit-YYYY-MM-Day2.ndjson`.

### Cleanup & Retention
Every time the server starts, it scans the logs folder and deletes any rotated log files that are older than `AUDIT_LOG_RETENTION_DAYS` days (default is 30 days) to prevent disk space exhaustion.
