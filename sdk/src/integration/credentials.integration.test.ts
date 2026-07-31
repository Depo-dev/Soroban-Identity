/**
 * Credentials integration tests
 * 
 * Tests credential issue/verify/revoke operations against a real Soroban node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { CredentialsClient } from '../credentials';
import { IdentityClient } from '../identity';
import { setupIntegrationTests, teardownIntegrationTests, type TestEnvironment } from './setup';

describe('Credentials Integration Tests', () => {
  let env: TestEnvironment;
  let client: CredentialsClient;
  let identityClient: IdentityClient;
  let issuerKeypair: Keypair;
  let subjectKeypair: Keypair;

  beforeAll(async () => {
    env = await setupIntegrationTests();
    
    const config = {
      rpcUrl: env.rpcUrl,
      networkPassphrase: env.networkPassphrase,
      identityRegistryId: env.identityRegistryId,
      credentialManagerId: env.credentialManagerId,
      reputationId: env.reputationId,
    };
    
    client = new CredentialsClient(config);
    identityClient = new IdentityClient(config);
    
    // Create issuer and subject DIDs
    issuerKeypair = Keypair.random();
    subjectKeypair = Keypair.random();
    
    await identityClient.createDid(issuerKeypair, {
      metadata: { role: 'issuer' },
    });
    
    await identityClient.createDid(subjectKeypair, {
      metadata: { role: 'subject' },
    });
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationTests();
  }, 30000);

  describe('issueCredential', () => {
    it('issues a new credential', async () => {
      const credentialData = {
        credentialType: 'VerifiedEmail',
        claims: {
          email: 'user@example.com',
          verified: true,
          verifiedAt: Date.now(),
        },
      };
      
      const result = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        credentialData,
        {
          expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
        }
      );
      
      expect(result.data.id).toBeTruthy();
      expect(result.data.issuer).toBe(issuerKeypair.publicKey());
      expect(result.data.subject).toBe(subjectKeypair.publicKey());
      expect(result.data.credentialType).toBe('VerifiedEmail');
      expect(result.data.claims).toEqual(credentialData.claims);
      expect(result.txHash).toBeTruthy();
    });

    it('issues credential with complex claims structure', async () => {
      const credentialData = {
        credentialType: 'DeveloperProfile',
        claims: {
          name: 'Alice Developer',
          skills: ['TypeScript', 'Rust', 'Soroban'],
          experience: {
            years: 5,
            projects: ['DeFi', 'Identity'],
          },
          certifications: [
            { name: 'Soroban Developer', issued: 2024 },
            { name: 'Smart Contract Security', issued: 2023 },
          ],
        },
      };
      
      const result = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        credentialData
      );
      
      expect(result.data.claims).toEqual(credentialData.claims);
    });

    it('handles fee estimation correctly', async () => {
      const credentialData = {
        credentialType: 'BasicCredential',
        claims: { test: true },
      };
      
      // Should not throw fee-related errors
      const result = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        credentialData
      );
      
      expect(result.txHash).toBeTruthy();
    });
  });

  describe('verifyCredential', () => {
    let issuedCredentialId: string;

    beforeAll(async () => {
      const credentialData = {
        credentialType: 'TestCredential',
        claims: { test: 'verify' },
      };
      
      const result = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        credentialData
      );
      
      issuedCredentialId = result.data.id;
    });

    it('verifies a valid credential', async () => {
      const result = await client.verifyCredential(issuedCredentialId);
      
      expect(result.valid).toBe(true);
      expect(result.credential).toBeTruthy();
      expect(result.credential?.id).toBe(issuedCredentialId);
      expect(result.credential?.issuer).toBe(issuerKeypair.publicKey());
      expect(result.credential?.subject).toBe(subjectKeypair.publicKey());
    });

    it('detects non-existent credential', async () => {
      const fakeId = 'credential-' + Date.now();
      
      const result = await client.verifyCredential(fakeId);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not found|NOT_FOUND/i);
    });

    it('detects expired credential', async () => {
      // Issue credential that expires immediately
      const expiredCred = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        {
          credentialType: 'ExpiredTest',
          claims: { test: true },
        },
        {
          expiresAt: Math.floor(Date.now() / 1000) - 1, // Already expired
        }
      );
      
      // Wait a moment for consistency
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const result = await client.verifyCredential(expiredCred.data.id);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/expired/i);
    });
  });

  describe('revokeCredential', () => {
    let credentialToRevoke: string;

    beforeAll(async () => {
      const result = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        {
          credentialType: 'ToRevoke',
          claims: { test: 'revoke' },
        }
      );
      
      credentialToRevoke = result.data.id;
    });

    it('revokes a credential', async () => {
      const result = await client.revokeCredential(issuerKeypair, credentialToRevoke);
      
      expect(result.txHash).toBeTruthy();
    });

    it('detects revoked credential during verification', async () => {
      const result = await client.verifyCredential(credentialToRevoke);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/revoked/i);
    });

    it('prevents non-issuer from revoking', async () => {
      const otherKeypair = Keypair.random();
      await identityClient.createDid(otherKeypair);
      
      const cred = await client.issueCredential(
        issuerKeypair,
        subjectKeypair.publicKey(),
        {
          credentialType: 'Protected',
          claims: { test: true },
        }
      );
      
      await expect(
        client.revokeCredential(otherKeypair, cred.data.id)
      ).rejects.toThrow(/unauthorized|permission/i);
    });
  });

  describe('listCredentials', () => {
    beforeAll(async () => {
      // Issue multiple credentials for testing
      for (let i = 0; i < 3; i++) {
        await client.issueCredential(
          issuerKeypair,
          subjectKeypair.publicKey(),
          {
            credentialType: `ListTest${i}`,
            claims: { index: i },
          }
        );
      }
    });

    it('lists credentials for a subject', async () => {
      const credentials = await client.listCredentials({
        subject: subjectKeypair.publicKey(),
      });
      
      expect(Array.isArray(credentials)).toBe(true);
      expect(credentials.length).toBeGreaterThanOrEqual(3);
      
      // All credentials should belong to the subject
      credentials.forEach(cred => {
        expect(cred.subject).toBe(subjectKeypair.publicKey());
      });
    });

    it('lists credentials issued by an issuer', async () => {
      const credentials = await client.listCredentials({
        issuer: issuerKeypair.publicKey(),
      });
      
      expect(Array.isArray(credentials)).toBe(true);
      expect(credentials.length).toBeGreaterThanOrEqual(3);
      
      // All credentials should be from the issuer
      credentials.forEach(cred => {
        expect(cred.issuer).toBe(issuerKeypair.publicKey());
      });
    });
  });

  describe('getIssuers', () => {
    it('returns list of registered issuers', async () => {
      const issuers = await client.getIssuers();
      
      expect(Array.isArray(issuers)).toBe(true);
      // Should include our test issuer
      expect(issuers).toContain(issuerKeypair.publicKey());
    });
  });
});
