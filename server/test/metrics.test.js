import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsService } from '../src/metrics.js';

test('metrics service renders Prometheus counters and latency histogram', async () => {
  const metrics = new MetricsService({ collectDefaultMetrics: false });
  metrics.applyEvents([
    { topic: ['DID', 'created'] },
    { topic: ['CRED', 'issued credential'] },
    { topic: ['CRED', 'revoked credential'] },
    { topic: ['SCORE', 'submitted'] },
  ]);
  metrics.observeRpcLatency(0.2);
  const rendered = await metrics.renderPrometheus();

  // Verify counters are present
  assert.match(rendered, /dids_created_total 1/);
  assert.match(rendered, /credentials_issued_total 1/);
  assert.match(rendered, /credentials_revoked_total 1/);
  assert.match(rendered, /reputation_scores_submitted_total 1/);
  
  // Verify HELP annotations are present
  assert.match(rendered, /# HELP dids_created_total Total number of DIDs created/);
  assert.match(rendered, /# HELP credentials_issued_total Total number of credentials issued/);
  assert.match(rendered, /# HELP credentials_revoked_total Total number of credentials revoked/);
  assert.match(rendered, /# HELP reputation_scores_submitted_total Total number of reputation scores submitted/);
  
  // Verify TYPE annotations are present
  assert.match(rendered, /# TYPE dids_created_total counter/);
  assert.match(rendered, /# TYPE credentials_issued_total counter/);
  assert.match(rendered, /# TYPE credentials_revoked_total counter/);
  assert.match(rendered, /# TYPE reputation_scores_submitted_total counter/);
  
  // Verify histogram metrics
  assert.match(rendered, /# HELP soroban_rpc_call_latency_seconds Soroban RPC call latency in seconds/);
  assert.match(rendered, /# TYPE soroban_rpc_call_latency_seconds histogram/);
  assert.match(rendered, /soroban_rpc_call_latency_seconds_count 1/);
});

test('metrics service increments exactly one counter per event, even when other fields contain unrelated keywords (#507)', async () => {
  const metrics = new MetricsService({ collectDefaultMetrics: false });
  metrics.applyEvents([
    {
      topic: ['CRED', 'issued credential'],
      // These extra fields would trip the old whole-event substring scan
      // (credential/revoke/did/created/score/submit all appear below) even
      // though the real event topic is only "credential issued".
      note: 'this credential was later revoked, a DID was created, and a score was submitted',
    },
  ]);
  const rendered = await metrics.renderPrometheus();

  assert.match(rendered, /credentials_issued_total 1/);
  assert.match(rendered, /credentials_revoked_total 0/);
  assert.match(rendered, /dids_created_total 0/);
  assert.match(rendered, /reputation_scores_submitted_total 0/);
});

// ── Regression test ──────────────────────────────────────────────────────────

// #488 — MetricsAggregator.refresh must be single-flight. Two concurrent scrape
// requests arriving while one refresh is already in progress must both await the
// same in-flight Promise rather than triggering a second independent fetch that
// would process the same ledger range twice and double-count events.
test('#488 regression: concurrent refresh calls share one in-flight promise and do not double-count', async () => {
  let fetchCallCount = 0;

  const soroban = {
    async getEvents(fromLedger) {
      fetchCallCount++;
      // Simulate a slow RPC call so the second concurrent call definitely
      // arrives while the first is still awaiting.
      await new Promise(resolve => setTimeout(resolve, 20));
      return [
        { topic: ['CRED', 'issued credential'], ledger: fromLedger + 1 },
      ];
    },
  };

  const { MetricsAggregator } = await import('../src/metrics.js');
  const metrics = new (await import('../src/metrics.js')).MetricsService({ collectDefaultMetrics: false });
  const aggregator = new MetricsAggregator(soroban, metrics, { startLedger: 0 });

  // Fire two concurrent refreshes — they should coalesce into a single fetch.
  const [r1, r2] = await Promise.all([aggregator.refresh(), aggregator.refresh()]);

  assert.equal(fetchCallCount, 1,
    'getEvents should only be called once despite two concurrent refresh() invocations');
  assert.equal(r1, 1, 'first refresh should report 1 event processed');
  assert.equal(r2, 1, 'second refresh (shared promise) should also report 1 event processed');

  // The counter must be incremented exactly once.
  const rendered = await metrics.renderPrometheus();
  assert.match(rendered, /credentials_issued_total 1/,
    'credentials_issued_total should be 1, not 2 (no double-counting)');
});
