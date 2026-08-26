import net from 'node:net';
import tls from 'node:tls';
import { logger } from './logger.js';

const CRLF = '\r\n';

/**
 * Parse a `redis://` or `rediss://` URL into connection options.
 *
 * @param {string} url
 * @returns {{host: string, port: number, tls: boolean, password: string|null, username: string|null, db: number|null}}
 */
export function parseRedisUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis protocol: ${parsed.protocol}`);
  }
  const dbPath = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number.parseInt(parsed.port || '6379', 10),
    tls: parsed.protocol === 'rediss:',
    username: parsed.username ? decodeURIComponent(parsed.username) : null,
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
    db: dbPath ? Number.parseInt(dbPath, 10) : null,
  };
}

/**
 * Encode a command as a RESP array of bulk strings.
 */
export function encodeCommand(args) {
  const parts = [`*${args.length}${CRLF}`];
  for (const arg of args) {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value)}${CRLF}${value}${CRLF}`);
  }
  return parts.join('');
}

/**
 * Incremental RESP parser.
 *
 * Returns `{ value, consumed }` when a complete reply is available in the
 * buffer, or `null` when more bytes are needed. Errors come back as an
 * `Error` value rather than being thrown, so the caller can reject exactly the
 * one in-flight command they belong to.
 */
export function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;

  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf(CRLF, offset);
  if (lineEnd === -1) return null;

  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (type) {
    case '+':
      return { value: line, consumed: afterLine };
    case '-':
      return { value: new Error(line), consumed: afterLine };
    case ':':
      return { value: Number.parseInt(line, 10), consumed: afterLine };
    case '$': {
      const length = Number.parseInt(line, 10);
      if (length === -1) return { value: null, consumed: afterLine };
      const end = afterLine + length;
      // The payload plus its trailing CRLF must both have arrived.
      if (buffer.length < end + 2) return null;
      return { value: buffer.toString('utf8', afterLine, end), consumed: end + 2 };
    }
    case '*': {
      const count = Number.parseInt(line, 10);
      if (count === -1) return { value: null, consumed: afterLine };
      const items = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.consumed;
      }
      return { value: items, consumed: cursor };
    }
    default:
      return { value: new Error(`Unsupported RESP type: ${type}`), consumed: afterLine };
  }
}

/**
 * Minimal Redis client speaking RESP over a raw socket.
 *
 * Written against `node:net`/`node:tls` rather than pulling in a client
 * library, because the server ships with pino as its only runtime dependency.
 * It covers the command surface this cache needs — GET, SET with TTL, DEL,
 * SCAN, PING, INFO — with connect retry and backoff.
 *
 * Every failure path is non-fatal by design: the caller treats an unavailable
 * cache as a miss rather than an error.
 */
export class RedisClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = parseRedisUrl(url);
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 200;
    this.retryMaxMs = options.retryMaxMs ?? 5000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.createConnection = options.createConnection ?? null;

    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.attempts = 0;
  }

  /**
   * Open the connection, retrying with exponential backoff. Concurrent callers
   * share a single in-flight attempt.
   */
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = this._connectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connectWithRetry() {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      if (this.closed) throw new Error('Redis client is closed');
      try {
        await this._openSocket();
        this.attempts = 0;
        logger.info({ host: this.options.host, port: this.options.port, attempt }, 'Redis connected');
        return;
      } catch (error) {
        lastError = error;
        logger.warn(
          { host: this.options.host, port: this.options.port, attempt, maxRetries: this.maxRetries, error: error.message },
          'Redis connection attempt failed',
        );
        if (attempt < this.maxRetries) {
          const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Redis connection failed');
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const { host, port, tls: useTls } = this.options;

      const socket = this.createConnection
        ? this.createConnection(this.options)
        : useTls
          ? tls.connect({ host, port, servername: host })
          : net.connect({ host, port });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Redis connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const onReady = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        this.socket = socket;
        this.connected = true;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (error) => this._onSocketFailure(error));
        socket.on('close', () => this._onSocketFailure(new Error('Redis connection closed')));

        try {
          if (this.options.password) {
            const authArgs = this.options.username
              ? ['AUTH', this.options.username, this.options.password]
              : ['AUTH', this.options.password];
            await this.command(authArgs);
          }
          if (this.options.db !== null && Number.isFinite(this.options.db)) {
            await this.command(['SELECT', String(this.options.db)]);
          }
          resolve();
        } catch (error) {
          this.connected = false;
          socket.destroy();
          reject(error);
        }
      };

      socket.once(useTls ? 'secureConnect' : 'connect', onReady);
      socket.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Fail every in-flight command when the socket drops, so no caller hangs
   * waiting for a reply that will never arrive.
   */
  _onSocketFailure(error) {
    if (!this.connected && this.pending.length === 0) return;
    this.connected = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);

    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.pending.length > 0) {
      const reply = parseReply(this.buffer, 0);
      if (!reply) break;

      this.buffer = this.buffer.subarray(reply.consumed);
      const entry = this.pending.shift();
      clearTimeout(entry.timer);

      if (reply.value instanceof Error) entry.reject(reply.value);
      else entry.resolve(reply.value);
    }
  }

  /**
   * Send one command and await its reply.
   */
  command(args) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Redis is not connected'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        reject(new Error(`Redis command timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.push({ resolve, reject, timer });
      this.socket.write(encodeCommand(args));
    });
  }

  async ping() {
    return this.command(['PING']);
  }

  async get(key) {
    return this.command(['GET', key]);
  }

  /**
   * Set a key, optionally with a TTL in milliseconds.
   */
  async set(key, value, ttlMs = null) {
    const args = ['SET', key, value];
    if (ttlMs && ttlMs > 0) args.push('PX', String(Math.floor(ttlMs)));
    return this.command(args);
  }

  async del(...keys) {
    if (keys.length === 0) return 0;
    return this.command(['DEL', ...keys]);
  }

  /**
   * Collect every key matching a pattern using SCAN.
   *
   * SCAN is used rather than KEYS because KEYS blocks the Redis event loop for
   * the duration of the scan on large keyspaces.
   */
  async scanKeys(pattern, { count = 100 } = {}) {
    const found = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count)]);
      cursor = next;
      if (Array.isArray(keys)) found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  async quit() {
    this.closed = true;
    if (this.connected && this.socket) {
      try {
        await this.command(['QUIT']);
      } catch {
        // A failed QUIT is not worth surfacing during shutdown.
      }
    }
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.connected = false;
    this._onSocketFailure(new Error('Redis client closed'));
  }
}
