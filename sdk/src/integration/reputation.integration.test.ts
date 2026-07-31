/**
 * Reputation integration tests
 * 
 * Tests reputation submit/query operations against a real Soroban node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ReputationClient } from '../reputation';
import { IdentityClient } from '../identity';
import { setupIntegrationTests, teardownIntegrationTests, type TestEnvironment } from './setup';

describe('Reputation Integration Tests', () => {
  let env: TestEnvironment;
  let client: ReputationClient;
  let identityClient: IdentityClient;
  let raterKeypair: Keypair;
  let rateeKeypair: Keypair;

  beforeAll(async () => {
    env = await setupIntegrationTests();
    
    const config = {
      rpcUrl: env.rpcUrl,
      networkPassphrase: env.networkPassphrase,
      identityRegistryId: env.identityRegistryId,
      credentialManagerId: env.credentialManagerId,
      reputationId: env.reputationId,
    };
    
    client = new ReputationClient(config);
    identityClient = new IdentityClient(config);
    
    // Create rater and ratee DIDs
    raterKeypair = Keypair.random();
    rateeKeypair = Keypair.random();
    
    await identityClient.createDid(raterKeypair, {
      metadata: { role: 'rater' },
    });
    
    await identityClient.createDid(rateeKeypair, {
      metadata: { role: 'ratee' },
    });
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationTests();
  }, 30000);

  describe('submitRating', () => {
    it('submits a positive rating', async () => {
      const result = await client.submitRating(
        raterKeypair,
        rateeKeypair.publicKey(),
        {
          score: 5,
          category: 'trustworthiness',
          comment: 'Excellent service',
        }
      );
      
      expect(result.txHash).toBeTruthy();
      expect(result.data.rater).toBe(raterKeypair.publicKey());
      expect(result.data.ratee).toBe(rateeKeypair.publicKey());
      expect(result.data.score).toBe(5);
      expect(result.data.category).toBe('trustworthiness');
    });

    it('submits a negative rating', async () => {
      const result = await client.submitRating(
        raterKeypair,
        rateeKeypair.publicKey(),
        {
          score: 1,
          category: 'reliability',
          comment: 'Poor experience',
        }
      );
      
      expect(result.data.score).toBe(1);
      expect(result.data.category).toBe('reliability');
    });

    it('submits rating with metadata', async () => {
      const result = await client.submitRating(
        raterKeypair,
        rateeKeypair.publicKey(),
        {
          score: 4,
          category: 'quality',
          metadata: {
            transactionId: 'tx-12345',
            context: 'purchase',
            amount: 100,
          },
        }
      );
      
      expect(result.data.metadata).toEqual({
        transactionId: 'tx-12345',
        context: 'purchase',
        amount: 100,
      });
    });

    it('validates score range', async () => {
      await expect(
        client.submitRating(
          raterKeypair,
          rateeKeypair.publicKey(),
          {
            score: 10, // Invalid: too high
            category: 'test',
          }
        )
      ).rejects.toThrow(/score|range|invalid/i);
    });

    it('prevents self-rating', async () => {
      await expect(
        client.submitRating(
          raterKeypair,
          raterKeypair.publicKey(), // Same as rater
          {
            score: 5,
            category: 'self',
          }
        )
      ).rejects.toThrow(/self|same/i);
    });
  });

  describe('getReputation', () => {
    let targetUser: Keypair;

    beforeAll(async () => {
      targetUser = Keypair.random();
      await identityClient.createDid(targetUser);
      
      // Submit multiple ratings
      const raters = [Keypair.random(), Keypair.random(), Keypair.random()];
      
      for (const rater of raters) {
        await identityClient.createDid(rater);
        await client.submitRating(
          rater,
          targetUser.publicKey(),
          {
            score: 4,
            category: 'overall',
          }
        );
      }
    });

    it('retrieves reputation score', async () => {
      const reputation = await client.getReputation(targetUser.publicKey());
      
      expect(reputation).toHaveProperty('totalRatings');
      expect(reputation).toHaveProperty('averageScore');
      expect(reputation.totalRatings).toBeGreaterThanOrEqual(3);
      expect(reputation.averageScore).toBeGreaterThan(0);
      expect(reputation.averageScore).toBeLessThanOrEqual(5);
    });

    it('retrieves reputation by category', async () => {
      const reputation = await client.getReputation(
        targetUser.publicKey(),
        {
          category: 'overall',
        }
      );
      
      expect(reputation.totalRatings).toBeGreaterThanOrEqual(3);
      expect(reputation.averageScore).toBeCloseTo(4, 1);
    });

    it('returns zero reputation for new user', async () => {
      const newUser = Keypair.random();
      await identityClient.createDid(newUser);
      
      const reputation = await client.getReputation(newUser.publicKey());
      
      expect(reputation.totalRatings).toBe(0);
      expect(reputation.averageScore).toBe(0);
    });
  });

  describe('listRatings', () => {
    let reviewedUser: Keypair;
    let reviewerA: Keypair;
    let reviewerB: Keypair;

    beforeAll(async () => {
      reviewedUser = Keypair.random();
      reviewerA = Keypair.random();
      reviewerB = Keypair.random();
      
      await identityClient.createDid(reviewedUser);
      await identityClient.createDid(reviewerA);
      await identityClient.createDid(reviewerB);
      
      // Create ratings
      await client.submitRating(reviewerA, reviewedUser.publicKey(), {
        score: 5,
        category: 'service',
        comment: 'Great!',
      });
      
      await client.submitRating(reviewerB, reviewedUser.publicKey(), {
        score: 4,
        category: 'service',
        comment: 'Good',
      });
    });

    it('lists ratings for a user', async () => {
      const ratings = await client.listRatings({
        ratee: reviewedUser.publicKey(),
      });
      
      expect(Array.isArray(ratings)).toBe(true);
      expect(ratings.length).toBeGreaterThanOrEqual(2);
      
      ratings.forEach(rating => {
        expect(rating.ratee).toBe(reviewedUser.publicKey());
        expect(rating.score).toBeGreaterThan(0);
      });
    });

    it('lists ratings by rater', async () => {
      const ratings = await client.listRatings({
        rater: reviewerA.publicKey(),
      });
      
      expect(Array.isArray(ratings)).toBe(true);
      expect(ratings.length).toBeGreaterThanOrEqual(1);
      
      ratings.forEach(rating => {
        expect(rating.rater).toBe(reviewerA.publicKey());
      });
    });

    it('filters ratings by category', async () => {
      const ratings = await client.listRatings({
        ratee: reviewedUser.publicKey(),
        category: 'service',
      });
      
      expect(Array.isArray(ratings)).toBe(true);
      
      ratings.forEach(rating => {
        expect(rating.category).toBe('service');
      });
    });
  });

  describe('updateRating', () => {
    let ratingSubject: Keypair;
    let originalRater: Keypair;
    let ratingId: string;

    beforeAll(async () => {
      ratingSubject = Keypair.random();
      originalRater = Keypair.random();
      
      await identityClient.createDid(ratingSubject);
      await identityClient.createDid(originalRater);
      
      const result = await client.submitRating(
        originalRater,
        ratingSubject.publicKey(),
        {
          score: 3,
          category: 'initial',
          comment: 'First impression',
        }
      );
      
      ratingId = result.data.id;
    });

    it('updates an existing rating', async () => {
      const result = await client.updateRating(
        originalRater,
        ratingId,
        {
          score: 5,
          comment: 'Actually great!',
        }
      );
      
      expect(result.txHash).toBeTruthy();
      expect(result.data.score).toBe(5);
      expect(result.data.comment).toBe('Actually great!');
    });

    it('prevents non-owner from updating rating', async () => {
      const otherRater = Keypair.random();
      await identityClient.createDid(otherRater);
      
      await expect(
        client.updateRating(otherRater, ratingId, { score: 1 })
      ).rejects.toThrow(/unauthorized|permission|owner/i);
    });
  });

  describe('getReputationHistory', () => {
    it('retrieves reputation history over time', async () => {
      const user = Keypair.random();
      await identityClient.createDid(user);
      
      // Submit ratings at different times
      const rater1 = Keypair.random();
      await identityClient.createDid(rater1);
      await client.submitRating(rater1, user.publicKey(), {
        score: 3,
        category: 'history-test',
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const rater2 = Keypair.random();
      await identityClient.createDid(rater2);
      await client.submitRating(rater2, user.publicKey(), {
        score: 5,
        category: 'history-test',
      });
      
      const history = await client.getReputationHistory(user.publicKey());
      
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThanOrEqual(2);
      
      // Should be sorted by timestamp
      for (let i = 1; i < history.length; i++) {
        expect(history[i].timestamp).toBeGreaterThanOrEqual(history[i - 1].timestamp);
      }
    });
  });
});
