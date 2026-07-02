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
  const tempPath = `${filePath}.tmp`;
  
  // Step 1: Write to temporary file
  await fs.writeFile(tempPath, data, 'utf8');
  
  // Step 2: Ensure the file is fully flushed
  // Node.js fs.writeFile with 'utf8' encoding does sync write, but we'll
  // explicitly fsync to ensure durability
  const tempFile = await fs.open(tempPath, 'r');
  try {
    await tempFile.sync();
  } finally {
    await tempFile.close();
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
  const tempPath = `${filePath}.tmp`;
  
  try {
    await fs.access(tempPath);
    // Temporary file exists, check if canonical file exists
    let canonicalExists = false;
    try {
      await fs.access(filePath);
      canonicalExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    
    if (!canonicalExists) {
      // No canonical file, rename temp to canonical
      logger.info({ filePath, tempPath }, 'Recovering orphaned .tmp file');
      await fs.rename(tempPath, filePath);
      return true;
    } else {
      // Both files exist, keep canonical and delete temp
      logger.info({ filePath, tempPath }, 'Cleaning up orphaned .tmp file (canonical exists)');
      await fs.unlink(tempPath);
      return false;
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No orphaned file
      return false;
    }
    throw error;
  }
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
  await fs.appendFile(currentLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
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
  await writeAtomic(config.credentialStorePath, JSON.stringify({ credentials }, null, 2));
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
