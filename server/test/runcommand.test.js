import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand, SorobanTimeoutError } from '../src/soroban.js';

test('runCommand executes a simple command successfully', async () => {
  // Test with a simple command that just echoes output
  const output = await runCommand('node', ['-e', 'console.log("success")'], 5000);
  assert.ok(output.includes('success'), 'Command should output "success"');
});

test('runCommand rejects when command fails with non-zero exit code', async () => {
  await assert.rejects(
    async () => {
      await runCommand('node', ['-e', 'process.exit(1)'], 5000);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('command failed'));
      return true;
    }
  );
});

test('runCommand times out and kills process after timeoutMs', async () => {
  const timeoutMs = 200;
  const startTime = Date.now();

  await assert.rejects(
    async () => {
      // Create a script that hangs indefinitely
      const hangScript = 'setInterval(() => {}, 1000)';
      await runCommand('node', ['-e', hangScript], timeoutMs);
    },
    (err) => {
      const elapsed = Date.now() - startTime;
      assert.ok(
        err instanceof SorobanTimeoutError,
        'Should throw SorobanTimeoutError on timeout'
      );
      assert.equal(err.timeoutMs, timeoutMs);
      assert.ok(
        elapsed >= timeoutMs && elapsed < timeoutMs + 1000,
        `Timeout should occur around ${timeoutMs}ms, got ${elapsed}ms`
      );
      return true;
    }
  );
});

test('runCommand captures stderr in error message', async () => {
  await assert.rejects(
    async () => {
      const stderrScript = 'console.error("test error"); process.exit(1)';
      await runCommand('node', ['-e', stderrScript], 5000);
    },
    (err) => {
      assert.ok(err.message.includes('test error'), 'stderr should be in error message');
      return true;
    }
  );
});

test('runCommand captures stdout when no stderr', async () => {
  await assert.rejects(
    async () => {
      const stdoutScript = 'console.log("stdout message"); process.exit(1)';
      await runCommand('node', ['-e', stdoutScript], 5000);
    },
    (err) => {
      assert.ok(
        err.message.includes('stdout message'),
        'stdout should be in error message when stderr is empty'
      );
      return true;
    }
  );
});

test('runCommand returns clean output without extra whitespace', async () => {
  const output = await runCommand('node', ['-e', 'console.log("test output")'], 5000);
  assert.equal(output.trim(), 'test output', 'Output should be trimmed in invoke()');
});
