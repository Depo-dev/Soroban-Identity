import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { appendAuditLog, ensureDataDir, upsertCredential } from '../src/storage.js';

// Simple date mock
const OriginalDate = global.Date;
class MockDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0 && MockDate.mockTime !== null) {
      super(MockDate.mockTime);
    } else {
      super(...args);
    }
  }
}
MockDate.mockTime = null;
global.Date = MockDate;

const testDataDir = path.resolve(process.cwd(), 'test-data-storage');
const baseLogPath = path.join(testDataDir, 'audit');

const config = {
  dataDir: testDataDir,
  auditLogPath: baseLogPath,
  credentialStorePath: path.join(testDataDir, 'credentials.json'),
  auditLogRetentionDays: 3
};

test.after(async () => {
  // Restore Date
  global.Date = OriginalDate;
  // Cleanup test files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
});

test('appendAuditLog creates dated log file and handles rotation on date change', async () => {
  // Ensure fresh folder
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await ensureDataDir(config);

  // Day 1
  MockDate.mockTime = new Date('2026-06-01T12:00:00Z').getTime();
  await appendAuditLog(config, { action: 'test-day-1' });

  const pathDay1 = `${baseLogPath}-2026-06-01.ndjson`;
  assert.ok(fs.existsSync(pathDay1), 'Day 1 log file should exist');

  const contentDay1 = await fsPromises.readFile(pathDay1, 'utf8');
  assert.match(contentDay1, /"action":"test-day-1"/);

  // Day 2 (rotation)
  MockDate.mockTime = new Date('2026-06-02T08:00:00Z').getTime();
  await appendAuditLog(config, { action: 'test-day-2' });

  const pathDay2 = `${baseLogPath}-2026-06-02.ndjson`;
  assert.ok(fs.existsSync(pathDay2), 'Day 2 log file should exist');

  const contentDay2 = await fsPromises.readFile(pathDay2, 'utf8');
  assert.match(contentDay2, /"action":"test-day-2"/);
});

test('ensureDataDir deletes audit files older than retention days', async () => {
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await ensureDataDir(config);

  // Today is 2026-06-05
  MockDate.mockTime = new Date('2026-06-05T12:00:00Z').getTime();

  // Active: 1 day old (2026-06-04)
  const pathActive = `${baseLogPath}-2026-06-04.ndjson`;
  // Active: 3 days old (2026-06-02)
  const pathActiveLimit = `${baseLogPath}-2026-06-02.ndjson`;
  // Expired: 4 days old (2026-06-01)
  const pathExpired = `${baseLogPath}-2026-06-01.ndjson`;
  // Expired: 10 days old (2026-05-26)
  const pathExpiredOlder = `${baseLogPath}-2026-05-26.ndjson`;

  await fsPromises.writeFile(pathActive, '{"action":"active"}');
  await fsPromises.writeFile(pathActiveLimit, '{"action":"active-limit"}');
  await fsPromises.writeFile(pathExpired, '{"action":"expired"}');
  await fsPromises.writeFile(pathExpiredOlder, '{"action":"expired-older"}');

  // Trigger cleanup via ensureDataDir
  await ensureDataDir(config);

  // Verify
  assert.ok(fs.existsSync(pathActive), 'Active file should NOT be deleted');
  assert.ok(fs.existsSync(pathActiveLimit), 'File at exact limit age should NOT be deleted');
  assert.ok(!fs.existsSync(pathExpired), 'Expired file should be deleted');
  assert.ok(!fs.existsSync(pathExpiredOlder), 'Very old expired file should be deleted');
});

test('upsertCredential inserts a new credential when id is not found', () => {
  const original = [{ id: 'a', status: 'active' }];
  const result = upsertCredential(original, { id: 'b', status: 'pending' });
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], { id: 'b', status: 'pending' });
});

test('upsertCredential does not mutate the original array on update', () => {
  const cred = { id: 'a', status: 'active', extra: 'original' };
  const original = [cred];
  const result = upsertCredential(original, { id: 'a', status: 'revoked' });

  // Original array and object must be unchanged
  assert.equal(original[0].status, 'active');
  assert.equal(original.length, 1);

  // Result must reflect the update
  assert.equal(result[0].status, 'revoked');
  assert.equal(result[0].extra, 'original');
});

test('upsertCredential returns a distinct object reference for updated entry', () => {
  const original = [{ id: 'a', status: 'active' }];
  const result = upsertCredential(original, { id: 'a', status: 'revoked' });
  assert.notEqual(result[0], original[0]);
});

test('upsertCredential non-updated entries are also distinct references', () => {
  const original = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
  const result = upsertCredential(original, { id: 'a', v: 99 });
  // The bystander entry at index 1 must not be the same object reference
  assert.notEqual(result[1], original[1]);
  // But its data is preserved
  assert.deepEqual(result[1], original[1]);
});

import { writeAtomic, recoverOrphanedFile, writeCredentials, readCredentials } from '../src/storage.js';

