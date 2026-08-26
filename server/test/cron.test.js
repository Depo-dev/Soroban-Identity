import test from 'node:test';
import assert from 'node:assert/strict';
import { CronJob, cronMatches, nextRunAt, parseCronExpression } from '../src/cron.js';

test('parseCronExpression expands wildcards to full ranges', () => {
  const parsed = parseCronExpression('* * * * *');
  assert.equal(parsed.minute.size, 60);
  assert.equal(parsed.hour.size, 24);
  assert.equal(parsed.dayOfMonth.size, 31);
  assert.equal(parsed.month.size, 12);
  assert.equal(parsed.dayOfWeek.size, 7);
});

test('parseCronExpression handles fixed values, lists, ranges and steps', () => {
  const parsed = parseCronExpression('0,30 9-17 1 */3 mon-fri');
  assert.deepEqual([...parsed.minute].sort((a, b) => a - b), [0, 30]);
  assert.deepEqual([...parsed.hour].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parsed.dayOfMonth], [1]);
  assert.deepEqual([...parsed.month].sort((a, b) => a - b), [1, 4, 7, 10]);
  assert.deepEqual([...parsed.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('parseCronExpression treats day-of-week 7 as Sunday', () => {
  const parsed = parseCronExpression('0 0 * * 7');
  assert.deepEqual([...parsed.dayOfWeek], [0]);
});

test('parseCronExpression rejects malformed expressions', () => {
  assert.throws(() => parseCronExpression('0 0 * *'), /must have 5 fields/);
  assert.throws(() => parseCronExpression('0 99 * * *'), /out of range/);
  assert.throws(() => parseCronExpression('*/0 * * * *'), /Invalid cron step/);
  assert.throws(() => parseCronExpression('nope * * * *'), /Invalid cron value/);
});

test('cronMatches evaluates a daily 09:00 schedule', () => {
  const parsed = parseCronExpression('0 9 * * *');
  assert.equal(cronMatches(parsed, new Date(2026, 0, 5, 9, 0)), true);
  assert.equal(cronMatches(parsed, new Date(2026, 0, 5, 9, 1)), false);
  assert.equal(cronMatches(parsed, new Date(2026, 0, 5, 10, 0)), false);
});

test('cronMatches ORs day-of-month with day-of-week when both are restricted', () => {
  const parsed = parseCronExpression('0 0 13 * 5');
  // 2026-02-13 is a Friday: both fields match.
  assert.equal(cronMatches(parsed, new Date(2026, 1, 13, 0, 0)), true);
  // 2026-02-06 is a Friday but not the 13th: day-of-week alone is enough.
  assert.equal(cronMatches(parsed, new Date(2026, 1, 6, 0, 0)), true);
  // 2026-03-13 is a Friday; use a 13th that is not a Friday instead.
  assert.equal(cronMatches(parsed, new Date(2026, 0, 13, 0, 0)), true);
  // Neither field matches.
  assert.equal(cronMatches(parsed, new Date(2026, 0, 14, 0, 0)), false);
});

test('nextRunAt returns the next matching minute after the given time', () => {
  const parsed = parseCronExpression('0 9 * * *');
  const next = nextRunAt(parsed, new Date(2026, 0, 5, 8, 59));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 5);

  const nextDay = nextRunAt(parsed, new Date(2026, 0, 5, 9, 0));
  assert.equal(nextDay.getDate(), 6);
  assert.equal(nextDay.getHours(), 9);
});

test('nextRunAt never returns a time in the past', () => {
  const parsed = parseCronExpression('*/5 * * * *');
  const from = new Date(2026, 0, 5, 8, 2, 30);
  const next = nextRunAt(parsed, from);
  assert.ok(next.getTime() > from.getTime());
  assert.equal(next.getMinutes() % 5, 0);
});

test('CronJob skips overlapping runs instead of queueing them', async () => {
  let running = 0;
  let maxConcurrent = 0;
  let completed = 0;

  const job = new CronJob('* * * * *', async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    completed += 1;
  });

  // Drive run() manually so the test does not wait for a real cron minute.
  const first = job.run();
  const second = job.run();
  await Promise.all([first, second]);
  job.stop();

  assert.equal(maxConcurrent, 1);
  assert.equal(completed, 1);
});

test('CronJob surfaces task errors through onError without throwing', async () => {
  const errors = [];
  const job = new CronJob('* * * * *', async () => {
    throw new Error('boom');
  }, { onError: (error) => errors.push(error.message) });

  await job.run();
  job.stop();

  assert.deepEqual(errors, ['boom']);
});
