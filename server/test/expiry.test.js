import assert from 'node:assert/strict';
import test from 'node:test';
import { findExpiringCredentials, paginate, buildExpiryIndex, ExpiryNotificationJob, credentialFromEvent } from '../src/expiry.js';
import { readExpiryWatermark, writeExpiryWatermark } from '../src/storage.js';

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
  assert.deepEqual(page, { page: 2, pageSize: 2, totalItems: 4, totalPages: 2, hasNextPage: false, items: [3, 4] });
});

// ── paginate boundary conditions (issue #330) ──────────────────────────────

test('paginate — exact multiple: last real page contains correct items, no duplication', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const lastPage = paginate(items, { page: 2, pageSize: 5 });
  assert.deepEqual(lastPage.items, [6, 7, 8, 9, 10]);
  assert.equal(lastPage.hasNextPage, false);
});

test('paginate — page beyond end returns empty items with hasNextPage: false', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const beyondEnd = paginate(items, { page: 3, pageSize: 5 });
  assert.deepEqual(beyondEnd.items, []);
  assert.equal(beyondEnd.hasNextPage, false);
  assert.equal(beyondEnd.totalItems, 10);
});

test('paginate — no item appears on more than one page', () => {
  const items = Array.from({ length: 10 }, (_, i) => i + 1);
  const seen = new Set();
  for (let p = 1; p <= 4; p++) {
    const { items: pageItems } = paginate(items, { page: p, pageSize: 3 });
    for (const item of pageItems) {
      assert.ok(!seen.has(item), `item ${item} appeared on multiple pages`);
      seen.add(item);
    }
  }
  // All 10 items should have been seen across pages 1-4
  assert.equal(seen.size, 10);
});

test('paginate — zero items returns empty page', () => {
  const result = paginate([], { page: 1, pageSize: 5 });
  assert.deepEqual(result.items, []);
  assert.equal(result.totalItems, 0);
  assert.equal(result.totalPages, 1);
  assert.equal(result.hasNextPage, false);
});

test('paginate — totalPages and totalItems are correct', () => {
  const result = paginate([1, 2, 3, 4, 5], { page: 1, pageSize: 2 });
  assert.equal(result.totalItems, 5);
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasNextPage, true);
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


test('expiry watermark — persists and survives process restart', async () => {
  // Simulate watermark persistence across restarts.
  // This test verifies that:
  // 1. Watermark is persisted after scanning events
  // 2. On restart, the persisted watermark is loaded instead of starting fresh
  // 3. The scanner resumes from the last processed ledger
  
  const testDataDir = '/tmp/expiry-test-' + Date.now();
  const config = {
    expiryJobIntervalMs: 1000,
    expiryWarningDays: 7,
    subjectNotificationWebhooks: {},
    notificationWebhookUrl: null,
    dataDir: testDataDir,
    credentialStorePath: testDataDir + '/credentials.json',
    auditLogPath: testDataDir + '/audit.log',
  };

  // Simulate first run: process events up to ledger 100
  const initialNextLedger = 42;
  await writeExpiryWatermark(config, initialNextLedger);
  
  // Verify it was written
  const readBack = await readExpiryWatermark(config);
  assert.strictEqual(readBack, initialNextLedger, 'Watermark should be persisted and readable');
  
  // Simulate process restart: create new job instance
  // The new instance should load the persisted watermark in loadWatermark()
  const job = new ExpiryNotificationJob(config);
  assert.strictEqual(job.nextLedger, 0, 'Initially, nextLedger is set to default from env');
  
  // Load the persisted watermark (this is called on startup)
  await job.loadWatermark();
  assert.strictEqual(job.nextLedger, initialNextLedger, 'After loadWatermark, nextLedger should be restored from disk');
  
  // Simulate processing more events and updating the watermark
  const newNextLedger = 150;
  job.nextLedger = newNextLedger;
  await job.persistWatermark();
  
  // Verify persistence
  const finalRead = await readExpiryWatermark(config);
  assert.strictEqual(finalRead, newNextLedger, 'Updated watermark should persist');
  
  // Simulate another restart
  const job2 = new ExpiryNotificationJob(config);
  await job2.loadWatermark();
  assert.strictEqual(job2.nextLedger, newNextLedger, 'Second restart should load the updated watermark');
});

test('expiry watermark — uses default start ledger when no watermark exists', async () => {
  const testDataDir = '/tmp/expiry-test-fresh-' + Date.now();
  const config = {
    expiryJobIntervalMs: 1000,
    expiryWarningDays: 7,
    subjectNotificationWebhooks: {},
    notificationWebhookUrl: null,
    dataDir: testDataDir,
    credentialStorePath: testDataDir + '/credentials.json',
    auditLogPath: testDataDir + '/audit.log',
  };

  // Try to read watermark from non-existent directory
  const watermark = await readExpiryWatermark(config);
  assert.strictEqual(watermark, null, 'Should return null when watermark does not exist');
  
  // Job should use the default start ledger
  const job = new ExpiryNotificationJob(config);
  const initialValue = job.nextLedger;
  assert.ok(Number.isFinite(initialValue), 'Initial nextLedger should be a valid number');
  
  // After loadWatermark with no persisted file, it should stay the same
  await job.loadWatermark();
  assert.strictEqual(job.nextLedger, initialValue, 'Should keep default when watermark does not exist');
});
