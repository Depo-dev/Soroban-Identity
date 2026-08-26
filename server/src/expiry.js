import { readCredentials, upsertCredential, writeCredentials } from './storage.js';
import { logger } from './logger.js';
import { CronJob } from './cron.js';
import { EmailTransport, renderExpirySubject, renderExpiryBody, resolveRecipient } from './email.js';
import { appendNotificationLog } from './notification-log.js';

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

export function findExpiringCredentials(
  credentials,
  {
    windowDays,
    thresholds = [30, 7, 1],
    now = new Date(),
    includeNotified = false,
    includeSnoozed = false,
  } = {}
) {
  if (_indexedCredentials !== credentials) {
    _expiryIndex = buildExpiryIndex(credentials);
    _indexedCredentials = credentials;
  }

  const nowMs = now.getTime();
  const sortedThresholds = Array.isArray(thresholds) && thresholds.length > 0
    ? [...thresholds].sort((a, b) => a - b)
    : null;
  const maxThreshold = sortedThresholds ? sortedThresholds[sortedThresholds.length - 1] : 7;
  const effectiveWindowDays = windowDays ?? maxThreshold;
  const upper = nowMs + effectiveWindowDays * DAY_MS;

  const lo = lowerBound(_expiryIndex, nowMs);
  const hi = upperBound(_expiryIndex, upper);

  return _expiryIndex
    .slice(lo, hi)
    .filter((c) => {
      // Exclude dismissed credentials unless requested
      if (!includeSnoozed && c.expiry_dismissed) return false;
      // Exclude snoozed credentials unless snooze has expired
      if (!includeSnoozed && c.snoozed_until && Number(c.snoozed_until) > nowMs) return false;

      if (includeNotified) return true;

      // When thresholds are specified (e.g. [1, 7, 30])
      if (sortedThresholds) {
        const expiresAtMs = Number(c.expires_at || c.expiresAt) * 1000;
        const daysRemaining = Math.max(0, Math.ceil((expiresAtMs - nowMs) / DAY_MS));
        c.daysRemaining = daysRemaining;

        // Find applicable threshold: smallest threshold >= daysRemaining
        const dueThreshold = sortedThresholds.find((t) => daysRemaining <= t);
        if (dueThreshold === undefined) return false;

        const notifiedThresholds = Array.isArray(c.notified_thresholds) ? c.notified_thresholds : [];
        if (notifiedThresholds.includes(dueThreshold)) return false;

        c.dueThreshold = dueThreshold;
        return true;
      }

      return !c.expiry_notified_at;
    });
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
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / safePageSize) || 1;
  // Normalise to 0-based index internally so that a 1-indexed `page` param
  // never causes the final item to appear on a phantom extra page.
  const start = (safePage - 1) * safePageSize;
  // Clamp end to the actual array length to prevent duplicates on the last page.
  const end = Math.min(start + safePageSize, totalItems);
  const hasNextPage = end < totalItems;
  return {
    page: safePage,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    hasNextPage,
    items: start >= totalItems ? [] : items.slice(start, end),
  };
}