test('writeAtomic creates temporary file before atomic rename', async () => {
  const testFilePath = path.join(testDataDir, 'test-atomic.json');
  const testTempPath = `${testFilePath}.tmp`;
  const testData = JSON.stringify({ test: 'data' }, null, 2);
  
  // Clean up any existing files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await fsPromises.mkdir(testDataDir, { recursive: true });
  
  // Write using writeAtomic
  await writeAtomic(testFilePath, testData);
  
  // Verify main file exists
  assert.ok(fs.existsSync(testFilePath), 'Main file should exist');
  // Verify temp file does NOT exist (should have been renamed)
  assert.ok(!fs.existsSync(testTempPath), 'Temp file should not exist after successful write');
  
  // Verify content
  const content = await fsPromises.readFile(testFilePath, 'utf8');
  assert.equal(content, testData);
});

test('recoverOrphanedFile recovers .tmp file when canonical is missing', async () => {
  const testFilePath = path.join(testDataDir, 'test-recovery.json');
  const testTempPath = `${testFilePath}.tmp`;
  const testData = '{"recovered": true}';
  
  // Clean up any existing files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await fsPromises.mkdir(testDataDir, { recursive: true });
  
  // Create only temp file (simulating crash during write)
  await fsPromises.writeFile(testTempPath, testData, 'utf8');
  
  // Recover orphaned file
  const recovered = await recoverOrphanedFile(testFilePath);
  assert.equal(recovered, true, 'Should have recovered file');
  
  // Verify canonical file now exists with correct content
  assert.ok(fs.existsSync(testFilePath), 'Canonical file should exist after recovery');
  assert.ok(!fs.existsSync(testTempPath), 'Temp file should not exist after recovery');
  
  const content = await fsPromises.readFile(testFilePath, 'utf8');
  assert.equal(content, testData);
});

test('recoverOrphanedFile cleans up .tmp file when canonical exists', async () => {
  const testFilePath = path.join(testDataDir, 'test-cleanup.json');
  const testTempPath = `${testFilePath}.tmp`;
  const canonicalData = '{"canonical": true}';
  const tempData = '{"temp": true}';
  
  // Clean up any existing files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await fsPromises.mkdir(testDataDir, { recursive: true });
  
  // Create both files (simulating crash after rename but before temp deletion)
  await fsPromises.writeFile(testFilePath, canonicalData, 'utf8');
  await fsPromises.writeFile(testTempPath, tempData, 'utf8');
  
  // Recover orphaned file
  const recovered = await recoverOrphanedFile(testFilePath);
  assert.equal(recovered, false, 'Should not have recovered file (canonical exists)');
  
  // Verify canonical file still exists with original content
  assert.ok(fs.existsSync(testFilePath), 'Canonical file should still exist');
  assert.ok(!fs.existsSync(testTempPath), 'Temp file should have been cleaned up');
  
  const content = await fsPromises.readFile(testFilePath, 'utf8');
  assert.equal(content, canonicalData);
});

test('writeCredentials uses writeAtomic for crash-safe writes', async () => {
  // Clean up any existing files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await ensureDataDir(config);
  
  const testCredentials = [
    { id: 'cred-1', name: 'Test Credential 1' },
    { id: 'cred-2', name: 'Test Credential 2' }
  ];
  
  // Write credentials
  await writeCredentials(config, testCredentials);
  
  // Verify main file exists
  assert.ok(fs.existsSync(config.credentialStorePath), 'Credential store file should exist');
  
  // Verify no temp file exists
  const tempPath = `${config.credentialStorePath}.tmp`;
  assert.ok(!fs.existsSync(tempPath), 'Temp file should not exist after successful write');
  
  // Verify content can be read back
  const credentials = await readCredentials(config);
  assert.equal(credentials.length, 2);
  assert.equal(credentials[0].id, 'cred-1');
  assert.equal(credentials[1].id, 'cred-2');
});

test('ensureDataDir recovers orphaned .tmp files on startup', async () => {
  // Clean up any existing files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  
  // Create temp file only (simulating crash during credential write)
  const tempPath = `${config.credentialStorePath}.tmp`;
  const tempData = JSON.stringify({ 
    credentials: [{ id: 'recovered-cred', name: 'Recovered Credential' }] 
  }, null, 2);
  
  await fsPromises.mkdir(path.dirname(config.credentialStorePath), { recursive: true });
  await fsPromises.writeFile(tempPath, tempData, 'utf8');
  
  // Run ensureDataDir (should trigger recovery)
  await ensureDataDir(config);
  
  // Verify recovery happened
  assert.ok(fs.existsSync(config.credentialStorePath), 'Credential store should exist after recovery');
  assert.ok(!fs.existsSync(tempPath), 'Temp file should not exist after recovery');
  
  // Verify recovered content
  const credentials = await readCredentials(config);
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].id, 'recovered-cred');
  assert.equal(credentials[0].name, 'Recovered Credential');
});

import { clearCredentialCache } from '../src/storage.js';

// ── Cache isolation tests (#484) ─────────────────────────────────────────────

