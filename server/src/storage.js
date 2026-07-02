import fs from 'node:fs/promises';
import path from 'node:path';
import { requestContextStore } from './request-context.js';
import { logger } from './logger.js';

// ── StorageAdapter interface (#389) ──────────────────────────────────────────
// Custom adapters must export a default object implementing:
//   read(id)           → Promise<object|null>
//   write(id, data)    → Promise<void>
//   delete(id)         → Promise<boolean>
//   list()             → Promise<object[]>
//
// Set STORAGE_ADAPTER to the absolute path of a custom adapter module.
// When unset, the filesystem adapter below is used.

let _customAdapter = null;

export async function loadStorageAdapter() {
  const adapterPath = process.env.STORAGE_ADAPTER;
  if (!adapterPath) return null;
  const mod = await import(adapterPath);
  const adapter = mod.default ?? mod;
  for (const method of ['read', 'write', 'delete', 'list']) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`StorageAdapter at ${adapterPath} is missing method: ${method}`);
    }
  }
  _customAdapter = adapter;
  return adapter;
}

export function getStorageAdapter() { return _customAdapter; }

let lastCheckedDate = null;

export async function cleanOldAuditLogs(config) {
  const dir = path.dirname(config.auditLogPath);
  const baseName = path.basename(config.auditLogPath);
  const escapedBaseName = baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`^${escapedBaseName}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`);

  try {
    const files = await fs.readdir(dir);
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    for (const file of files) {
      const match = file.match(regex);
      if (!match) continue;

      const dateStr = match[1];
      const parts = dateStr.split('-');
      const fileYear = parseInt(parts[0], 10);
      const fileMonth = parseInt(parts[1], 10) - 1;
      const fileDay = parseInt(parts[2], 10);
      const fileUtc = Date.UTC(fileYear, fileMonth, fileDay);

      const ageInMs = todayUtc - fileUtc;
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);

      if (ageInDays > config.auditLogRetentionDays) {
        await fs.unlink(path.join(dir, file));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error({ error: error.message, stack: error.stack, dir }, 'Failed to clean old audit logs');
    }
  }
}

export const TTL_MS = Number(process.env.CREDENTIAL_CACHE_TTL_MS ?? 5000);

let _credentialCache = null;
let _cacheTimestamp = 0;

export function clearCredentialCache() {
  _credentialCache = null;
  _cacheTimestamp = 0;
}

export async function ensureDataDir(config) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.dirname(config.auditLogPath), { recursive: true });
  await fs.mkdir(path.dirname(config.credentialStorePath), { recursive: true });
  await cleanOldAuditLogs(config);
}

export async function appendAuditLog(config, entry) {
  const dateString = new Date().toISOString().split('T')[0];
  const currentLogPath = `${config.auditLogPath}-${dateString}.ndjson`;

  if (lastCheckedDate !== dateString) {
    await fs.mkdir(path.dirname(currentLogPath), { recursive: true });
    lastCheckedDate = dateString;
  }

  const record = { timestamp: new Date().toISOString(), ...entry };
  const line = `${JSON.stringify(record)}\n`;

  // Acquire a per-file mutex so concurrent callers queue up and each write
  // lands as a complete NDJSON line rather than being interleaved.
  const release = await _acquireAuditLock(currentLogPath);
  try {
    await fs.appendFile(currentLogPath, line, 'utf8');
  } finally {
    release();
  }

  return record;
}

// ---------------------------------------------------------------------------
// Minimal per-path mutex — no external dependencies required.
// Each entry in the map is a Promise chain; callers append to the tail so they
// execute one at a time for a given file path.
// ---------------------------------------------------------------------------
const _auditLocks = new Map();

/**
 * Track the number of waiters queued per file path so we can warn if the
 * queue grows too deep (indicating a slow disk or a runaway caller).
 */
const _auditLockDepth = new Map();

/** Emit a warning when the queue depth for any single file exceeds this limit. */
const AUDIT_LOCK_WARN_DEPTH = 1000;

/**
 * Acquire an exclusive write lock for `filePath`.
 * Returns a release function that MUST be called (in a finally block) to
 * unblock the next waiter.
 *
 * Logs a warning when the pending queue depth for a given file path exceeds
 * AUDIT_LOCK_WARN_DEPTH (1000) to surface runaway callers or slow-disk
 * conditions before the queue grows unboundedly.
 *
 * @param {string} filePath
 * @returns {Promise<() => void>}
 */
function _acquireAuditLock(filePath) {
  // Retrieve (or create) the current tail of the promise chain for this path.
  const current = _auditLocks.get(filePath) ?? Promise.resolve();

  // Track queue depth and warn if it grows unboundedly.
  const depth = (_auditLockDepth.get(filePath) ?? 0) + 1;
  _auditLockDepth.set(filePath, depth);
  if (depth > AUDIT_LOCK_WARN_DEPTH) {
    console.warn(
      `[appendAuditLog] Write queue depth for "${filePath}" is ${depth}, ` +
        `which exceeds the warning threshold of ${AUDIT_LOCK_WARN_DEPTH}. ` +
        'The disk may be slow or callers are overwhelming the log endpoint.',
    );
  }

  let release;
  // Build a new promise whose resolution is controlled by the caller.
  const next = new Promise((resolve) => {
    release = resolve;
  });

  // The new tail: wait for the previous holder to finish, then let this caller
  // proceed.  We store the unchained `next` as the new tail so the *next*
  // caller waits for *this* caller to release.
  _auditLocks.set(
    filePath,
    // Chain: when `current` resolves the next caller can enter.
    // We keep `next` in the map (not `current.then(...)`) so that garbage
    // collection can collect settled promises once the queue drains.
    current.then(() => next),
  );

  // Return a promise that resolves to the release function once the previous
  // holder has finished.  Decrement the depth counter on entry.
  return current.then(() => {
    _auditLockDepth.set(filePath, (_auditLockDepth.get(filePath) ?? 1) - 1);
    return release;
  });
}

export async function readCredentials(config) {
  const now = Date.now();
  if (_credentialCache !== null && now - _cacheTimestamp < TTL_MS) {
    return _credentialCache;
  }
  try {
    const raw = await fs.readFile(config.credentialStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    _credentialCache = credentials;
    _cacheTimestamp = now;
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') {
      _credentialCache = [];
      _cacheTimestamp = now;
      return _credentialCache;
    }
    throw error;
  }
}

export async function writeCredentials(config, credentials) {
  await ensureDataDir(config);
  await fs.writeFile(config.credentialStorePath, JSON.stringify({ credentials }, null, 2), 'utf8');
  _credentialCache = null;
  _cacheTimestamp = 0;
}

export function upsertCredential(credentials, credential) {
  const index = credentials.findIndex((item) => item.id === credential.id);
  if (index === -1) return [...credentials, credential];
  const next = credentials.map((c) => ({ ...c }));
  next[index] = { ...next[index], ...credential };
  return next;
}

export class DuplicateCredentialError extends Error {
  constructor(id) {
    super(`Credential with ID "${id}" already exists`);
    this.name = 'DuplicateCredentialError';
    this.id = id;
  }
}

export function createCredential(credentials, credential) {
  if (credentials.some((item) => item.id === credential.id)) {
    throw new DuplicateCredentialError(credential.id);
  }
  return [...credentials, credential];
}
