import { readCredentials, upsertCredential, writeCredentials } from './storage.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let _indexedCredentials = null;
let _expiryIndex = null;

/**
 * Create a bounded concurrency limiter that processes tasks with a maximum
 * number of concurrent executions.
 * 
 * @param {number} concurrency - Maximum number of concurrent tasks
 * @returns {Function} Async function that wraps a task with concurrency control
 */
function createConcurrencyPool(concurrency) {
  let running = 0;
  const queue = [];
  
  async function run(fn) {
    while (running >= concurrency) {
      await new Promise(resolve => queue.push(resolve));
    }
    
    running++;
    try {
      return await fn();
    } finally {
      running--;
      const next = queue.shift();
      if (next) next();
    }
  }
  
  return run;
}

/**
 * Build a sorted index of credentials that have an `expires_at` value, ordered
 * ascending by expiry time. Pass this to `findExpiringCredentials` to avoid
 * O(n) scans on every call.
 *
 * @param {Array} credentials - Full credentials array.
 * @returns {Array} Sorted array of credentials with `expires_at > 0`.
 */
export function buildExpiryIndex(credentials) {
  return credentials
    .filter((c) => Number(c.expires_at) > 0)
    .sort((a, b) => Number(a.expires_at) - Number(b.expires_at));
}

function lowerBound(index, nowMs) {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(index[mid].expires_at) * 1000 < nowMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(index, upper) {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(index[mid].expires_at) * 1000 <= upper) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function findExpiringCredentials(credentials, { windowDays, now = new Date(), includeNotified = false } = {}) {
  if (_indexedCredentials !== credentials) {
    _expiryIndex = buildExpiryIndex(credentials);
    _indexedCredentials = credentials;
  }

  const nowMs = now.getTime();
  const upper = nowMs + windowDays * DAY_MS;

  const lo = lowerBound(_expiryIndex, nowMs);
  const hi = upperBound(_expiryIndex, upper);

  return _expiryIndex
    .slice(lo, hi)
    .filter((c) => includeNotified || !c.expiry_notified_at);
}

/**
 * Cursor-based pagination over an array sorted by `id`.
 * The cursor is the last-seen `id`; pass null/undefined for the first page.
 */
export function paginateCursor(items, { limit = 50, cursor = null } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const startIndex = cursor
    ? items.findIndex((item) => item.id === cursor) + 1
    : 0;
  const page = items.slice(startIndex, startIndex + safeLimit);
  const nextCursor = page.length === safeLimit && startIndex + safeLimit < items.length
    ? page[page.length - 1].id
    : null;
  return { items: page, nextCursor };
}

export function paginate(items, { page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number.parseInt(pageSize, 10) || 50));
  const start = (safePage - 1) * safePageSize;
  return {
    page: safePage,
    pageSize: safePageSize,
    total: items.length,
    items: items.slice(start, start + safePageSize),
  };
}

export class ExpiryNotificationJob {
  constructor(config, soroban = null) {
    this.config = config;
    this.soroban = soroban;
    this.timer = null;
    this.nextLedger = Number.parseInt(process.env.EXPIRY_EVENTS_START_LEDGER ?? '0', 10);

    // Use the validated value from config rather than re-parsing the env var
    // inline. config.expiryConcurrency has already been through parseInteger's
    // NaN/< 1 guards, so we only need to enforce a floor of 1 here.
    this.concurrency = Math.max(1, config.expiryConcurrency ?? 8);
    
    logger.info({ concurrency: this.concurrency }, 'Expiry notification job concurrency configured');
  }

  /**
   * Load the persisted watermark on startup.
   * If persisted watermark exists, it takes precedence over EXPIRY_EVENTS_START_LEDGER.
   * 
   * @returns {Promise<void>}
   */
  async loadWatermark() {
    const { readExpiryWatermark } = await import('./storage.js');
    const persistedLedger = await readExpiryWatermark(this.config);
    if (persistedLedger !== null) {
      logger.info({ persistedLedger, previousDefault: this.nextLedger }, 'Loaded persisted expiry watermark');
      this.nextLedger = persistedLedger;
    }
  }

  /**
   * Persist the current watermark to storage.
   * 
   * @returns {Promise<void>}
   */
  async persistWatermark() {
    const { writeExpiryWatermark } = await import('./storage.js');
    await writeExpiryWatermark(this.config, this.nextLedger);
  }

