import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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

// ── Write-Ahead Log (WAL) for crash-safe storage ─────────────────────────────
/**
 * Atomically write data to a file using a write-ahead log pattern.
 * 1. Write to a temporary file (.tmp)
 * 2. Fully flush the temporary file
 * 3. Atomically rename it over the canonical file
 * 
 * @param {string} filePath - The target file path
 * @param {string} data - The data to write
 * @returns {Promise<void>}
 */
export async function writeAtomic(filePath, data) {
  // Unique suffix per call — prevents concurrent writers from clobbering
  // each other's temp file when writeAtomic is called for the same target
  // path simultaneously (e.g. two concurrent credential writes).
  const suffix = crypto.randomBytes(6).toString('hex');
  const tempPath = `${filePath}.${suffix}.tmp`;

  // Step 1: Write to temporary file
  await fs.writeFile(tempPath, data, 'utf8');

  // Step 2: Attempt to ensure the file is fully flushed (fsync on Unix)
  // Skip fsync on Windows where it may fail with EPERM
  if (process.platform !== 'win32') {
    const tempFile = await fs.open(tempPath, 'r');
    try {
      await tempFile.sync();
    } finally {
      await tempFile.close();
    }
  }

  // Step 3: Atomically rename
  await fs.rename(tempPath, filePath);
}

/**
 * Recover orphaned .tmp files on startup.
 * Should be called before accepting requests.
 * 
 * @param {string} filePath - The canonical file path to check for recovery
 * @returns {Promise<boolean>} True if recovery was performed, false otherwise
 */
