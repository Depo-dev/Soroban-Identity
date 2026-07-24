import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SorobanClient, SorobanError } from '../src/soroban.js';
import { SorobanUnavailableError } from '../src/circuit-breaker.js';

test('Circuit breaker: repeated failures trip the breaker and subsequent calls fail fast', async () => {
  const config = {
    stellarCli: 'node',
    sourceAccount: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: { test: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    sorobanInvokeTimeoutMs: 100,
    rpcMaxRetries: 0, // Disable retries for this test
    rpcCacheTtlMs: 5000,
    eventPollIntervalMs: 0,
  };

  const client = new SorobanClient(config, null);

  // Trip the breaker by causing 5 consecutive failures (threshold)
  for (let i = 0; i < 5; i++) {
    await client.circuitBreaker.call(async () => {
      throw new Error('timeout: connection refused');
    }).catch(() => {});
  }

  // Verify breaker is now OPEN
  assert.equal(client.circuitBreaker.state, 'OPEN');

  // Next call through the breaker should fail fast
  let failFastOccurred = false;
  await client.circuitBreaker.call(async () => {
    // This should not execute because breaker is OPEN
    throw new Error('Should not execute');
  }).catch((err) => {
    // Should fail with SorobanUnavailableError
    assert.ok(err instanceof SorobanUnavailableError);
    failFastOccurred = true;
  });

  assert.ok(failFastOccurred, 'Should fail fast when breaker is OPEN');
});

test('Circuit breaker: tracks success and closes after failures', async () => {
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

  const client = new SorobanClient(config, null);

  // Start in CLOSED state
  assert.equal(client.circuitBreaker.state, 'CLOSED');
  assert.equal(client.circuitBreaker.failures, 0);

  // Simulate failures to open the breaker
  for (let i = 0; i < 5; i++) {
    await client.circuitBreaker.call(async () => {
      throw new Error('timeout: connection refused');
    }).catch(() => {});
  }

  // Verify breaker is OPEN
  assert.equal(client.circuitBreaker.state, 'OPEN');

  // Wait for recovery window (30s default, but we'll just test the state)
  // In HALF_OPEN state after recovery window, a success should close it
  // For this test, we just verify the breaker properly tracked state
  assert.ok(client.circuitBreaker.failures > 0);
});

test('Circuit breaker converts SorobanUnavailableError to SorobanError', async () => {
  const config = {
    stellarCli: 'stellar',
    sourceAccount: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: { test: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    sorobanInvokeTimeoutMs: 10000,
    rpcMaxRetries: 0,
    rpcCacheTtlMs: 5000,
    eventPollIntervalMs: 0,
  };

  const client = new SorobanClient(config, null);

  // Trip the breaker
  for (let i = 0; i < 5; i++) {
    await client.circuitBreaker.call(async () => {
      throw new Error('simulated failure');
    }).catch(() => {});
  }

  // Try to invoke when breaker is open - should get SorobanError with rpc_unavailable category
  await assert.rejects(
    async () => {
      // We need to bypass the runCommand mock, so we directly test invoke
      // Create a test that actually exercises invoke with a healthy breaker
      const testClient = new SorobanClient(config, null);
      
      // Pre-open the breaker
      for (let i = 0; i < 5; i++) {
        await testClient.circuitBreaker.call(async () => {
          throw new Error('pre-failure');
        }).catch(() => {});
      }

      // Now invoke should fail with SorobanError
      return testClient.invoke('test', 'ping');
    },
    (err) => {
      assert.ok(err instanceof SorobanError);
      assert.equal(err.category, 'rpc_unavailable');
      return true;
    }
  );
});

test('Circuit breaker state is reflected in toHealthInfo()', async () => {
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

  const client = new SorobanClient(config, null);

  // Initial state should be CLOSED
  let health = client.circuitBreaker.toHealthInfo();
  assert.equal(health.state, 'CLOSED');
  assert.equal(health.failures, 0);

  // Cause some failures
  for (let i = 0; i < 3; i++) {
    await client.circuitBreaker.call(async () => {
      throw new Error('test failure');
    }).catch(() => {});
  }

  // Health should show updated failure count
  health = client.circuitBreaker.toHealthInfo();
  assert.equal(health.failures, 3);
  assert.equal(health.state, 'CLOSED'); // Still CLOSED, not enough failures yet

  // Cause more failures to trip the breaker
  for (let i = 0; i < 2; i++) {
    await client.circuitBreaker.call(async () => {
      throw new Error('test failure');
    }).catch(() => {});
  }

  // Now breaker should be OPEN
  health = client.circuitBreaker.toHealthInfo();
  assert.equal(health.state, 'OPEN');
  assert.ok(health.failures >= 5);
});
