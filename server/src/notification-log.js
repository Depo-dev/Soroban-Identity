import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Path of the append-only notification attempt log.
 */
export function getNotificationLogPath(config) {
  return path.join(config.dataDir, 'notification-log.ndjson');
}

/**
 * Append one delivery attempt to the notification log.
 *
 * The log is append-only NDJSON so concurrent expiry workers can write
 * without coordinating on a single JSON document. Logging failures are
 * swallowed — a broken log must never abort a notification run.
 *
 * @param {object} config
 * @param {object} entry
 * @param {string} entry.credentialId
 * @param {'email'|'webhook'} entry.channel
 * @param {'delivered'|'failed'|'skipped'} entry.status
 * @param {string} [entry.target]
 * @param {number} [entry.threshold]
 * @param {number} [entry.daysRemaining]
 * @param {number} [entry.durationMs]
 * @param {string} [entry.error]
 * @param {number} [entry.attempt]
 */
export async function appendNotificationLog(config, entry) {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const record = { timestamp: new Date().toISOString(), ...entry };
    await fs.appendFile(getNotificationLogPath(config), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    logger.error(
      { error: error.message, credentialId: entry?.credentialId },
      'Failed to append notification log entry',
    );
  }
}

/**
 * Read the notification log, newest entries last.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {number} [options.limit] - Return at most this many of the newest entries.
 * @param {string} [options.credentialId] - Filter to one credential.
 * @param {string} [options.status] - Filter to one delivery status.
 * @returns {Promise<Array<object>>}
 */
export async function readNotificationLog(config, { limit, credentialId, status } = {}) {
  let raw;
  try {
    raw = await fs.readFile(getNotificationLogPath(config), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (credentialId && parsed.credentialId !== credentialId) continue;
      if (status && parsed.status !== status) continue;
      entries.push(parsed);
    } catch {
      // Skip a torn or partially-written line rather than failing the read.
    }
  }

  if (limit && entries.length > limit) return entries.slice(-limit);
  return entries;
}

/**
 * Summarise delivery outcomes for observability endpoints.
 */
export async function summarizeNotificationLog(config) {
  const entries = await readNotificationLog(config);
  const summary = { total: entries.length, delivered: 0, failed: 0, skipped: 0, byChannel: {} };
  for (const entry of entries) {
    if (entry.status in summary) summary[entry.status] += 1;
    const channel = entry.channel ?? 'unknown';
    summary.byChannel[channel] ??= { delivered: 0, failed: 0, skipped: 0 };
    if (entry.status in summary.byChannel[channel]) {
      summary.byChannel[channel][entry.status] += 1;
    }
  }
  return summary;
}