export class ExpiryNotificationJob {
  constructor(config, soroban = null, { emailTransport = null } = {}) {
    this.config = config;
    this.soroban = soroban;
    this.emailTransport = emailTransport ?? new EmailTransport(config);
    this.cronJob = null;
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

  /**
   * Start the job.
   *
   * When `EXPIRY_CRON_SCHEDULE` is set the job runs on that cron schedule;
   * otherwise it falls back to the historical fixed-interval behaviour so
   * existing deployments keep working unchanged.
   */
  start() {
    if (this.timer || this.cronJob) return;

    const runSafely = () =>
      this.runOnce().catch((error) =>
        logger.error({ error: error.message, stack: error.stack }, 'Expiry job failed'),
      );

    if (this.config.expiryCronSchedule) {
      this.cronJob = new CronJob(this.config.expiryCronSchedule, () => this.runOnce(), {
        name: 'expiry-notifications',
      });
      this.cronJob.start();
      return;
    }

    runSafely();
    this.timer = setInterval(runSafely, this.config.expiryJobIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cronJob) this.cronJob.stop();
    this.cronJob = null;
  }

  async runOnce() {
    let credentials = await readCredentials(this.config);
    credentials = await this.indexCredentialEvents(credentials);
    const thresholds = this.config.expiryReminderThresholds ?? [30, 7, 1];
    const expiring = findExpiringCredentials(credentials, {
      thresholds,
      windowDays: Math.max(...thresholds, this.config.expiryWarningDays ?? 7),
    });
    
    // Always persist credentials, even if none are expiring
    if (expiring.length === 0) {
      await writeCredentials(this.config, credentials);
      await this.persistWatermark();
      return 0;
    }
    
    logger.info({ count: expiring.length, concurrency: this.concurrency, thresholds }, 'Processing expiring credentials');
    
    // Create bounded concurrency pool
    const pool = createConcurrencyPool(this.concurrency);
    
    // Process credentials concurrently with bounded parallelism
    const results = await Promise.allSettled(
      expiring.map(credential => 
        pool(async () => {
          try {
            const dispatchResult = await this.dispatch(credential);
            return { credential, success: true, dispatchResult };
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
    
    // Update credentials with notification timestamps and delivery status
    let updated = credentials;
    let successCount = 0;
    let failureCount = 0;
    const nowIso = new Date().toISOString();
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        const { credential, dispatchResult } = result.value;
        const dueThreshold = credential.dueThreshold ?? this.config.expiryWarningDays ?? 7;
        const notifiedThresholds = Array.isArray(credential.notified_thresholds)
          ? [...new Set([...credential.notified_thresholds, dueThreshold])]
          : [dueThreshold];

        updated = upsertCredential(updated, { 
          ...credential, 
          expiry_notified_at: nowIso,
          notified_thresholds: notifiedThresholds,
          last_delivery_status: {
            status: 'delivered',
            timestamp: nowIso,
            threshold: dueThreshold,
            target: dispatchResult?.target,
          },
        });
        successCount++;
      } else {
        const credential = result.status === 'fulfilled' ? result.value.credential : null;
        if (credential) {
          updated = upsertCredential(updated, {
            ...credential,
            last_delivery_status: {
              status: 'failed',
              timestamp: nowIso,
              error: result.value?.error?.message ?? 'Dispatch error',
            },
          });
        }
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

  /**
   * Deliver expiry notifications for one credential across every configured
   * channel (webhook and email). Each channel is attempted independently with
   * bounded retries, and every attempt is written to the notification log.
   *
   * Resolves when at least one channel delivered, or when every configured
   * channel was skipped. Throws when all configured channels failed.
   */
  async dispatch(credential) {
    const expiresAt = Number(credential.expires_at || credential.expiresAt);
    const now = Math.floor(Date.now() / 1000);
    const daysRemaining =
      credential.daysRemaining ?? Math.max(0, Math.ceil((expiresAt - now) / (24 * 3600)));
    const threshold = credential.dueThreshold ?? this.config.expiryWarningDays ?? 7;

    const results = await Promise.all([
      this.deliverWebhook(credential, { expiresAt, daysRemaining, threshold }),
      this.deliverEmail(credential, { daysRemaining, threshold }),
    ]);

    const delivered = results.filter((result) => result.status === 'delivered');
    const failed = results.filter((result) => result.status === 'failed');

    if (delivered.length === 0 && failed.length > 0) {
      throw new Error(
        `all notification channels failed: ${failed
          .map((result) => `${result.channel}: ${result.error}`)
          .join('; ')}`,
      );
    }

    return {
      target: delivered[0]?.target ?? null,
      skipped: delivered.length === 0,
      channels: results,
      daysRemaining,
      threshold,
    };
  }

  /**
   * Run one delivery attempt with exponential backoff, logging every attempt
   * (success or failure) to the notification log.
   */
  async attemptWithRetries({ credential, channel, target, threshold, daysRemaining, send }) {
    const maxRetries = Math.max(1, this.config.notificationMaxRetries ?? 3);
    const baseMs = Math.max(1, this.config.notificationRetryBaseMs ?? 500);
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const startTime = Date.now();
      try {
        const result = await send();
        await appendNotificationLog(this.config, {
          credentialId: credential.id,
          channel,
          status: 'delivered',
          target,
          threshold,
          daysRemaining,
          attempt,
          durationMs: result?.durationMs ?? Date.now() - startTime,
        });
        logger.info(
          { credentialId: credential.id, channel, target, attempt, threshold, daysRemaining },
          'Expiry notification delivered',
        );
        // Spread first so the channel-level `status` is never shadowed by the
        // transport's HTTP status code.
        return {
          ...result,
          httpStatus: result?.status,
          channel,
          status: 'delivered',
          target,
          attempt,
        };
      } catch (error) {
        lastError = error;
        await appendNotificationLog(this.config, {
          credentialId: credential.id,
          channel,
          status: 'failed',
          target,
          threshold,
          daysRemaining,
          attempt,
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        logger.warn(
          {
            credentialId: credential.id,
            channel,
            target,
            attempt,
            maxRetries,
            error: error.message,
          },
          'Expiry notification attempt failed',
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
        }
      }
    }

    return { channel, status: 'failed', target, error: lastError?.message ?? 'unknown error' };
  }

  async deliverWebhook(credential, { expiresAt, daysRemaining, threshold }) {
    const target =
      this.config.subjectNotificationWebhooks[credential.subject] ??
      credential.notificationWebhookUrl ??
      this.config.notificationWebhookUrl;

    if (!target) {
      return { channel: 'webhook', status: 'skipped', target: null };
    }

    const payload = {
      type: 'credential.expiry_reminder',
      event: 'credential.expiry_reminder',
      credential_id: credential.id,
      threshold_days: threshold,
      days_remaining: daysRemaining,
      credential: {
        id: credential.id,
        subject: credential.subject,
        issuer: credential.issuer,
        credentialType: credential.credentialType,
        expires_at: expiresAt,
        expiry_date: new Date(expiresAt * 1000).toISOString(),
        issued_at: credential.issued_at || credential.issuedAt,
        claims: credential.claims,
      },
      warning_window_days: this.config.expiryWarningDays,
      timestamp: new Date().toISOString(),
    };

    return this.attemptWithRetries({
      credential,
      channel: 'webhook',
      target,
      threshold,
      daysRemaining,
      send: async () => {
        const startTime = Date.now();
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const durationMs = Date.now() - startTime;
        if (!response.ok) {
          throw new Error(`notification dispatch failed with HTTP ${response.status}`);
        }
        return { status: response.status, durationMs };
      },
    });
  }

  async deliverEmail(credential, { daysRemaining, threshold }) {
    if (!this.emailTransport?.enabled) {
      return { channel: 'email', status: 'skipped', target: null };
    }

    const recipient = resolveRecipient(this.config, credential);
    if (!recipient) {
      await appendNotificationLog(this.config, {
        credentialId: credential.id,
        channel: 'email',
        status: 'skipped',
        threshold,
        daysRemaining,
        error: 'no recipient address configured',
      });
      return { channel: 'email', status: 'skipped', target: null };
    }

    const subject = renderExpirySubject({
      credentialType: credential.credentialType,
      daysRemaining,
    });
    const { text, html } = renderExpiryBody({ credential, daysRemaining, threshold });

    return this.attemptWithRetries({
      credential,
      channel: 'email',
      target: recipient,
      threshold,
      daysRemaining,
      send: () => this.emailTransport.send({ to: recipient, subject, text, html }),
    });
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
