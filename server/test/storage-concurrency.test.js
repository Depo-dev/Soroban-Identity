/**
 * Concurrency regression tests for credential storage (#483).
 *
 * Verifies that concurrent createAndPersistCredential calls cannot lose
 * updates due to an unlocked read-modify-write race, and that writeAtomic
 * uses unique temp filenames so concurrent writers never clobber each other.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureDataDir,
  createAndPersistCredential,
  readCredentials,
  writeCredentials,
  writeAtomic,
  DuplicateCredentialError,
} from '../src/storage.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfig(dir) {
  return {
    dataDir: dir,
    auditLogPath: path.join(dir, 'audit'),
    credentialStorePath: path.join(dir, 'credentials.json'),
    auditLogRetentionDays: 3,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('N concurrent createAndPersistCredential calls all land — no lost updates', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = makeTmpConfig(dir);
  await ensureDataDir(config);

  const N = 20;
  const ids = Array.from({ length: N }, (_, i) => `cred-${i}`);

  // Fire all N creates simultaneously — this is the race the bug allowed
  const results = await Promise.allSettled(
    ids.map((id) => createAndPersistCredential(config, { id, value: id })),
  );

  // None should have thrown (no duplicates — each id is unique)
  const failures = results.filter((r) => r.status === 'rejected');
  assert.equal(failures.length, 0, `Expected 0 failures, got: ${failures.map((f) => f.reason?.message).join(', ')}`);

  // All N credentials must be present on disk
  const persisted = await readCredentials(config);
  assert.equal(persisted.length, N, `Expected ${N} credentials, got ${persisted.length}`);

  const persistedIds = new Set(persisted.map((c) => c.id));
  for (const id of ids) {
    assert.ok(persistedIds.has(id), `Credential ${id} was lost`);
  }
});

test('createAndPersistCredential throws DuplicateCredentialError for duplicate id', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-dup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = makeTmpConfig(dir);
  await ensureDataDir(config);

  await createAndPersistCredential(config, { id: 'dup-1', value: 'first' });

  await assert.rejects(
    () => createAndPersistCredential(config, { id: 'dup-1', value: 'second' }),
    (err) => {
      assert.ok(err instanceof DuplicateCredentialError, 'Should throw DuplicateCredentialError');
      assert.equal(err.id, 'dup-1');
      return true;
    },
  );

  // Only one credential should be persisted
  const persisted = await readCredentials(config);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].value, 'first', 'Original credential should be unchanged');
});

test('concurrent duplicate creates: exactly one succeeds and the rest throw DuplicateCredentialError', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-dup-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = makeTmpConfig(dir);
  await ensureDataDir(config);

  const CONCURRENCY = 10;
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      createAndPersistCredential(config, { id: 'same-id', attempt: i }),
    ),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  assert.equal(succeeded.length, 1, 'Exactly one concurrent create should succeed');
  assert.equal(failed.length, CONCURRENCY - 1, `The other ${CONCURRENCY - 1} should fail`);

  for (const f of failed) {
    assert.ok(
      f.reason instanceof DuplicateCredentialError,
      `Expected DuplicateCredentialError, got: ${f.reason?.constructor?.name}`,
    );
  }

  const persisted = await readCredentials(config);
  assert.equal(persisted.length, 1, 'Only one credential should be persisted');
});

test('writeAtomic uses unique temp filenames — concurrent writes never share a .tmp file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-tmp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'target.json');

  // Launch many concurrent writeAtomic calls to the same target
  const CONCURRENT = 15;
  const payloads = Array.from({ length: CONCURRENT }, (_, i) => JSON.stringify({ v: i }));

  await Promise.all(payloads.map((data) => writeAtomic(target, data)));

  // All temp files should be gone after completion
  const entries = await fs.readdir(dir);
  const leftoverTemps = entries.filter((e) => e.includes('.tmp'));
  assert.equal(leftoverTemps.length, 0, `Leftover temp files after concurrent writes: ${leftoverTemps.join(', ')}`);

  // Target file must exist and contain valid JSON
  const content = await fs.readFile(target, 'utf8');
  assert.doesNotThrow(() => JSON.parse(content), 'Target file should contain valid JSON');
});

test('write to one config path does not block reads on a different path', async (t) => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-lock-a-'));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-lock-b-'));
  t.after(async () => {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  });

  const configA = makeTmpConfig(dirA);
  const configB = makeTmpConfig(dirB);
  await ensureDataDir(configA);
  await ensureDataDir(configB);

  // Seed B with a credential
  await writeCredentials(configB, [{ id: 'b-existing' }]);

  // Start a write to A and a read from B simultaneously
  const [, fromB] = await Promise.all([
    createAndPersistCredential(configA, { id: 'a-new' }),
    readCredentials(configB),
  ]);

  assert.equal(fromB.length, 1, 'Config B read should not be blocked by config A write');
  assert.equal(fromB[0].id, 'b-existing');
});
