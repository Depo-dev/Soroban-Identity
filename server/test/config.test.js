import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { validateConfig, loadConfig } from '../src/config.js';

test('validateConfig directly: empty env returns validation errors', () => {
  const result = validateConfig({});
  assert.equal(result.isValid, false);
  assert.ok(result.missing.some(e => e.includes('STELLAR_SECRET_KEY')));
  assert.ok(result.missing.some(e => e.includes('CREDENTIAL_CONTRACT_ID')));
});

test('validateConfig directly: valid required env passes', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  });
  assert.equal(result.isValid, true);
});

test('validateConfig directly: invalid formats trigger invalid errors', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'not-a-secret-key',
    CREDENTIAL_CONTRACT_ID: 'not-a-contract-address',
    PORT: 'abc',
    STELLAR_RPC_URL: 'not-a-url',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some(e => e.includes('STELLAR_SECRET_KEY')));
  assert.ok(result.invalid.some(e => e.includes('CREDENTIAL_CONTRACT_ID')));
  assert.ok(result.invalid.some(e => e.includes('PORT')));
  assert.ok(result.invalid.some(e => e.includes('STELLAR_RPC_URL')));
});

// Helper to spawn index.js with specific environment overrides
function runServer(envOverrides) {
  return new Promise((resolve) => {
    // Strip process.env credentials to ensure clean testing environment
    const baseEnv = { ...process.env };
    delete baseEnv.STELLAR_SECRET_KEY;
    delete baseEnv.STELLAR_SOURCE_ACCOUNT;
    delete baseEnv.CREDENTIAL_CONTRACT_ID;
    delete baseEnv.CREDENTIAL_MANAGER_ID;

    const child = spawn('node', ['src/index.js'], {
      env: {
        ...baseEnv,
        PORT: '0',
        DISABLE_EXPIRY_JOB: 'true',
        DATA_DIR: 'data/test-config',
        ...envOverrides,
      },
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('listening on :') && !resolved) {
        resolved = true;
        child.kill();
        resolve({ code: null, stdout, stderr });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (!resolved) {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

test('Integration: starting with no env vars prints missing required variables and exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: '',
    STELLAR_SOURCE_ACCOUNT: '',
    CREDENTIAL_CONTRACT_ID: '',
    CREDENTIAL_MANAGER_ID: '',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('[config] Missing required environment variables:'));
  assert.ok(result.stderr.includes('STELLAR_SECRET_KEY: Stellar account secret key (S…)'));
  assert.ok(result.stderr.includes('CREDENTIAL_CONTRACT_ID: deployed credential contract address'));
});

test('Integration: starting with all required vars binds the port normally', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  });

  assert.ok(result.stdout.includes('listening on :') || result.code === 0 || result.code === null);
});

test('Integration: invalid URL for RPC_URL triggers a validation error and exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    STELLAR_RPC_URL: 'invalid-url',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('STELLAR_RPC_URL: must be a valid URL'));
});

test('validateConfig directly: invalid SOROBAN_INVOKE_TIMEOUT_MS triggers validation error', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    SOROBAN_INVOKE_TIMEOUT_MS: 'not-a-number',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some(e => e.includes('SOROBAN_INVOKE_TIMEOUT_MS')));
});

test('Integration: invalid SOROBAN_INVOKE_TIMEOUT_MS value exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    SOROBAN_INVOKE_TIMEOUT_MS: 'invalid',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('SOROBAN_INVOKE_TIMEOUT_MS'));
});

test('loadConfig — recognizes RPC_URL as fallback when STELLAR_RPC_URL is not set', () => {
  const customRpcUrl = 'https://custom-rpc.example.com';
  const config = loadConfig({
    RPC_URL: customRpcUrl,
  });
  
  assert.strictEqual(config.rpcUrl, customRpcUrl, 'loadConfig should use RPC_URL when STELLAR_RPC_URL is not set');
});

test('loadConfig — prioritizes STELLAR_RPC_URL over RPC_URL', () => {
  const stellarRpcUrl = 'https://stellar-rpc.example.com';
  const rpcUrl = 'https://rpc.example.com';
  const config = loadConfig({
    STELLAR_RPC_URL: stellarRpcUrl,
    RPC_URL: rpcUrl,
  });
  
  assert.strictEqual(config.rpcUrl, stellarRpcUrl, 'loadConfig should prioritize STELLAR_RPC_URL over RPC_URL');
});

test('loadConfig — uses hardcoded default when neither RPC_URL nor STELLAR_RPC_URL is set', () => {
  const config = loadConfig({});
  
  assert.strictEqual(config.rpcUrl, 'https://soroban-testnet.stellar.org', 'loadConfig should use hardcoded testnet default');
});

test('validateConfig — accepts RPC_URL as valid alternative to STELLAR_RPC_URL', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    RPC_URL: 'https://custom-rpc.example.com',
  });
  
  assert.equal(result.isValid, true, 'validateConfig should accept RPC_URL without requiring STELLAR_RPC_URL');
});
