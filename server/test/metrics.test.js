import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsService } from '../src/metrics.js';

test('metrics service renders Prometheus counters and latency histogram', () => {
  const metrics = new MetricsService();
  metrics.applyEvents([
    { topic: ['DID', 'created'] },
    { topic: ['CRED', 'issued credential'] },
    { topic: ['CRED', 'revoked credential'] },
    { topic: ['SCORE', 'submitted'] },
  ]);
  metrics.observeRpcLatency(0.2);
  const rendered = metrics.renderPrometheus();

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

test('metrics service increments exactly one counter per event, even when other fields contain unrelated keywords (#507)', () => {
  const metrics = new MetricsService();
  metrics.applyEvents([
    {
      topic: ['CRED', 'issued credential'],
      // These extra fields would trip the old whole-event substring scan
      // (credential/revoke/did/created/score/submit all appear below) even
      // though the real event topic is only "credential issued".
      note: 'this credential was later revoked, a DID was created, and a score was submitted',
    },
  ]);
  const rendered = metrics.renderPrometheus();

  assert.match(rendered, /credentials_issued_total 1/);
  assert.match(rendered, /credentials_revoked_total 0/);
  assert.match(rendered, /dids_created_total 0/);
  assert.match(rendered, /reputation_scores_submitted_total 0/);
});
