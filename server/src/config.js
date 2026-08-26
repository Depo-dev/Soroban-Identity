import path from "node:path";
import { logger } from './logger.js';
import { parseCronExpression } from './cron.js';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");

/**
 * Parse an integer from a string environment variable value.
 *
 * @param {string|undefined} value     - Raw env var string
 * @param {number}           fallback  - Default when value is absent or invalid
 * @param {boolean}         [allowZero=false] - When true, 0 is accepted as a
 *   valid "disabled" sentinel in addition to positive integers. Keys that
 *   support disable-via-0 (EVENT_POLL_INTERVAL_MS, RPC_MAX_RETRIES,
 *   SOROBAN_POOL_SIZE) must pass allowZero: true. All other keys require a
 *   strictly positive integer.
 */
function parseInteger(value, fallback, allowZero = false) {
  const parsed = Number.parseInt(value ?? "", 10);
  const isValid = Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  return isValid ? parsed : fallback;
}

/**
 * Resolve the Stellar source account from environment variables.
 * STELLAR_SOURCE_ACCOUNT takes precedence over STELLAR_SECRET_KEY.
 * Both loadConfig and validateConfig use this helper so they always agree
 * on which variable is authoritative when both are set.
 *
 * @param {Object} env - Environment variable object
 * @returns {string} The resolved source account, or "" if neither is set
 */
