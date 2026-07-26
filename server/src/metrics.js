const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class MetricsService {
  constructor() {
    this.counters = {
      dids_created_total: 0,
      credentials_issued_total: 0,
      credentials_revoked_total: 0,
      reputation_scores_submitted_total: 0,
      rpc_cache_hits_total: 0,
      rpc_cache_misses_total: 0,
      rpc_retries_total: 0,
    };
    this.rpcLatencies = [];
  }

  observeRpcLatency(seconds) {
    this.rpcLatencies.push(seconds);
    if (this.rpcLatencies.length > 10_000) this.rpcLatencies.shift();
  }

  applyEvents(events) {
    for (const event of events) {
      const [entity, action] = Array.isArray(event?.topic) ? event.topic : [];
      const entityKey = typeof entity === 'string' ? entity.toUpperCase() : '';
      const actionText = typeof action === 'string' ? action.toLowerCase() : '';

      // Classified by the event's real topic (entity + action), mutually
      // exclusive so a single event increments exactly one counter.
      if (entityKey === 'DID' && actionText.includes('create')) {
        this.counters.dids_created_total += 1;
      } else if (entityKey === 'CRED' && actionText.includes('issue')) {
        this.counters.credentials_issued_total += 1;
      } else if (entityKey === 'CRED' && actionText.includes('revoke')) {
        this.counters.credentials_revoked_total += 1;
      } else if (entityKey === 'SCORE' && actionText.includes('submit')) {
        this.counters.reputation_scores_submitted_total += 1;
      }
    }
  }

  renderPrometheus() {
    const lines = [];
    for (const [name, value] of Object.entries(this.counters)) {
      // Add HELP annotations for each counter
      let helpText = '';
      if (name === 'dids_created_total') helpText = 'Total number of DIDs created';
      else if (name === 'credentials_issued_total') helpText = 'Total number of credentials issued';
      else if (name === 'credentials_revoked_total') helpText = 'Total number of credentials revoked';
      else if (name === 'reputation_scores_submitted_total') helpText = 'Total number of reputation scores submitted';
      else if (name === 'rpc_cache_hits_total') helpText = 'Total number of RPC cache hits';
      else if (name === 'rpc_cache_misses_total') helpText = 'Total number of RPC cache misses';
      else if (name === 'rpc_retries_total') helpText = 'Total number of RPC retries';
      
      if (helpText) lines.push(`# HELP ${name} ${helpText}`);
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    
    lines.push('# HELP soroban_rpc_call_latency_seconds Soroban RPC call latency in seconds');
    lines.push('# TYPE soroban_rpc_call_latency_seconds histogram');
    let cumulative = 0;
    for (const bucket of HISTOGRAM_BUCKETS) {
      cumulative = this.rpcLatencies.filter((value) => value <= bucket).length;
      lines.push(`soroban_rpc_call_latency_seconds_bucket{le="${bucket}"} ${cumulative}`);
    }
    lines.push(`soroban_rpc_call_latency_seconds_bucket{le="+Inf"} ${this.rpcLatencies.length}`);
    lines.push(`soroban_rpc_call_latency_seconds_sum ${this.rpcLatencies.reduce((sum, value) => sum + value, 0)}`);
    lines.push(`soroban_rpc_call_latency_seconds_count ${this.rpcLatencies.length}`);
    return `${lines.join('\n')}\n`;
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
