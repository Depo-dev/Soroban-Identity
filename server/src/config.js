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

function parseCorsOrigins(value, nodeEnv) {
  // Default: allow all in development, none in production
  if (!value) {
    return nodeEnv === "development" ? ["*"] : [];
  }
  if (value === "*") {
    return ["*"];
  }
  // Comma-separated list of origins
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

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
    corsAllowedOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS, nodeEnv),
    maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, 64 * 1024),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : DEFAULT_DATA_DIR,
    auditLogPath: env.AUDIT_LOG_PATH
      ? path.resolve(env.AUDIT_LOG_PATH)
      : path.join(DEFAULT_DATA_DIR, "audit"),
    auditLogRetentionDays: parseInteger(env.AUDIT_LOG_RETENTION_DAYS, 30),
    credentialStorePath: env.CREDENTIAL_STORE_PATH
      ? path.resolve(env.CREDENTIAL_STORE_PATH)
      : path.join(DEFAULT_DATA_DIR, "credentials.json"),
    redisUrl: env.REDIS_URL ?? "",
    didCacheTtlMs: parseInteger(env.DID_CACHE_TTL_MS, 60 * 1000),
    redisMaxRetries: parseInteger(env.REDIS_MAX_RETRIES, 5),
    redisRetryBaseMs: parseInteger(env.REDIS_RETRY_BASE_MS, 200),
    redisCommandTimeoutMs: parseInteger(env.REDIS_COMMAND_TIMEOUT_MS, 1000),
    cacheFailureThreshold: parseInteger(env.CACHE_FAILURE_THRESHOLD, 3),
    didCacheWarmList: (env.DID_CACHE_WARM_LIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    healthProbeTimeoutMs: parseInteger(env.HEALTH_PROBE_TIMEOUT_MS, 2000),
    redisUrl: env.REDIS_URL ?? "",
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
    { key: "DID_CACHE_TTL_MS", desc: "must be a valid integer" },
    { key: "REDIS_MAX_RETRIES", desc: "must be a valid integer" },
    { key: "REDIS_RETRY_BASE_MS", desc: "must be a valid integer" },
    { key: "REDIS_COMMAND_TIMEOUT_MS", desc: "must be a valid integer" },
    { key: "CACHE_FAILURE_THRESHOLD", desc: "must be a valid integer" },
  ];

  for (const item of numericVars) {
    const val = env[item.key];
    if (val !== undefined && val !== "") {
      if (!/^\d+$/.test(val)) {
        invalid.push(`${item.key}: ${item.desc}`);
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
    { key: "REDIS_URL", defaultVal: "'' (cache disabled)" },
    { key: "DID_CACHE_TTL_MS", defaultVal: "60000" },
    { key: "REDIS_MAX_RETRIES", defaultVal: "5" },
    { key: "CACHE_FAILURE_THRESHOLD", defaultVal: "3" },
    { key: "HEALTH_PROBE_TIMEOUT_MS", defaultVal: "2000" },
    { key: "REDIS_URL", defaultVal: "'' (disabled)" },
    { key: "EXPIRY_CRON_SCHEDULE", defaultVal: "'' (interval mode)" },
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