  start() {
    if (this.timer) return;
    this.runOnce().catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Expiry job failed'));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Expiry job failed'));
    }, this.config.expiryJobIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    let credentials = await readCredentials(this.config);
    credentials = await this.indexCredentialEvents(credentials);
    const expiring = findExpiringCredentials(credentials, { windowDays: this.config.expiryWarningDays });
    
    // Always persist credentials, even if none are expiring
    if (expiring.length === 0) {
      await writeCredentials(this.config, credentials);
      await this.persistWatermark();
      return 0;
    }
    
    logger.info({ count: expiring.length, concurrency: this.concurrency }, 'Processing expiring credentials');
    
    // Create bounded concurrency pool
    const pool = createConcurrencyPool(this.concurrency);
    
    // Process credentials concurrently with bounded parallelism
    const results = await Promise.allSettled(
      expiring.map(credential => 
        pool(async () => {
          try {
            await this.dispatch(credential);
            return { credential, success: true };
          } catch (error) {
            logger.error({ 
              credentialId: credential.id,
              error: error.message,
              stack: error.stack 
            }, 'Failed to dispatch expiry notification');
            return { credential, success: false, error };
          }
        })
      )
    );
    
    // Update credentials with notification timestamps for successful dispatches
    let updated = credentials;
    let successCount = 0;
    let failureCount = 0;
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        const { credential } = result.value;
        updated = upsertCredential(updated, { 
          ...credential, 
          expiry_notified_at: new Date().toISOString() 
        });
        successCount++;
      } else {
        failureCount++;
      }
    }
    
    await writeCredentials(this.config, updated);
    await this.persistWatermark();
    
    logger.info({ 
      total: expiring.length,
      success: successCount,
      failed: failureCount 
    }, 'Completed expiry notification processing');
    
    return successCount;
  }

  async indexCredentialEvents(credentials) {
    if (!this.soroban) return credentials;
    const events = await this.soroban.getEvents(this.nextLedger);
    let next = credentials;
    for (const event of events) {
      const credential = credentialFromEvent(event);
      if (credential) next = upsertCredential(next, credential);
    }
    const newest = events.map((event) => Number(event.ledger ?? 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (newest) this.nextLedger = newest + 1;
    return next;
  }

  async dispatch(credential) {
    const target = this.config.subjectNotificationWebhooks[credential.subject] ?? this.config.notificationWebhookUrl;
    if (!target) return;
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'credential.expiring',
        credential_id: credential.id,
        subject: credential.subject,
        issuer: credential.issuer,
        expires_at: credential.expires_at,
        warning_window_days: this.config.expiryWarningDays,
      }),
    });
    if (!response.ok) throw new Error(`notification dispatch failed with HTTP ${response.status}`);
  }
}

/**
 * Classify events based on the contract's actual topic structure.
 * Credential-issued events from credential-manager have topics: ["CRED", "issued"]
 * where CRED is a Symbol short-code (represented as a string in the topic array).
 * 
 * @param {Object} event - Event object from Soroban RPC
 * @returns {Object|null} Extracted credential data or null if not a credential-issued event
 */
export function credentialFromEvent(event) {
  // Soroban contract events have a 'topic' array with Symbol values
  // Credential-issued events have topics: (CRED, symbol_short!("issued"))
  // In the event structure, this becomes something like ["CRED", "issued"] or similar
  if (!event || typeof event !== 'object') return null;
  
  const topic = event.topic;
  if (!Array.isArray(topic) || topic.length < 2) return null;
  
  // Check if this is a credential-issued event by examining the topic
  // The contract uses (CRED, symbol_short!("issued")) where CRED = symbol_short!("CRED")
  // After deserialization, the topic array should contain these symbols
  // Both should be present and in order
  const topicStr = JSON.stringify(topic).toLowerCase();
  const isCreditIssuedTopic = topicStr.includes('cred') && topicStr.includes('issued');
  
  if (!isCreditIssuedTopic) return null;
  
  // Extract credential data from the event value
  const value = event.value ?? event.data ?? event;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  
  const id = value.id ?? value.credential_id;
  const subject = value.subject;
  const issuer = value.issuer;
  const expires_at = Number(value.expires_at);
  
  if (id && subject && issuer && Number.isFinite(expires_at)) {
    return { id, subject, issuer, expires_at, source: 'event' };
  }
  
  return null;
}
