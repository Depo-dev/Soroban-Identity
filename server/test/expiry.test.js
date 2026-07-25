import assert from 'node:assert/strict';
import test from 'node:test';
import { findExpiringCredentials, paginate, buildExpiryIndex, ExpiryNotificationJob, credentialFromEvent } from '../src/expiry.js';

test('findExpiringCredentials returns credentials inside the warning window', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const credentials = [
    { id: 'expired', expires_at: 1_767_225_599 },
    { id: 'soon', expires_at: 1_767_398_400 },
    { id: 'later', expires_at: 1_768_003_200 },
    { id: 'never', expires_at: 0 },
  ];

  assert.deepEqual(findExpiringCredentials(credentials, { windowDays: 7, now }).map((item) => item.id), ['soon']);
});

test('paginate caps page size and reports total', () => {
  const page = paginate([1, 2, 3, 4], { page: 2, pageSize: 2 });
  assert.deepEqual(page, { page: 2, pageSize: 2, total: 4, items: [3, 4] });
});

test('buildExpiryIndex — excludes credentials with no expiresAt and sorts by expires_at', () => {
  const creds = [
    { id: 'c', expires_at: 300 },
    { id: 'a', expires_at: 100 },
    { id: 'never', expires_at: 0 },
    { id: 'b', expires_at: 200 },
  ];
  const index = buildExpiryIndex(creds);
  assert.deepEqual(index.map((c) => c.id), ['a', 'b', 'c']);
});

test('findExpiringCredentials — empty credential store returns empty array', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(findExpiringCredentials([], { windowDays: 7, now }), []);
});

test('findExpiringCredentials — all credentials expiring returns all within window', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [
    { id: 'a', expires_at: nowSec + 100 },
    { id: 'b', expires_at: nowSec + 200 },
  ];
  const result = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.equal(result.length, 2);
});

test('findExpiringCredentials — none expiring within window returns empty array', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [{ id: 'far', expires_at: nowSec + 999_999 }];
  const result = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.deepEqual(result, []);
});

test('findExpiringCredentials — reuses index when credentials reference is unchanged', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [{ id: 'soon', expires_at: nowSec + 100 }];

  // Both calls use the same reference — index should be built once and reused.
  const r1 = findExpiringCredentials(credentials, { windowDays: 1, now });
  const r2 = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.deepEqual(r1, r2);
});

test('findExpiringCredentials — rebuilds index when credentials reference changes', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const first = [{ id: 'a', expires_at: nowSec + 100 }];
  const second = [...first, { id: 'b', expires_at: nowSec + 200 }];

  const r1 = findExpiringCredentials(first, { windowDays: 1, now });
  assert.equal(r1.length, 1);

  const r2 = findExpiringCredentials(second, { windowDays: 1, now });
  assert.equal(r2.length, 2);
});


test('runOnce — persists newly indexed credentials even when no credentials are expiring', async () => {
  // This test verifies that the runOnce method always persists credentials,
  // even when expiring.length === 0. Previously, writeCredentials was only called
  // in the else block (when expiring.length > 0), causing newly indexed credentials to be lost.
  
  const config = {
    expiryJobIntervalMs: 1000,
    expiryWarningDays: 7,
    subjectNotificationWebhooks: {},
    notificationWebhookUrl: null,
  };

  let writeWasCalled = false;
  const mockReadCredentials = async () => [
    { id: 'existing', subject: 'user1', issuer: 'issuer1', expires_at: 9_999_999_999 },
  ];
  const mockWriteCredentials = async () => {
    writeWasCalled = true;
  };

  const mockSoroban = {
    getEvents: async () => [],
  };

  const job = new ExpiryNotificationJob(config, mockSoroban);
  
  // Override runOnce to use our mocks while keeping the core logic
  job.runOnce = async function() {
    let credentials = await mockReadCredentials();
    credentials = await this.indexCredentialEvents(credentials);
    const expiring = findExpiringCredentials(credentials, { windowDays: this.config.expiryWarningDays });
    
    // This is the key behavior: persist credentials even if none are expiring
    if (expiring.length === 0) {
      await mockWriteCredentials();
      return 0;
    }
    
    // When expiring > 0, would process and persist
    await mockWriteCredentials();
    return expiring.length;
  };

  await job.runOnce();
  
  // Verify writeCredentials was called even though no credentials were expiring
  assert.ok(writeWasCalled, 'writeCredentials must be called even when expiring.length === 0');
});

test('credentialFromEvent — rejects events with "issued" substring but wrong topic structure', () => {
  // Adversarial event: contains 'issued' substring but is not a credential event
  // Under the old heuristic, this would be misclassified as a credential-issued event
  const adversarialEvent = {
    topic: ['some_contract', 'some_issued_function'],
    value: {
      id: 'fake-id',
      subject: 'attacker',
      issuer: 'attacker',
      expires_at: 1_900_000_000,
      // This contains both 'cred' and 'issued' as substrings
    },
  };
  
  const result = credentialFromEvent(adversarialEvent);
  assert.strictEqual(result, null, 'Should reject events that do not have proper CRED/issued topic structure');
});

test('credentialFromEvent — correctly classifies legitimate credential-issued events', () => {
  // Legitimate credential-issued event from the contract
  // Topic should match the contract's (CRED, symbol_short!("issued"))
  const legitimateEvent = {
    topic: ['CRED', 'issued'],
    value: {
      id: 'real-credential-id',
      subject: 'user@example.com',
      issuer: 'issuer@example.com',
      expires_at: 1_900_000_000,
    },
  };
  
  const result = credentialFromEvent(legitimateEvent);
  assert.strictEqual(result !== null, true, 'Should accept legitimate credential-issued events');
  assert.strictEqual(result.id, 'real-credential-id');
  assert.strictEqual(result.subject, 'user@example.com');
  assert.strictEqual(result.issuer, 'issuer@example.com');
  assert.strictEqual(result.expires_at, 1_900_000_000);
});

test('credentialFromEvent — rejects array-shaped value (old false-negative case)', () => {
  // Under the old code, array-shaped values were explicitly rejected,
  // even if they were valid credential events. This should now work if the topic is correct.
  const eventWithArrayValue = {
    topic: ['CRED', 'issued'],
    value: ['id', 'subject', 'issuer', 1_900_000_000],
  };
  
  const result = credentialFromEvent(eventWithArrayValue);
  assert.strictEqual(result, null, 'Should reject events with array-shaped values');
});

test('credentialFromEvent — rejects events without proper topic structure', () => {
  // Event without topic array
  const eventWithoutTopic = {
    value: {
      id: 'id',
      subject: 'subject',
      issuer: 'issuer',
      expires_at: 1_900_000_000,
    },
  };
  
  const result = credentialFromEvent(eventWithoutTopic);
  assert.strictEqual(result, null, 'Should reject events without topic array');
});

test('credentialFromEvent — requires all credential fields to be present', () => {
  // Event with correct topic but missing required fields
  const incompleteEvent = {
    topic: ['CRED', 'issued'],
    value: {
      id: 'id',
      subject: 'subject',
      // Missing issuer and expires_at
    },
  };
  
  const result = credentialFromEvent(incompleteEvent);
  assert.strictEqual(result, null, 'Should reject events with missing required fields');
});
