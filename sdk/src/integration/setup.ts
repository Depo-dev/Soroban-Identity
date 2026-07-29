/**
 * Integration test setup utilities
 * 
 * Manages Docker container lifecycle for stellar/quickstart and deploys
 * fresh contracts for each test run.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execAsync = promisify(exec);

export interface TestEnvironment {
  rpcUrl: string;
  networkPassphrase: string;
  identityRegistryId: string;
  credentialManagerId: string;
  reputationId: string;
  adminKeypair: {
    publicKey: string;
    secret: string;
  };
}

const CONTAINER_NAME = 'soroban-identity-integration-test';
const RPC_PORT = 8000;
const RPC_URL = `http://localhost:${RPC_PORT}`;
const NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';

/**
 * Start stellar/quickstart Docker container in standalone mode
 */
export async function startQuickstart(): Promise<void> {
  console.log('[Integration] Starting stellar/quickstart container...');
  
  // Check if container already exists
  try {
    const { stdout } = await execAsync(`docker ps -a --filter name=${CONTAINER_NAME} --format "{{.Names}}"`);
    if (stdout.trim() === CONTAINER_NAME) {
      console.log('[Integration] Container already exists, removing...');
      await execAsync(`docker rm -f ${CONTAINER_NAME}`);
    }
  } catch (error) {
    // Container doesn't exist, continue
  }
  
  // Start quickstart container
  await execAsync(`docker run -d --name ${CONTAINER_NAME} \
    -p ${RPC_PORT}:8000 \
    stellar/quickstart:testing \
    --standalone \
    --enable-soroban-rpc`);
  
  // Wait for RPC to be ready
  console.log('[Integration] Waiting for RPC server to be ready...');
  await waitForRpc(RPC_URL, 60000);
  
  console.log('[Integration] Quickstart container ready');
}

/**
 * Stop and remove the quickstart container
 */
export async function stopQuickstart(): Promise<void> {
  console.log('[Integration] Stopping quickstart container...');
  try {
    await execAsync(`docker stop ${CONTAINER_NAME}`);
    await execAsync(`docker rm ${CONTAINER_NAME}`);
    console.log('[Integration] Quickstart container stopped');
  } catch (error) {
    console.warn('[Integration] Failed to stop container:', error);
  }
}

/**
 * Wait for RPC server to be ready
 */
async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.result?.status === 'healthy') {
          return;
        }
      }
    } catch (error) {
      // RPC not ready yet, continue waiting
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`RPC server did not become ready within ${timeoutMs}ms`);
}

/**
 * Deploy contracts to the test network
 * 
 * Note: This requires stellar-cli to be installed and WASM files to be available.
 * For a complete implementation, this would:
 * 1. Generate admin keypair
 * 2. Fund admin account
 * 3. Build and deploy each contract
 * 4. Initialize contracts
 * 
 * For now, this returns mock IDs for demonstration.
 */
export async function deployContracts(): Promise<TestEnvironment> {
  console.log('[Integration] Deploying contracts...');
  
  // Generate admin keypair
  const { stdout: keypairJson } = await execAsync('stellar keys generate admin --no-fund --network standalone');
  const adminSecret = process.env.STELLAR_SECRET_KEY || 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminPublic = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  
  // TODO: Actual contract deployment
  // For now, return placeholder values
  // In a real implementation, this would:
  // 1. Build contracts from ../contracts
  // 2. Deploy using stellar contract deploy
  // 3. Initialize each contract
  
  console.log('[Integration] Contracts deployed (mock)');
  
  return {
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    identityRegistryId: 'CBBNTYLY7WH6O3IGUI6BKUYLB5UQOOCNDYW5EL7BY4DJKPZ7SGIRWCSL',
    credentialManagerId: 'CD5MO3M3LYM5JLYXD27ARVECRKQXLJJSNBWMAUJ6ST3F4FXBGGXTJA7T',
    reputationId: 'CBXM5TFFI4DWZ2OQSR37KHVO6OEKTJQTGOQMFTIDFTFUP32COAGW4OPK',
    adminKeypair: {
      publicKey: adminPublic,
      secret: adminSecret,
    },
  };
}

/**
 * Global test environment setup
 */
export async function setupIntegrationTests(): Promise<TestEnvironment> {
  await startQuickstart();
  const env = await deployContracts();
  return env;
}

/**
 * Global test environment teardown
 */
export async function teardownIntegrationTests(): Promise<void> {
  await stopQuickstart();
}
