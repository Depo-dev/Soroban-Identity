import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { SorobanClient } from '../src/soroban.js';

test('GET /health returns 200 with circuit breaker info', async () => {
  const config = {
    stellarCli: 'stellar',
    sourceAccount: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: {
      identity: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      credential: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      reputation: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    },
    sorobanInvokeTimeoutMs: 10000,
    rpcMaxRetries: 3,
    rpcCacheTtlMs: 5000,
    eventPollIntervalMs: 0,
    port: 3001,
    maxBodyBytes: 64 * 1024,
    dataDir: 'data/test-health',
    corsAllowedOrigins: [],
  };

  const soroban = new SorobanClient(config, null);
  
  // Mock pingAllContracts to avoid actual RPC calls
  soroban.pingAllContracts = async () => ({
    identity: true,
    credential: true,
    reputation: true,
  });

  const metrics = {
    renderPrometheus: () => '# HELP test\n',
  };

  const app = createApp({ config, soroban, metrics, metricsAggregator: null });
  
  const server = http.createServer(app);
  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}/health`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        });
      }).on('error', reject);
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.status);
    assert.ok(response.body.contracts);
    assert.ok(response.body.circuitBreaker);
    
    // Verify circuit breaker structure
    assert.ok(response.body.circuitBreaker.state);
    assert.equal(typeof response.body.circuitBreaker.failures, 'number');
    assert.ok(response.body.circuitBreaker.lastStateChange);

    // Circuit breaker should start in CLOSED state with 0 failures
    assert.equal(response.body.circuitBreaker.state, 'CLOSED');
    assert.equal(response.body.circuitBreaker.failures, 0);
  } finally {
    server.close();
  }
});

test('SorobanClient has circuitBreaker property', async () => {
  const config = {
    stellarCli: 'stellar',
    sourceAccount: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: { test: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    sorobanInvokeTimeoutMs: 10000,
    rpcMaxRetries: 3,
    rpcCacheTtlMs: 5000,
    eventPollIntervalMs: 0,
  };

  const soroban = new SorobanClient(config, null);

  assert.ok(soroban.circuitBreaker);
  assert.ok(soroban.circuitBreaker.toHealthInfo);
  
  const healthInfo = soroban.circuitBreaker.toHealthInfo();
  assert.equal(healthInfo.state, 'CLOSED');
  assert.equal(healthInfo.failures, 0);
  assert.ok(healthInfo.lastStateChange);
});