export async function recoverOrphanedFile(filePath) {
  // Find any orphaned temp files matching the pattern <filePath>.<hex>.tmp
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  // Match files written by the new writeAtomic: <base>.<6-hex-chars>.tmp
  const tempPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{6}\\.tmp$`);
  const orphans = entries.filter((e) => tempPattern.test(e));

  if (orphans.length === 0) return false;

  let canonicalExists = false;
  try {
    await fs.access(filePath);
    canonicalExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const orphan of orphans) {
    const orphanPath = path.join(dir, orphan);
    if (!canonicalExists) {
      // Promote the first orphan to canonical; delete the rest
      logger.info({ filePath, orphanPath }, 'Recovering orphaned .tmp file');
      await fs.rename(orphanPath, filePath);
      canonicalExists = true;
    } else {
      logger.info({ filePath, orphanPath }, 'Cleaning up orphaned .tmp file (canonical exists)');
      await fs.unlink(orphanPath);
    }
  }

  return true;
}

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

/**
 * Per-path credential cache.
 * Keyed by the resolved credentialStorePath so that two different configs
 * pointing at different files never share cached data.
 *
 * Each entry: { credentials: Array, timestamp: number }
 */
const _credentialCacheMap = new Map();

export function clearCredentialCache(config) {
  if (config?.credentialStorePath) {
    _credentialCacheMap.delete(path.resolve(config.credentialStorePath));
  } else {
    // No config supplied — clear everything (used by tests that want a full reset)
    _credentialCacheMap.clear();
  }
}

export async function ensureDataDir(config) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.dirname(config.auditLogPath), { recursive: true });
  await fs.mkdir(path.dirname(config.credentialStorePath), { recursive: true });
  await cleanOldAuditLogs(config);
  
  // Recover orphaned .tmp files on startup
  await recoverOrphanedFile(config.credentialStorePath);
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
  const release = await _acquireFileLock(currentLogPath);
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
// Used by both appendAuditLog and the credential read-modify-write path.
// ---------------------------------------------------------------------------
const _fileLocks = new Map();

/**
 * Track the number of waiters queued per file path so we can warn if the
 * queue grows too deep (indicating a slow disk or a runaway caller).
 */
const _fileLockDepth = new Map();

/** Emit a warning when the queue depth for any single file exceeds this limit. */
const FILE_LOCK_WARN_DEPTH = 1000;

/**
 * Acquire an exclusive write lock for `filePath`.
 * Returns a release function that MUST be called (in a finally block) to
 * unblock the next waiter.
 *
 * @param {string} filePath
 * @returns {Promise<() => void>}
 */
function _acquireFileLock(filePath) {
  const current = _fileLocks.get(filePath) ?? Promise.resolve();

  const depth = (_fileLockDepth.get(filePath) ?? 0) + 1;
  _fileLockDepth.set(filePath, depth);
  if (depth > FILE_LOCK_WARN_DEPTH) {
    console.warn(
      `[_acquireFileLock] Write queue depth for "${filePath}" is ${depth}, ` +
        `which exceeds the warning threshold of ${FILE_LOCK_WARN_DEPTH}. ` +
        'The disk may be slow or callers are overwhelming this path.',
    );
  }

  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });

  _fileLocks.set(filePath, current.then(() => next));

  return current.then(() => {
    _fileLockDepth.set(filePath, (_fileLockDepth.get(filePath) ?? 1) - 1);
    return release;
  });
}

export async function readCredentials(config) {
  const storePath = path.resolve(config.credentialStorePath);
  const now = Date.now();
  const cached = _credentialCacheMap.get(storePath);
  if (cached !== undefined && now - cached.timestamp < TTL_MS) {
    return cached.credentials;
  }
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    _credentialCacheMap.set(storePath, { credentials, timestamp: now });
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const credentials = [];
      _credentialCacheMap.set(storePath, { credentials, timestamp: now });
      return credentials;
    }
    throw error;
  }
}

export async function writeCredentials(config, credentials) {
  await ensureDataDir(config);
  await writeAtomic(config.credentialStorePath, JSON.stringify({ credentials }, null, 2));
  _credentialCacheMap.delete(path.resolve(config.credentialStorePath));
}

/**
 * Atomically create a new credential under a per-file mutex.
 *
 * Callers MUST use this instead of the bare readCredentials →
 * createCredential → writeCredentials sequence to avoid the lost-update
 * race: two concurrent requests reading the same snapshot and each
 * writing back only their own addition, silently discarding the other.
 *
 * Throws DuplicateCredentialError if a credential with the same id already
 * exists (consistent with the pure createCredential helper).
 *
 * @param {object} config
 * @param {object} credential
 * @returns {Promise<object[]>} The updated credentials array
 */
export async function createAndPersistCredential(config, credential) {
  const storePath = path.resolve(config.credentialStorePath);
  const release = await _acquireFileLock(storePath);
  try {
    // Re-read inside the lock — gets the freshest state regardless of cache
    const current = await readCredentials(config);
    const updated = createCredential(current, credential); // throws DuplicateCredentialError
    await writeCredentials(config, updated);
    return updated;
  } finally {
    release();
  }
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

// ── Expiry scanner watermark persistence ──────────────────────────────────────
/**
 * Get the path where the expiry watermark is stored.
 * 
 * @param {Object} config - Configuration object with dataDir
 * @returns {string} Path to the watermark file
 */
export function getExpiryWatermarkPath(config) {
  return path.join(config.dataDir, 'expiry-watermark.json');
}

/**
 * Read the persisted expiry watermark (next ledger to scan).
 * Returns null if the watermark file doesn't exist.
 * 
 * @param {Object} config - Configuration object
 * @returns {Promise<number|null>} The next ledger to scan, or null if not persisted
 */
export async function readExpiryWatermark(config) {
  const filePath = getExpiryWatermarkPath(config);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const nextLedger = Number(parsed.nextLedger);
    if (Number.isFinite(nextLedger)) {
      return nextLedger;
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    logger.warn({ error: error.message, filePath }, 'Failed to read expiry watermark, will use default');
  }
  return null;
}

/**
 * Persist the expiry watermark (next ledger to scan).
 * Uses atomic write-ahead log pattern for crash-safety.
 * 
 * @param {Object} config - Configuration object
 * @param {number} nextLedger - The next ledger to scan
 * @returns {Promise<void>}
 */
export async function writeExpiryWatermark(config, nextLedger) {
  await ensureDataDir(config);
  const filePath = getExpiryWatermarkPath(config);
  await writeAtomic(filePath, JSON.stringify({ nextLedger }, null, 2));
}
