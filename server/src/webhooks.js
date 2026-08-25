import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';
import { writeAtomic, ensureDataDir } from './storage.js';

/**
 * Generate HMAC SHA-256 signature for webhook payload.
 *
 * @param {string} payload - JSON string payload
 * @param {string} secret - Webhook secret key
 * @param {number|string} timestamp - Unix timestamp in seconds
 * @returns {string} HMAC SHA-256 hex digest
 */
export function generateWebhookSignature(payload, secret, timestamp) {
  const signaturePayload = `${timestamp}.${payload}`;
  return crypto
    .createHmac('sha256', secret)
    .update(signaturePayload, 'utf8')
    .digest('hex');
}

/**
 * Verify incoming webhook signature against payload and secret.
 *
 * @param {object} options
 * @param {string} options.payload - Raw payload string
 * @param {string} options.signature - Received signature (hex or sha256=hex)
 * @param {string} options.secret - Webhook secret
 * @param {number|string} options.timestamp - Timestamp sent with webhook
 * @param {number} [options.toleranceSec=300] - Max allowed timestamp drift in seconds
 * @returns {boolean}
 */
export function verifyWebhookSignature({ payload, signature, secret, timestamp, toleranceSec = 300 }) {
  if (!payload || !signature || !secret || !timestamp) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > toleranceSec) {
    return false;
  }

  const cleanSignature = signature.startsWith('sha256=')
    ? signature.slice(7)
    : signature;

  const expectedSignature = generateWebhookSignature(payload, secret, timestamp);

  const sigBuf = Buffer.from(cleanSignature, 'hex');
  const expBuf = Buffer.from(expectedSignature, 'hex');

  if (sigBuf.length !== expBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Webhook Storage helper functions
 */
export function getWebhooksFilePath(config) {
  return path.join(config.dataDir, 'webhooks.json');
}

export function getWebhookLogsFilePath(config) {
  return path.join(config.dataDir, 'webhook-logs.ndjson');
}

export async function readWebhooks(config) {
  const filePath = getWebhooksFilePath(config);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.webhooks) ? parsed.webhooks : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeWebhooks(config, webhooks) {
  await ensureDataDir(config);
  const filePath = getWebhooksFilePath(config);
  await writeAtomic(filePath, JSON.stringify({ webhooks }, null, 2));
}

export async function createWebhookRecord(config, { url, events = ['*'], secret, authToken, description }) {
  const webhooks = await readWebhooks(config);
  const webhook = {
    id: `whk_${crypto.randomUUID()}`,
    url,
    events: Array.isArray(events) && events.length > 0 ? events : ['*'],
    secret: secret || crypto.randomBytes(24).toString('hex'),
    authToken: authToken || null,
    description: description || '',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  webhooks.push(webhook);
  await writeWebhooks(config, webhooks);
  return webhook;
}

export async function deleteWebhookRecord(config, id) {
  const webhooks = await readWebhooks(config);
  const filtered = webhooks.filter((w) => w.id !== id);
  if (filtered.length === webhooks.length) return false;
  await writeWebhooks(config, filtered);
  return true;
}

export async function getWebhookRecord(config, id) {
  const webhooks = await readWebhooks(config);
  return webhooks.find((w) => w.id === id) || null;
}

export async function appendWebhookLog(config, logEntry) {
  await ensureDataDir(config);
  const filePath = getWebhookLogsFilePath(config);
  const record = {
    timestamp: new Date().toISOString(),
    ...logEntry,
  };
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(filePath, line, 'utf8');
  return record;
}

export async function readWebhookLogs(config, { webhookId = null, limit = 50 } = {}) {
  const filePath = getWebhookLogsFilePath(config);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const logs = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let filtered = logs;
    if (webhookId) {
      filtered = filtered.filter((log) => log.webhookId === webhookId);
    }

    filtered.reverse(); // Newest first
    return filtered.slice(0, Math.min(limit, 200));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * In-memory Delivery Queue with exponential backoff retries and concurrency control.
 */
export class WebhookDeliveryService {
  constructor(config, options = {}) {
    this.config = config;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000;
    this.concurrency = options.concurrency ?? 5;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.queue = [];
    this.runningCount = 0;
    this.activeTimers = new Set();
  }

  /**
   * Queue a webhook delivery event.
   *
   * @param {string} event - Event name (e.g. 'credential.issued', 'credential.revoked', 'did.created')
   * @param {object} data - Payload data
   * @returns {Promise<void>}
   */
  async trigger(event, data) {
    try {
      const webhooks = await readWebhooks(this.config);
      const matching = webhooks.filter((w) =>
        w.active && (w.events.includes('*') || w.events.includes(event))
      );

      for (const webhook of matching) {
        this.enqueue({
          deliveryId: `del_${crypto.randomUUID()}`,
          webhook,
          event,
          data,
          attempt: 1,
        });
      }
    } catch (error) {
      logger.error({ error: error.message, event }, 'Failed to trigger webhooks');
    }
  }

  /**
   * Enqueue a delivery task.
   */
  enqueue(task) {
    this.queue.push(task);
    this.processQueue();
  }

  /**
   * Process items in the queue with bounded concurrency.
   */
  processQueue() {
    while (this.runningCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.runningCount++;
      this.deliver(task)
        .catch((err) => {
          logger.error({ error: err.message, deliveryId: task.deliveryId }, 'Unexpected delivery error');
        })
        .finally(() => {
          this.runningCount--;
          this.processQueue();
        });
    }
  }

  /**
   * Deliver webhook payload with HMAC signature and handle retries with backoff.
   */
  async deliver(task) {
    const { deliveryId, webhook, event, data, attempt } = task;
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: deliveryId,
      event,
      timestamp,
      data,
    });

    const signature = generateWebhookSignature(payload, webhook.secret, timestamp);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Soroban-Identity-Webhook/1.0',
      'x-webhook-id': webhook.id,
      'x-webhook-event': event,
      'x-webhook-delivery': deliveryId,
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': `sha256=${signature}`,
    };

    if (webhook.authToken) {
      headers.authorization = `Bearer ${webhook.authToken}`;
    }

    const startTime = Date.now();
    let statusCode = 0;
    let success = false;
    let errorMessage = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      statusCode = response.status;
      success = response.ok;
      if (!success) {
        errorMessage = `HTTP status ${statusCode}`;
      }
    } catch (err) {
      errorMessage = err.name === 'AbortError' ? 'Request timed out' : err.message;
    }

    const durationMs = Date.now() - startTime;

    // Log the attempt
    await appendWebhookLog(this.config, {
      deliveryId,
      webhookId: webhook.id,
      url: webhook.url,
      event,
      statusCode,
      success,
      attempt,
      durationMs,
      error: errorMessage,
    });

    // Schedule retry with exponential backoff if failed
    if (!success && attempt < this.maxRetries) {
      const backoffDelay = Math.min(
        this.baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200),
        this.maxDelayMs
      );

      logger.warn({
        deliveryId,
        webhookId: webhook.id,
        attempt,
        nextAttempt: attempt + 1,
        backoffDelayMs: backoffDelay,
        error: errorMessage,
      }, 'Webhook delivery failed, scheduling retry');

      const retryTimer = setTimeout(() => {
        this.activeTimers.delete(retryTimer);
        this.enqueue({
          ...task,
          attempt: attempt + 1,
        });
      }, backoffDelay);

      this.activeTimers.add(retryTimer);
    } else if (!success) {
      logger.error({
        deliveryId,
        webhookId: webhook.id,
        totalAttempts: attempt,
        error: errorMessage,
      }, 'Webhook delivery permanently failed');
    }

    return { deliveryId, success, statusCode, durationMs, error: errorMessage };
  }

  /**
   * Send a test ping payload immediately and wait for response.
   */
  async deliverTest(webhook) {
    const deliveryId = `test_${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const event = 'test.ping';
    const payload = JSON.stringify({
      id: deliveryId,
      event,
      timestamp,
      data: {
        message: 'This is a test notification from Soroban Identity Webhook System',
        webhookId: webhook.id,
      },
    });

    const signature = generateWebhookSignature(payload, webhook.secret, timestamp);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Soroban-Identity-Webhook/1.0',
      'x-webhook-id': webhook.id,
      'x-webhook-event': event,
      'x-webhook-delivery': deliveryId,
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': `sha256=${signature}`,
    };

    if (webhook.authToken) {
      headers.authorization = `Bearer ${webhook.authToken}`;
    }

    const startTime = Date.now();
    let statusCode = 0;
    let success = false;
    let errorMessage = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      statusCode = response.status;
      success = response.ok;
      if (!success) errorMessage = `HTTP status ${statusCode}`;
    } catch (err) {
      errorMessage = err.name === 'AbortError' ? 'Request timed out' : err.message;
    }

    const durationMs = Date.now() - startTime;

    await appendWebhookLog(this.config, {
      deliveryId,
      webhookId: webhook.id,
      url: webhook.url,
      event,
      statusCode,
      success,
      attempt: 1,
      durationMs,
      error: errorMessage,
    });

    return {
      deliveryId,
      success,
      statusCode,
      durationMs,
      error: errorMessage,
    };
  }

  /**
   * Clear active timers on shutdown.
   */
  drain() {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.queue = [];
  }
}
