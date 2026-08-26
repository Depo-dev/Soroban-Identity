import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Header names that must never reach the logs in cleartext.
 */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-auth-token',
]);

/**
 * Body fields that must never reach the logs in cleartext. Matched
 * case-insensitively against the field name at any depth.
 */
export const SENSITIVE_FIELDS = new Set([
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'seed',
  'mnemonic',
  'signature',
  'credential',
]);

export const REDACTED = '[REDACTED]';

const MAX_PAYLOAD_BYTES = 2048;

function isSensitiveFieldName(name) {
  return SENSITIVE_FIELDS.has(String(name).toLowerCase().replace(/[-\s]/g, '_'))
    || SENSITIVE_FIELDS.has(String(name).toLowerCase().replace(/[-_\s]/g, ''));
}

/**
 * Recursively redact sensitive fields from a payload.
 *
 * Depth is bounded so a deeply nested or cyclic structure cannot blow the
 * stack while preparing a log line.
 */
export function redact(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveFieldName(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }

  return value;
}

/**
 * Copy request headers for logging, redacting the sensitive ones.
 */
export function redactHeaders(headers = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    output[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return output;
}

/**
 * Resolve the client IP.
 *
 * `X-Forwarded-For` is only trusted when the server is explicitly configured
 * to sit behind a proxy — otherwise any client could spoof its own address by
 * setting the header.
 */
export function resolveClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first;
    }
    const realIp = req.headers?.['x-real-ip'];
    if (realIp) return String(realIp).trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Truncate a payload for logging so one large body cannot flood the log.
 */
export function preparePayload(body, maxBytes = MAX_PAYLOAD_BYTES) {
  if (body === null || body === undefined) return undefined;

  const redacted = redact(body);
  const serialized = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  if (serialized === undefined) return undefined;

  if (Buffer.byteLength(serialized) > maxBytes) {
    return {
      truncated: true,
      bytes: Buffer.byteLength(serialized),
      preview: serialized.slice(0, maxBytes),
    };
  }

  return redacted;
}

/**
 * Map an HTTP status onto a log level, so client errors do not page anyone but
 * server errors stand out.
 */
export function levelForStatus(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * Size-based log rotation for a file destination.
 *
 * Rotation happens on write rather than on a timer, so a process that is idle
 * overnight does not accumulate empty rotations, and a burst of traffic cannot
 * push a file past the limit while waiting for the next tick.
 */
export class RotatingFileSink {
  constructor({ filePath, maxBytes = 10 * 1024 * 1024, maxFiles = 5 }) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.stream = null;
    this.bytesWritten = 0;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const stats = await fsp.stat(this.filePath);
      this.bytesWritten = stats.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.bytesWritten = 0;
    }
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  /**
   * Shift `file.N` to `file.N+1`, dropping the oldest beyond `maxFiles`.
   */
  async rotate() {
    if (this.stream) {
      await new Promise((resolve) => this.stream.end(resolve));
      this.stream = null;
    }

    // Walk downwards so a rename never clobbers a file that still has to move.
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = `${this.filePath}.${index}`;
      const to = `${this.filePath}.${index + 1}`;
      try {
        await fsp.rename(from, to);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    try {
      await fsp.rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // Anything past the retention window is dropped.
    try {
      await fsp.unlink(`${this.filePath}.${this.maxFiles + 1}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    this.bytesWritten = 0;
    await this.open();
  }

  async write(line) {
    if (!this.stream) await this.open();

    const payload = `${line}\n`;
    const size = Buffer.byteLength(payload);

    if (this.bytesWritten + size > this.maxBytes && this.bytesWritten > 0) {
      await this.rotate();
    }

    this.stream.write(payload);
    this.bytesWritten += size;
  }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}

/**
 * Build the structured record for one completed request.
 */
export function buildAccessRecord(req, res, { requestId, startedAt, config, requestBody, responseBody }) {
  const durationMs = Number((Date.now() - startedAt).toFixed(3));
  const status = res.statusCode;

  const record = {
    type: 'http_access',
    requestId,
    method: req.method,
    path: req.url,
    status,
    durationMs,
    ip: resolveClientIp(req, { trustProxy: config.trustProxy }),
    userAgent: req.headers?.['user-agent'] ?? null,
    contentLength: res.getHeader?.('content-length') ?? null,
    apiKeyId: req.apiKeyId ?? null,
    userTier: req.userTier ?? null,
  };

  if (config.logHeaders) {
    record.headers = redactHeaders(req.headers);
  }

  if (config.logPayloads) {
    const requestPayload = preparePayload(requestBody, config.logPayloadMaxBytes);
    if (requestPayload !== undefined) record.requestBody = requestPayload;

    const responsePayload = preparePayload(responseBody, config.logPayloadMaxBytes);
    if (responsePayload !== undefined) record.responseBody = responsePayload;
  }

  return record;
}

/**
 * Attach access logging to one request.
 *
 * Returns a `finish` callback rather than wiring `res.on('finish')` here, so
 * the caller controls exactly when the record is emitted and can attach the
 * parsed request and response bodies it already has in hand.
 */
export function startAccessLog(req, res, { requestId, config, sink = null }) {
  const startedAt = Date.now();

  return function finish({ requestBody = null, responseBody = null } = {}) {
    try {
      const record = buildAccessRecord(req, res, {
        requestId,
        startedAt,
        config,
        requestBody,
        responseBody,
      });

      logger[levelForStatus(record.status)](record, 'http request completed');

      if (sink) {
        // A file-sink failure must not break the response that already went out.
        void sink
          .write(JSON.stringify({ time: new Date().toISOString(), ...record }))
          .catch((error) => logger.error({ error: error.message }, 'Access log write failed'));
      }

      return record;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to emit access log record');
      return null;
    }
  };
}