test('cache is isolated per credentialStorePath — two configs never share cached data', async (t) => {
  const dirA = path.resolve(process.cwd(), 'test-data-cache-a');
  const dirB = path.resolve(process.cwd(), 'test-data-cache-b');

  t.after(async () => {
    await fsPromises.rm(dirA, { recursive: true, force: true });
    await fsPromises.rm(dirB, { recursive: true, force: true });
  });

  const configA = {
    dataDir: dirA,
    auditLogPath: path.join(dirA, 'audit'),
    credentialStorePath: path.join(dirA, 'credentials.json'),
    auditLogRetentionDays: 3,
  };
  const configB = {
    dataDir: dirB,
    auditLogPath: path.join(dirB, 'audit'),
    credentialStorePath: path.join(dirB, 'credentials.json'),
    auditLogRetentionDays: 3,
  };

  await ensureDataDir(configA);
  await ensureDataDir(configB);

  // Seed different credentials into each store
  await writeCredentials(configA, [{ id: 'cred-a', name: 'Config A credential' }]);
  await writeCredentials(configB, [{ id: 'cred-b', name: 'Config B credential' }]);

  // Populate both caches
  const fromA = await readCredentials(configA);
  const fromB = await readCredentials(configB);

  // Each config sees only its own data
  assert.equal(fromA.length, 1, 'Config A should have exactly one credential');
  assert.equal(fromA[0].id, 'cred-a', 'Config A should see cred-a');
  assert.equal(fromB.length, 1, 'Config B should have exactly one credential');
  assert.equal(fromB[0].id, 'cred-b', 'Config B should see cred-b');

  // Explicit cross-contamination check: A must not contain cred-b, B must not contain cred-a
  assert.ok(!fromA.some((c) => c.id === 'cred-b'), 'Config A cache must not contain cred-b');
  assert.ok(!fromB.some((c) => c.id === 'cred-a'), 'Config B cache must not contain cred-a');
});

test('writing to one config does not evict or corrupt the other config cache', async (t) => {
  const dirA = path.resolve(process.cwd(), 'test-data-evict-a');
  const dirB = path.resolve(process.cwd(), 'test-data-evict-b');

  t.after(async () => {
    await fsPromises.rm(dirA, { recursive: true, force: true });
    await fsPromises.rm(dirB, { recursive: true, force: true });
  });

  const configA = {
    dataDir: dirA,
    auditLogPath: path.join(dirA, 'audit'),
    credentialStorePath: path.join(dirA, 'credentials.json'),
    auditLogRetentionDays: 3,
  };
  const configB = {
    dataDir: dirB,
    auditLogPath: path.join(dirB, 'audit'),
    credentialStorePath: path.join(dirB, 'credentials.json'),
    auditLogRetentionDays: 3,
  };

  await ensureDataDir(configA);
  await ensureDataDir(configB);

  await writeCredentials(configA, [{ id: 'a1' }]);
  await writeCredentials(configB, [{ id: 'b1' }]);

  // Prime both caches
  await readCredentials(configA);
  await readCredentials(configB);

  // Write to A — should only evict A's cache, not B's
  await writeCredentials(configA, [{ id: 'a1' }, { id: 'a2' }]);

  // B's cache is still warm — should still return b1 without re-reading disk
  // (we verify by reading and checking the value, not the source)
  const fromB = await readCredentials(configB);
  assert.equal(fromB.length, 1, 'Config B should still have one credential');
  assert.equal(fromB[0].id, 'b1', 'Config B should still see b1');

  // A's cache was evicted — fresh read should pick up both credentials
  const fromA = await readCredentials(configA);
  assert.equal(fromA.length, 2, 'Config A should now have two credentials after write');
  assert.ok(fromA.some((c) => c.id === 'a2'), 'Config A should include a2 after write');
});

test('clearCredentialCache with config only clears the targeted path', async (t) => {
  const dirA = path.resolve(process.cwd(), 'test-data-clear-a');
  const dirB = path.resolve(process.cwd(), 'test-data-clear-b');

  t.after(async () => {
    await fsPromises.rm(dirA, { recursive: true, force: true });
    await fsPromises.rm(dirB, { recursive: true, force: true });
  });

  const configA = {
    dataDir: dirA,
    auditLogPath: path.join(dirA, 'audit'),
    credentialStorePath: path.join(dirA, 'credentials.json'),
    auditLogRetentionDays: 3,
  };
  const configB = {
    dataDir: dirB,
    auditLogPath: path.join(dirB, 'audit'),
    credentialStorePath: path.join(dirB, 'credentials.json'),
    auditLogRetentionDays: 3,
  };

  await ensureDataDir(configA);
  await ensureDataDir(configB);

  await writeCredentials(configA, [{ id: 'a1' }]);
  await writeCredentials(configB, [{ id: 'b1' }]);

  // Prime both caches
  await readCredentials(configA);
  await readCredentials(configB);

  // Clear only A's cache
  clearCredentialCache(configA);

  // B should still serve from cache (no disk re-read needed)
  const fromB = await readCredentials(configB);
  assert.equal(fromB[0].id, 'b1', 'Config B cache should be unaffected by clearing A');

  // A must re-read from disk (cache was cleared)
  const fromA = await readCredentials(configA);
  assert.equal(fromA[0].id, 'a1', 'Config A should re-read from disk after cache clear');
});
