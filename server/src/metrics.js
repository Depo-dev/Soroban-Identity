/**
 * Prometheus metrics (#649)
 *
 * Backed by `prom-client`. All series are registered on a private Registry so
 * two MetricsService instances (as created by tests) never collide on the
 * global default registry.
 *
 * The `counters` property is preserved as a live proxy over the underlying
 * prom-client counters: existing callers such as `soroban.js` mutate
 * `metrics.counters.rpc_cache_hits_total` directly, and reads must reflect the
 * registry rather than a detached copy.
 */

import client from 'prom-client';

const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Latency buckets for inbound HTTP requests, in seconds. */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Business counters exposed by the server, with the HELP text rendered for
 * each. Names are unchanged from the hand-rolled renderer they replace.
 */
const COUNTER_DEFINITIONS = {
  dids_created_total: 'Total number of DIDs created',
  credentials_issued_total: 'Total number of credentials issued',
  credentials_revoked_total: 'Total number of credentials revoked',
  reputation_scores_submitted_total: 'Total number of reputation scores submitted',
  rpc_cache_hits_total: 'Total number of RPC cache hits',
  rpc_cache_misses_total: 'Total number of RPC cache misses',
  rpc_retries_total: 'Total number of RPC retries',
};

/**
 * Read a prom-client counter's current value synchronously.
 *
 * prom-client exposes values through the async `get()` API, but an unlabelled
 * counter keeps its state in `hashMap` under the empty-label key, so a
 * synchronous read is possible — which is what the `counters` proxy needs.
 *
 * @param {import('prom-client').Counter} counter
 * @returns {number}
 */
function readCounter(counter) {
  return counter.hashMap?.['']?.value ?? 0;
}