function resolveSourceAccount(env) {
  return env.STELLAR_SOURCE_ACCOUNT ?? env.STELLAR_SECRET_KEY ?? "";
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON configuration: ${error.message}`);
  }
}

/**
 * Parse the allowed CORS origins.
 *
 * Accepts a comma-separated list, a single origin, or `*`. `CORS_ORIGIN` is
 * the documented name; `CORS_ALLOWED_ORIGINS` is still read as an alias so
 * existing deployments keep working.
 *
 * Default: allow all in development, none in production — a production
 * deployment must name its origins explicitly rather than inheriting a
 * permissive default.
 *
 * @param {string|undefined} value
 * @param {string} nodeEnv
 * @returns {string[]}
 */
function parseCorsOrigins(value, nodeEnv) {
  if (!value) {
    return nodeEnv === "development" ? ["*"] : [];
  }
  if (value.trim() === "*") {
    return ["*"];
  }
  // Comma-separated list of origins
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Parse a boolean environment variable.
 *
 * Accepts true/1/yes/on and false/0/no/off, case-insensitively. Anything else
 * (including an empty value) falls back to the default rather than being
 * silently treated as false.
 *
 * @param {string|undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/**
 * Parse a comma-separated list into a trimmed array, falling back to a default
 * when the variable is unset or contains only separators.
 *
 * @param {string|undefined} value
 * @param {string[]} fallback
 * @returns {string[]}
 */
function parseList(value, fallback) {
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export const DEFAULT_CORS_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

export const DEFAULT_CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Request-ID",
  "X-Actor",
  "X-User-Tier",
  "X-API-Version",
];

export const DEFAULT_CORS_EXPOSED_HEADERS = [
  "X-Request-ID",
  "Content-Type",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "X-API-Version",
];

/** Preflight cache lifetime in seconds. Browsers cap this themselves. */
export const DEFAULT_CORS_MAX_AGE = 86400;

function parseThresholds(value, fallback = [30, 7, 1]) {
  if (!value) return fallback;
  try {
    if (typeof value === "string") {
      const parsed = value
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return parsed.length > 0 ? parsed.sort((a, b) => b - a) : fallback;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  return {
    nodeEnv,
    port: parseInteger(env.PORT, 3001),
    adminApiKey: env.ADMIN_API_KEY ?? "",
    adminActor: env.ADMIN_ACTOR ?? "admin",
    corsAllowedOrigins: parseCorsOrigins(
      env.CORS_ORIGIN ?? env.CORS_ALLOWED_ORIGINS,
      nodeEnv,
    ),
    corsCredentials: parseBoolean(env.CORS_CREDENTIALS, false),
    corsMethods: parseList(env.CORS_METHODS, DEFAULT_CORS_METHODS),
    corsAllowedHeaders: parseList(
      env.CORS_ALLOWED_HEADERS,
      DEFAULT_CORS_ALLOWED_HEADERS,
    ),
    corsExposedHeaders: parseList(
      env.CORS_EXPOSED_HEADERS,
      DEFAULT_CORS_EXPOSED_HEADERS,
    ),
    corsMaxAge: parseInteger(env.CORS_MAX_AGE, DEFAULT_CORS_MAX_AGE, true),
    maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, 64 * 1024),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : DEFAULT_DATA_DIR,
    auditLogPath: env.AUDIT_LOG_PATH
      ? path.resolve(env.AUDIT_LOG_PATH)
      : path.join(DEFAULT_DATA_DIR, "audit"),
    auditLogRetentionDays: parseInteger(env.AUDIT_LOG_RETENTION_DAYS, 30),
    credentialStorePath: env.CREDENTIAL_STORE_PATH
      ? path.resolve(env.CREDENTIAL_STORE_PATH)
      : path.join(DEFAULT_DATA_DIR, "credentials.json"),
    accessLogEnabled: env.ACCESS_LOG_ENABLED !== "false",
    accessLogPath: env.ACCESS_LOG_PATH ?? "",
    accessLogMaxBytes: parseInteger(env.ACCESS_LOG_MAX_BYTES, 10 * 1024 * 1024),
    accessLogMaxFiles: parseInteger(env.ACCESS_LOG_MAX_FILES, 5),
    logPayloads: env.LOG_PAYLOADS === "true",
    logHeaders: env.LOG_HEADERS === "true",
    logPayloadMaxBytes: parseInteger(env.LOG_PAYLOAD_MAX_BYTES, 2048),
    trustProxy: env.TRUST_PROXY === "true",
    expiryWarningDays: parseInteger(env.EXPIRY_WARNING_DAYS, 7),
    expiryReminderThresholds: parseThresholds(
      env.EXPIRY_REMINDER_THRESHOLDS,
      [30, 7, 1],
    ),
    expiryJobIntervalMs: parseInteger(
      env.EXPIRY_JOB_INTERVAL_MS,
      60 * 60 * 1000,
    ),
    expiryConcurrency: parseInteger(env.EXPIRY_CONCURRENCY, 8),
    expiryCronSchedule: env.EXPIRY_CRON_SCHEDULE ?? "",
    notificationWebhookUrl: env.NOTIFICATION_WEBHOOK_URL ?? "",
    subjectNotificationWebhooks: parseJson(
      env.SUBJECT_NOTIFICATION_WEBHOOKS,
      {},
    ),
    emailApiUrl: env.EMAIL_API_URL ?? "",
    emailApiKey: env.EMAIL_API_KEY ?? "",
    emailFrom: env.EMAIL_FROM ?? "",
    notificationEmail: env.NOTIFICATION_EMAIL ?? "",
    subjectNotificationEmails: parseJson(env.SUBJECT_NOTIFICATION_EMAILS, {}),
    notificationMaxRetries: parseInteger(env.NOTIFICATION_MAX_RETRIES, 3),
    notificationRetryBaseMs: parseInteger(env.NOTIFICATION_RETRY_BASE_MS, 500),
    // SOROBAN_POOL_SIZE=0 disables the pool (allowZero: true)
    poolSize: parseInteger(env.SOROBAN_POOL_SIZE, 4, true),
    sorobanInvokeTimeoutMs: parseInteger(env.SOROBAN_INVOKE_TIMEOUT_MS, 10000),
    stellarCli: env.STELLAR_CLI ?? "stellar",
    sourceAccount: resolveSourceAccount(env),
    network: env.STELLAR_NETWORK ?? "testnet",
    rpcUrl: env.STELLAR_RPC_URL ?? env.RPC_URL ?? "https://soroban-testnet.stellar.org",
    rpcCacheTtlMs: parseInteger(env.RPC_CACHE_TTL_MS, 5000),
    // RPC_MAX_RETRIES=0 disables retries (allowZero: true)
    rpcMaxRetries: parseInteger(env.RPC_MAX_RETRIES, 3, true),
    rpcRetryBaseMs: parseInteger(env.RPC_RETRY_BASE_MS, 500),
    rpcRetryBackoff: parseInteger(env.RPC_RETRY_BACKOFF, 2),
    // EVENT_POLL_INTERVAL_MS=0 disables the event poller (allowZero: true)
    eventPollIntervalMs: parseInteger(env.EVENT_POLL_INTERVAL_MS, 5000, true),
    // WS_ENABLED=false turns the WebSocket endpoint off entirely
    wsEnabled: (env.WS_ENABLED ?? "true").toLowerCase() !== "false",
    wsPath: env.WS_PATH ?? "/ws",
    wsMessageLimit: parseInteger(env.WS_MESSAGE_LIMIT, 60),
    wsMessageWindowMs: parseInteger(env.WS_MESSAGE_WINDOW_MS, 60_000),
    // WS_HEARTBEAT_INTERVAL_MS=0 disables heartbeats (allowZero: true)
    wsHeartbeatIntervalMs: parseInteger(env.WS_HEARTBEAT_INTERVAL_MS, 30_000, true),
    contracts: {
      identity: env.IDENTITY_REGISTRY_ID ?? "",
      credential: env.CREDENTIAL_CONTRACT_ID ?? env.CREDENTIAL_MANAGER_ID ?? "",
      reputation: env.REPUTATION_ID ?? "",
    },
  };
}

export function validateConfig(env = process.env) {
  const missing = [];
  const invalid = [];

  const sourceAccount = resolveSourceAccount(env);
  if (!sourceAccount) {
    missing.push("STELLAR_SECRET_KEY: Stellar account secret key (S…)");
  } else {
    if (!/^S[A-Z2-7]{55}$/.test(sourceAccount)) {
      invalid.push(
        "STELLAR_SECRET_KEY: Stellar account secret key must start with S and be 56 characters long",
      );
    }
  }

  const credentialContract =
    env.CREDENTIAL_CONTRACT_ID ?? env.CREDENTIAL_MANAGER_ID;
  if (!credentialContract) {
    missing.push(
      "CREDENTIAL_CONTRACT_ID: deployed credential contract address",
    );
  } else {
    if (!/^C[A-Z2-7]{55}$/.test(credentialContract)) {
      invalid.push(
        "CREDENTIAL_CONTRACT_ID: deployed credential contract address must start with C and be 56 characters long",
      );
    }
  }

  const numericVars = [
    { key: "PORT", desc: "must be a valid integer" },
    { key: "EXPIRY_WARNING_DAYS", desc: "must be a valid integer" },
    { key: "EXPIRY_JOB_INTERVAL_MS", desc: "must be a valid integer" },
    { key: "EXPIRY_CONCURRENCY", desc: "must be a valid integer" },
    { key: "SOROBAN_POOL_SIZE", desc: "must be a valid integer" },
    { key: "SOROBAN_INVOKE_TIMEOUT_MS", desc: "must be a valid integer" },
    { key: "RPC_CACHE_TTL_MS", desc: "must be a valid integer" },
    { key: "RPC_MAX_RETRIES", desc: "must be a valid integer" },
    { key: "RPC_RETRY_BASE_MS", desc: "must be a valid integer" },
    { key: "RPC_RETRY_BACKOFF", desc: "must be a valid integer" },
    { key: "EVENT_POLL_INTERVAL_MS", desc: "must be a valid integer" },
    { key: "ACCESS_LOG_MAX_BYTES", desc: "must be a valid integer" },
    { key: "ACCESS_LOG_MAX_FILES", desc: "must be a valid integer" },
    { key: "LOG_PAYLOAD_MAX_BYTES", desc: "must be a valid integer" },
  ];

  for (const item of numericVars) {
    const val = env[item.key];
    if (val !== undefined && val !== "") {
      if (!/^\d+$/.test(val)) {
        invalid.push(`${item.key}: ${item.desc}`);
      }
    }
  }

  const corsOrigin = env.CORS_ORIGIN ?? env.CORS_ALLOWED_ORIGINS;
  if (corsOrigin !== undefined && corsOrigin !== "" && corsOrigin.trim() !== "*") {
    for (const origin of corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)) {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        invalid.push(
          `CORS_ORIGIN: '${origin}' must be an absolute origin such as https://app.example.com, or '*'`,
        );
        continue;
      }
      // An Origin header carries scheme://host[:port] and nothing else, so a
      // configured value with a path or query can never match a real request.
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        invalid.push(
          `CORS_ORIGIN: '${origin}' must not include a path, query or fragment`,
        );
      }
    }
  }

  const corsCredentials = env.CORS_CREDENTIALS;
  if (corsCredentials !== undefined && corsCredentials !== "") {
    const normalized = String(corsCredentials).trim().toLowerCase();
    const known = ["true", "1", "yes", "on", "false", "0", "no", "off"];
    if (!known.includes(normalized)) {
      invalid.push("CORS_CREDENTIALS: must be one of true/false/1/0/yes/no/on/off");
    } else if (["true", "1", "yes", "on"].includes(normalized)) {
      // The CORS spec forbids credentials with a wildcard origin: a browser
      // rejects the response outright, so this combination is never usable.
      const nodeEnvValue = env.NODE_ENV ?? "development";
      const effectiveOrigins =
        corsOrigin ?? (nodeEnvValue === "development" ? "*" : "");
      if (String(effectiveOrigins).trim() === "*") {
        invalid.push(
          "CORS_CREDENTIALS: cannot be enabled while CORS_ORIGIN is '*' — name the allowed origins explicitly",
        );
      }
    }
  }

  const rpcUrl = env.STELLAR_RPC_URL ?? env.RPC_URL;
  if (rpcUrl !== undefined && rpcUrl !== "") {
    try {
      new URL(rpcUrl);
    } catch {
      invalid.push("STELLAR_RPC_URL: must be a valid URL");
    }
  }

  const redisUrl = env.REDIS_URL;
  if (redisUrl !== undefined && redisUrl !== "") {
    try {
      const parsed = new URL(redisUrl);
      if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
        invalid.push("REDIS_URL: must use the redis:// or rediss:// scheme");
      }
    } catch {
      invalid.push("REDIS_URL: must be a valid URL");
    }
  }

  const webhookUrl = env.NOTIFICATION_WEBHOOK_URL;
  if (webhookUrl !== undefined && webhookUrl !== "") {
    try {
      new URL(webhookUrl);
    } catch {
      invalid.push("NOTIFICATION_WEBHOOK_URL: must be a valid URL");
    }
  }

  const emailApiUrl = env.EMAIL_API_URL;
  if (emailApiUrl !== undefined && emailApiUrl !== "") {
    try {
      new URL(emailApiUrl);
    } catch {
      invalid.push("EMAIL_API_URL: must be a valid URL");
    }
    if (!env.EMAIL_FROM) {
      invalid.push("EMAIL_FROM: required when EMAIL_API_URL is set");
    }
  }

  const cronSchedule = env.EXPIRY_CRON_SCHEDULE;
  if (cronSchedule !== undefined && cronSchedule !== "") {
    try {
      parseCronExpression(cronSchedule);
    } catch (error) {
      invalid.push(`EXPIRY_CRON_SCHEDULE: ${error.message}`);
    }
  }

  return {
    isValid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

export function logDefaultValues(env = process.env) {
  const defaults = [
    { key: "PORT", defaultVal: "3001" },
    { key: "ADMIN_API_KEY", defaultVal: "''" },
    { key: "ADMIN_ACTOR", defaultVal: "'admin'" },
    { key: "DATA_DIR", defaultVal: "data" },
    { key: "EXPIRY_WARNING_DAYS", defaultVal: "7" },
    { key: "EXPIRY_JOB_INTERVAL_MS", defaultVal: "3600000" },
    { key: "EXPIRY_CONCURRENCY", defaultVal: "8" },
    { key: "ACCESS_LOG_ENABLED", defaultVal: "true" },
    { key: "ACCESS_LOG_PATH", defaultVal: "'' (stdout only)" },
    { key: "ACCESS_LOG_MAX_BYTES", defaultVal: "10485760" },
    { key: "ACCESS_LOG_MAX_FILES", defaultVal: "5" },
    { key: "LOG_PAYLOADS", defaultVal: "false" },
    { key: "LOG_HEADERS", defaultVal: "false" },
    { key: "TRUST_PROXY", defaultVal: "false" },
    { key: "NOTIFICATION_WEBHOOK_URL", defaultVal: "''" },
    { key: "EMAIL_API_URL", defaultVal: "''" },
    { key: "EMAIL_FROM", defaultVal: "''" },
    { key: "NOTIFICATION_EMAIL", defaultVal: "''" },
    { key: "NOTIFICATION_MAX_RETRIES", defaultVal: "3" },
    { key: "NOTIFICATION_RETRY_BASE_MS", defaultVal: "500" },
    { key: "SUBJECT_NOTIFICATION_WEBHOOKS", defaultVal: "{}" },
    { key: "SOROBAN_POOL_SIZE", defaultVal: "4" },
    { key: "SOROBAN_INVOKE_TIMEOUT_MS", defaultVal: "10000" },
    { key: "STELLAR_CLI", defaultVal: "'stellar'" },
    { key: "STELLAR_NETWORK", defaultVal: "'testnet'" },
    {
      key: "STELLAR_RPC_URL",
      defaultVal: "'https://soroban-testnet.stellar.org'",
    },
    { key: "RPC_CACHE_TTL_MS", defaultVal: "5000" },
    { key: "RPC_MAX_RETRIES", defaultVal: "3" },
    { key: "RPC_RETRY_BASE_MS", defaultVal: "500" },
    { key: "RPC_RETRY_BACKOFF", defaultVal: "2" },
    { key: "EVENT_POLL_INTERVAL_MS", defaultVal: "5000" },
    { key: "CORS_ORIGIN", defaultVal: "'*' in development, none in production" },
    { key: "CORS_CREDENTIALS", defaultVal: "false" },
    { key: "CORS_METHODS", defaultVal: DEFAULT_CORS_METHODS.join(",") },
    { key: "CORS_ALLOWED_HEADERS", defaultVal: DEFAULT_CORS_ALLOWED_HEADERS.join(",") },
    { key: "CORS_EXPOSED_HEADERS", defaultVal: DEFAULT_CORS_EXPOSED_HEADERS.join(",") },
    { key: "CORS_MAX_AGE", defaultVal: String(DEFAULT_CORS_MAX_AGE) },
  ];

  for (const item of defaults) {
    let val;
    if (item.key === "STELLAR_RPC_URL") {
      val = env.STELLAR_RPC_URL ?? env.RPC_URL;
    } else {
      val = env[item.key];
    }
    if (val === undefined || val === "") {
      logger.info({ variable: item.key, defaultValue: item.defaultVal }, 'Using default config value');
    }
  }
}
