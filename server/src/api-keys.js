import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeAtomic, recoverOrphanedFile, ensureDataDir } from './storage.js';
import { logger } from './logger.js';

/**
 * Hash raw API key using SHA-256 for secure storage at rest.
 * @param {string} rawKey 
 * @returns {string} 64-character lowercase hex SHA-256 hash
 */
export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export class ApiKeyService {
  constructor(config = {}) {
    this.config = config;
    this.storePath = config.apiKeyStorePath
      ? path.resolve(config.apiKeyStorePath)
      : path.join(config.dataDir || path.resolve(process.cwd(), 'data'), 'api-keys.json');
    this.keys = new Map();
    this.byHash = new Map();
    this.loaded = false;
  }

  async load() {
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await recoverOrphanedFile(this.storePath);
      const raw = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed.keys) ? parsed.keys : [];
      this.keys.clear();
      this.byHash.clear();
      for (const record of list) {
        this.keys.set(record.id, record);
        if (record.hashedKey) {
          this.byHash.set(record.hashedKey, record.id);
        }
      }
      this.loaded = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.keys.clear();
        this.byHash.clear();
        this.loaded = true;
        return;
      }
      logger.warn({ error: err.message, path: this.storePath }, 'Could not read API keys store file');
      this.loaded = true;
    }
  }

  async persist() {
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const payload = JSON.stringify({ keys: Array.from(this.keys.values()) }, null, 2);
      await writeAtomic(this.storePath, payload);
    } catch (err) {
      logger.error({ error: err.message, path: this.storePath }, 'Failed to persist API keys store');
      throw err;
    }
  }

  /**
   * Issue a new API key with configurable permissions, tier, and expiration.
   */
  async issueKey({ name = 'default', owner = 'system', scopes = ['credentials:read'], tier = 'free', expiresInDays = null } = {}) {
    if (!this.loaded) await this.load();

    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const rawKey = `sk_${rawSecret}`;
    const hashedKey = hashApiKey(rawKey);
    const now = Date.now();
    const expiresAt = expiresInDays ? now + expiresInDays * 24 * 60 * 60 * 1000 : null;

    const record = {
      id,
      name,
      owner,
      keyPrefix: rawKey.slice(0, 7) + '...',
      hashedKey,
      scopes: Array.isArray(scopes) ? scopes : [scopes],
      tier: tier || 'free',
      status: 'active',
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
    };

    this.keys.set(id, record);
    this.byHash.set(hashedKey, id);
    await this.persist();

    return {
      apiKey: rawKey,
      id,
      name,
      owner,
      keyPrefix: record.keyPrefix,
      scopes: record.scopes,
      tier: record.tier,
      status: record.status,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  }

  /**
   * Validate raw API key, verify active status and expiration, and touch lastUsedAt.
   */
  async validateKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    if (!this.loaded) await this.load();

    const hashed = hashApiKey(rawKey);
    const keyId = this.byHash.get(hashed);
    if (!keyId) {
      // Dummy constant-time comparison to protect against side-channels
      crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
      return null;
    }

    const record = this.keys.get(keyId);
    if (!record) return null;

    if (record.status !== 'active') {
      return null;
    }

    const now = Date.now();
    if (record.expiresAt && record.expiresAt < now) {
      return null;
    }

    // Touch last used timestamp
    record.lastUsedAt = now;
    // Debounced persist or fire-and-forget
    this.persist().catch((err) => logger.warn({ error: err.message }, 'Failed to persist lastUsedAt'));

    return record;
  }

  /**
   * List metadata for all keys (secrets excluded).
   */
  async listKeys() {
    if (!this.loaded) await this.load();
    return Array.from(this.keys.values()).map(({ hashedKey, ...rest }) => ({
      ...rest,
      createdAt: new Date(rest.createdAt).toISOString(),
      expiresAt: rest.expiresAt ? new Date(rest.expiresAt).toISOString() : null,
      lastUsedAt: rest.lastUsedAt ? new Date(rest.lastUsedAt).toISOString() : null,
    }));
  }

  /**
   * Get metadata for a specific key.
   */
  async getKey(id) {
    if (!this.loaded) await this.load();
    const record = this.keys.get(id);
    if (!record) return null;
    const { hashedKey, ...rest } = record;
    return {
      ...rest,
      createdAt: new Date(rest.createdAt).toISOString(),
      expiresAt: rest.expiresAt ? new Date(rest.expiresAt).toISOString() : null,
      lastUsedAt: rest.lastUsedAt ? new Date(rest.lastUsedAt).toISOString() : null,
    };
  }

  /**
   * Revoke an API key.
   */
  async revokeKey(id) {
    if (!this.loaded) await this.load();
    const record = this.keys.get(id);
    if (!record) return false;

    record.status = 'revoked';
    record.revokedAt = Date.now();
    this.byHash.delete(record.hashedKey);
    await this.persist();
    return true;
  }

  /**
   * Delete an API key completely.
   */
  async deleteKey(id) {
    if (!this.loaded) await this.load();
    const record = this.keys.get(id);
    if (!record) return false;

    this.byHash.delete(record.hashedKey);
    this.keys.delete(id);
    await this.persist();
    return true;
  }

  /**
   * Rotate an API key, issuing a new secret and invalidating the previous one.
   */
  async rotateKey(id, { expiresInDays = null } = {}) {
    if (!this.loaded) await this.load();
    const record = this.keys.get(id);
    if (!record) return null;

    // Remove old hash mapping
    this.byHash.delete(record.hashedKey);

    const rawSecret = crypto.randomBytes(32).toString('hex');
    const newRawKey = `sk_${rawSecret}`;
    const newHashedKey = hashApiKey(newRawKey);
    const now = Date.now();
    const expiresAt = expiresInDays ? now + expiresInDays * 24 * 60 * 60 * 1000 : record.expiresAt;

    record.hashedKey = newHashedKey;
    record.keyPrefix = newRawKey.slice(0, 7) + '...';
    record.status = 'active';
    record.rotatedAt = now;
    record.expiresAt = expiresAt;

    this.byHash.set(newHashedKey, id);
    await this.persist();

    return {
      apiKey: newRawKey,
      id: record.id,
      name: record.name,
      owner: record.owner,
      keyPrefix: record.keyPrefix,
      scopes: record.scopes,
      tier: record.tier,
      status: record.status,
      rotatedAt: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  }
}
