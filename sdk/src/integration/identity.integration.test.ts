/**
 * Identity integration tests
 * 
 * Tests DID create/resolve operations against a real Soroban node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { IdentityClient } from '../identity';
import { setupIntegrationTests, teardownIntegrationTests, type TestEnvironment } from './setup';

describe('Identity Integration Tests', () => {
  let env: TestEnvironment;
  let client: IdentityClient;
  let testKeypair: Keypair;

  beforeAll(async () => {
    env = await setupIntegrationTests();
    client = new IdentityClient({
      rpcUrl: env.rpcUrl,
      networkPassphrase: env.networkPassphrase,
      identityRegistryId: env.identityRegistryId,
      credentialManagerId: env.credentialManagerId,
      reputationId: env.reputationId,
    });
    testKeypair = Keypair.random();
  }, 120000); // 2 minute timeout for Docker setup

  afterAll(async () => {
    await teardownIntegrationTests();
  }, 30000);

  describe('createDid', () => {
    it('creates a new DID with metadata', async () => {
      const result = await client.createDid(testKeypair, {
        service: 'https://example.com/api',
        metadata: {
          name: 'Test User',
          email: 'test@example.com',
        },
      });

      expect(result.data.did).toBe(`did:stellar:${testKeypair.publicKey()}`);
      expect(result.txHash).toBeTruthy();
      expect(result.data.controller).toBe(testKeypair.publicKey());
      expect(result.data.metadata).toEqual({
        name: 'Test User',
        email: 'test@example.com',
      });
    });

    it('prevents duplicate DID creation', async () => {
      const keypair = Keypair.random();
      
      // Create first DID
      await client.createDid(keypair);
      
      // Attempt to create duplicate
      await expect(client.createDid(keypair)).rejects.toThrow(/already exists/i);
    });

    it('creates DID without optional metadata', async () => {
      const keypair = Keypair.random();
      
      const result = await client.createDid(keypair);
      
      expect(result.data.did).toBe(`did:stellar:${keypair.publicKey()}`);
      expect(result.data.active).toBe(true);
    });
  });

  describe('resolveDid', () => {
    let existingKeypair: Keypair;
    let existingDid: string;

    beforeAll(async () => {
      existingKeypair = Keypair.random();
      const result = await client.createDid(existingKeypair, {
        metadata: { purpose: 'integration-test' },
      });
      existingDid = result.data.did;
    });

    it('resolves an existing DID', async () => {
      const didDoc = await client.resolveDid(existingKeypair.publicKey());
      
      expect(didDoc.id).toBe(existingDid);
      expect(didDoc.controller).toBe(existingKeypair.publicKey());
      expect(didDoc.active).toBe(true);
      expect(didDoc.metadata).toEqual({ purpose: 'integration-test' });
      expect(didDoc.createdAt).toBeGreaterThan(0);
      expect(didDoc.updatedAt).toBeGreaterThan(0);
    });

    it('throws NOT_FOUND for non-existent DID', async () => {
      const nonExistentKeypair = Keypair.random();
      
      await expect(client.resolveDid(nonExistentKeypair.publicKey())).rejects.toThrow(/NOT_FOUND|not found/i);
    });

    it('handles serialization correctly for complex metadata', async () => {
      const keypair = Keypair.random();
      const complexMetadata = {
        profile: {
          name: 'Alice',
          tags: ['developer', 'tester'],
        },
        count: 42,
        active: true,
      };
      
      await client.createDid(keypair, { metadata: complexMetadata });
      const didDoc = await client.resolveDid(keypair.publicKey());
      
      expect(didDoc.metadata).toEqual(complexMetadata);
    });
  });

  describe('hasActiveDid', () => {
    it('returns true for address with active DID', async () => {
      const keypair = Keypair.random();
      await client.createDid(keypair);
      
      const result = await client.hasActiveDid(keypair.publicKey());
      
      expect(result).toBe(true);
    });

    it('returns false for address without DID', async () => {
      const keypair = Keypair.random();
      
      const result = await client.hasActiveDid(keypair.publicKey());
      
      expect(result).toBe(false);
    });
  });

  describe('getStorageStats', () => {
    it('returns storage statistics', async () => {
      const stats = await client.getStorageStats(env.adminKeypair.publicKey);
      
      expect(stats).toHaveProperty('totalDids');
      expect(stats).toHaveProperty('activeDids');
      expect(typeof stats.totalDids).toBe('number');
      expect(typeof stats.activeDids).toBe('number');
      expect(stats.totalDids).toBeGreaterThanOrEqual(stats.activeDids);
    });
  });
});