export class MetricsService {
  /**
   * @param {object} [options]
   * @param {boolean} [options.collectDefaultMetrics=true] - Register Node.js
   *   runtime metrics (heap, event loop lag, GC, handles) on this registry.
   */
  constructor({ collectDefaultMetrics = true } = {}) {
    this.registry = new client.Registry();

    /** @type {Record<string, import('prom-client').Counter>} */
    this._counters = {};
    for (const [name, help] of Object.entries(COUNTER_DEFINITIONS)) {
      this._counters[name] = new client.Counter({
        name,
        help,
        registers: [this.registry],
      });
    }

    this.rpcLatency = new client.Histogram({
      name: 'soroban_rpc_call_latency_seconds',
      help: 'Soroban RPC call latency in seconds',
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    this.httpRequests = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests handled, by method, route and status code',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by method, route and status code',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.httpInFlight = new client.Gauge({
      name: 'http_requests_in_flight',
      help: 'Number of HTTP requests currently being processed',
      registers: [this.registry],
    });

    this.credentialsVerified = new client.Counter({
      name: 'credentials_verified_total',
      help: 'Total number of credential verification attempts, by result',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.activeDids = new client.Gauge({
      name: 'active_dids',
      help: 'Number of distinct DIDs holding at least one active credential',
      registers: [this.registry],
    });

    this.activeCredentials = new client.Gauge({
      name: 'active_credentials',
      help: 'Number of credentials that are neither revoked nor expired, by credential type',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.credentialTypes = new client.Gauge({
      name: 'credential_types',
      help: 'Number of distinct credential types present in the credential store',
      registers: [this.registry],
    });

    if (collectDefaultMetrics) {
      client.collectDefaultMetrics({ register: this.registry });
    }

    /**
     * Live view over the business counters.
     *
     * Reads return the registry's current value; writes compute the delta and
     * apply it with `inc()`, because a Prometheus counter can only move
     * forward. Assigning a lower value is ignored rather than silently
     * corrupting the series.
     */
    this.counters = new Proxy(this._counters, {
      get: (target, name) => (name in target ? readCounter(target[name]) : undefined),
      set: (target, name, value) => {
        if (!(name in target)) return false;
        const delta = Number(value) - readCounter(target[name]);
        if (Number.isFinite(delta) && delta > 0) target[name].inc(delta);
        return true;
      },
      has: (target, name) => name in target,
      ownKeys: (target) => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target, name) =>
        name in target
          ? { enumerable: true, configurable: true, value: readCounter(target[name]) }
          : undefined,
    });
  }

  /**
   * Record a Soroban RPC call's latency.
   * @param {number} seconds
   */
  observeRpcLatency(seconds) {
    this.rpcLatency.observe(seconds);
  }

  /**
   * Record a completed HTTP request.
   *
   * @param {object} sample
   * @param {string} sample.method
   * @param {string} sample.route      - Normalized route pattern, not the raw path
   * @param {number} sample.statusCode
   * @param {number} sample.durationSeconds
   */
  observeHttpRequest({ method, route, statusCode, durationSeconds }) {
    const labels = {
      method: String(method ?? 'UNKNOWN').toUpperCase(),
      route: route ?? 'unmatched',
      status_code: String(statusCode ?? 0),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  /**
   * Record the outcome of a credential verification.
   * @param {'verified'|'revoked'|'expired'|'not_found'} result
   */
  observeCredentialVerification(result) {
    this.credentialsVerified.inc({ result: result ?? 'unknown' });
  }

  /**
   * Recompute the business gauges from the current credential store contents.
   *
   * A credential counts as active when it is not revoked and either has no
   * expiry (`expiresAt` of 0) or expires in the future.
   *
   * @param {Array<object>} credentials
   * @param {number} [nowSeconds] - Injectable clock for tests
   */
  updateBusinessMetrics(credentials, nowSeconds = Math.floor(Date.now() / 1000)) {
    const subjects = new Set();
    const byType = new Map();
    const allTypes = new Set();

    for (const credential of credentials ?? []) {
      const type = credential?.type ?? 'unspecified';
      allTypes.add(type);

      const expiresAt = Number(credential?.expiresAt ?? 0);
      const expired = expiresAt > 0 && expiresAt < nowSeconds;
      if (credential?.revoked || expired) continue;

      const subject = credential?.subject ?? credential?.did;
      if (subject) subjects.add(subject);
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }

    this.activeDids.set(subjects.size);
    this.credentialTypes.set(allTypes.size);

    // Reset first so a type that dropped to zero is reported as zero rather
    // than keeping its last non-zero value forever.
    this.activeCredentials.reset();
    for (const type of allTypes) {
      this.activeCredentials.set({ type }, byType.get(type) ?? 0);
    }
  }

  /**
   * Apply on-chain events to the business counters.
   *
   * Classified by the event's real topic (entity + action), mutually exclusive
   * so a single event increments exactly one counter.
   *
   * @param {Array<{topic?: unknown[]}>} events
   */
  applyEvents(events) {
    for (const event of events) {
      const [entity, action] = Array.isArray(event?.topic) ? event.topic : [];
      const entityKey = typeof entity === 'string' ? entity.toUpperCase() : '';
      const actionText = typeof action === 'string' ? action.toLowerCase() : '';

      if (entityKey === 'DID' && actionText.includes('create')) {
        this._counters.dids_created_total.inc();
      } else if (entityKey === 'CRED' && actionText.includes('issue')) {
        this._counters.credentials_issued_total.inc();
      } else if (entityKey === 'CRED' && actionText.includes('revoke')) {
        this._counters.credentials_revoked_total.inc();
      } else if (entityKey === 'SCORE' && actionText.includes('submit')) {
        this._counters.reputation_scores_submitted_total.inc();
      }
    }
  }

  /** Content type Prometheus expects for a scrape response. */
  get contentType() {
    return this.registry.contentType;
  }

  /**
   * Render the full registry in the Prometheus text exposition format.
   * @returns {Promise<string>}
   */
  renderPrometheus() {
    return this.registry.metrics();
  }

  /** Reset every series. Intended for tests. */
  reset() {
    this.registry.resetMetrics();
  }
}

export class MetricsAggregator {
  constructor(soroban, metrics, { startLedger = 0 } = {}) {
    this.soroban = soroban;
    this.metrics = metrics;
    this.nextLedger = startLedger;
    /** @type {Promise<number>|null} In-flight refresh promise for single-flight dedup */
    this._refreshPromise = null;
  }

  /**
   * Fetch new ledger events and apply them to the metrics counters.
   *
   * Single-flight: if a refresh is already in progress when this method is
   * called again (e.g. two concurrent Prometheus scrapes), the second caller
   * receives the same Promise as the first so the same ledger range is never
   * processed twice.
   *
   * @returns {Promise<number>} Number of events processed in this refresh.
   */
  refresh() {
    if (this._refreshPromise !== null) {
      return this._refreshPromise;
    }
    this._refreshPromise = this._doRefresh().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _doRefresh() {
    const events = await this.soroban.getEvents(this.nextLedger);
    this.metrics.applyEvents(events);
    const newest = events.map((event) => Number(event.ledger ?? event.ledgerClosedAt ?? 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (newest) this.nextLedger = newest + 1;
    return events.length;
  }
}
