import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EmailTransport,
  renderExpiryBody,
  renderExpirySubject,
  resolveRecipient,
} from '../src/email.js';
import {
  appendNotificationLog,
  getNotificationLogPath,
  readNotificationLog,
  summarizeNotificationLog,
} from '../src/notification-log.js';
import { ExpiryNotificationJob } from '../src/expiry.js';

async function makeConfig(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-notify-'));
  return {
    dataDir,
    credentialStorePath: path.join(dataDir, 'credentials.json'),
    expiryWarningDays: 7,
    expiryReminderThresholds: [7, 3, 1],
    expiryJobIntervalMs: 60_000,
    expiryConcurrency: 2,
    expiryCronSchedule: '',
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
    subjectNotificationEmails: {},
    notificationEmail: '',
    emailApiUrl: '',
    emailApiKey: '',
    emailFrom: '',
    notificationMaxRetries: 2,
    notificationRetryBaseMs: 1,
    ...overrides,
  };
}

function credentialExpiringIn(days, overrides = {}) {
  return {
    id: 'cred-1',
    subject: 'GSUBJECT',
    issuer: 'GISSUER',
    credentialType: 'KYC',
    expires_at: Math.floor(Date.now() / 1000) + days * 24 * 3600,
    daysRemaining: days,
    dueThreshold: days,
    ...overrides,
  };
}

test('renderExpirySubject varies with days remaining', () => {
  assert.equal(
    renderExpirySubject({ credentialType: 'KYC', daysRemaining: 7 }),
    'KYC credential expires in 7 days',
  );
  assert.equal(
    renderExpirySubject({ credentialType: 'KYC', daysRemaining: 1 }),
    'KYC credential expires tomorrow',
  );
  assert.equal(
    renderExpirySubject({ credentialType: 'KYC', daysRemaining: 0 }),
    'KYC credential has expired',
  );
});

test('renderExpiryBody escapes HTML in credential fields', () => {
  const { text, html } = renderExpiryBody({
    credential: credentialExpiringIn(3, { credentialType: '<script>x</script>' }),
    daysRemaining: 3,
    threshold: 3,
  });
  assert.match(text, /Days remaining: 3/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('resolveRecipient honours per-credential, per-subject, then global addresses', async () => {
  const config = await makeConfig({
    notificationEmail: 'fallback@example.com',
    subjectNotificationEmails: { GSUBJECT: 'subject@example.com' },
  });

  assert.equal(
    resolveRecipient(config, { subject: 'GSUBJECT', notificationEmail: 'direct@example.com' }),
    'direct@example.com',
  );
  assert.equal(resolveRecipient(config, { subject: 'GSUBJECT' }), 'subject@example.com');
  assert.equal(resolveRecipient(config, { subject: 'GOTHER' }), 'fallback@example.com');
});

test('EmailTransport is disabled until both API url and from address are set', async () => {
  const partial = await makeConfig({ emailApiUrl: 'https://mail.example.com/send' });
  assert.equal(new EmailTransport(partial).enabled, false);

  const complete = await makeConfig({
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
  });
  assert.equal(new EmailTransport(complete).enabled, true);
});

test('EmailTransport posts a JSON message with a bearer token', async () => {
  const config = await makeConfig({
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
    emailApiKey: 'secret-key',
  });

  const calls = [];
  const transport = new EmailTransport(config, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 202 };
    },
  });

  const result = await transport.send({
    to: 'holder@example.com',
    subject: 'Expiring soon',
    text: 'body',
    html: '<p>body</p>',
  });

  assert.equal(result.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mail.example.com/send');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.to, 'holder@example.com');
  assert.equal(body.from, 'noreply@example.com');
});

test('EmailTransport throws on a non-2xx provider response', async () => {
  const config = await makeConfig({
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
  });
  const transport = new EmailTransport(config, {
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });

  await assert.rejects(
    () => transport.send({ to: 'holder@example.com', subject: 's', text: 't' }),
    /HTTP 500/,
  );
});

test('appendNotificationLog writes NDJSON that survives torn lines', async () => {
  const config = await makeConfig();
  await appendNotificationLog(config, { credentialId: 'a', channel: 'email', status: 'delivered' });
  await appendNotificationLog(config, { credentialId: 'b', channel: 'webhook', status: 'failed' });
  await fs.appendFile(getNotificationLogPath(config), '{not json\n', 'utf8');

  const entries = await readNotificationLog(config);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].credentialId, 'a');
  assert.ok(entries[0].timestamp);

  const failedOnly = await readNotificationLog(config, { status: 'failed' });
  assert.equal(failedOnly.length, 1);
  assert.equal(failedOnly[0].credentialId, 'b');

  const forA = await readNotificationLog(config, { credentialId: 'a' });
  assert.equal(forA.length, 1);
});

test('readNotificationLog returns an empty list when no log exists', async () => {
  const config = await makeConfig();
  assert.deepEqual(await readNotificationLog(config), []);
});

test('summarizeNotificationLog counts outcomes per channel', async () => {
  const config = await makeConfig();
  await appendNotificationLog(config, { credentialId: 'a', channel: 'email', status: 'delivered' });
  await appendNotificationLog(config, { credentialId: 'b', channel: 'email', status: 'failed' });
  await appendNotificationLog(config, { credentialId: 'c', channel: 'webhook', status: 'delivered' });

  const summary = await summarizeNotificationLog(config);
  assert.equal(summary.total, 3);
  assert.equal(summary.delivered, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.byChannel.email.delivered, 1);
  assert.equal(summary.byChannel.email.failed, 1);
  assert.equal(summary.byChannel.webhook.delivered, 1);
});

test('dispatch sends both webhook and email and logs each attempt', async () => {
  const config = await makeConfig({
    notificationWebhookUrl: 'https://hooks.example.com/expiry',
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
    notificationEmail: 'holder@example.com',
  });

  const sent = [];
  const emailTransport = new EmailTransport(config, {
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    },
  });

  const originalFetch = globalThis.fetch;
  const webhookCalls = [];
  globalThis.fetch = async (url, options) => {
    webhookCalls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };

  try {
    const job = new ExpiryNotificationJob(config, null, { emailTransport });
    const result = await job.dispatch(credentialExpiringIn(3));

    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].body.threshold_days, 3);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'holder@example.com');
    assert.equal(result.skipped, false);

    const statuses = result.channels.map((channel) => `${channel.channel}:${channel.status}`).sort();
    assert.deepEqual(statuses, ['email:delivered', 'webhook:delivered']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logs = await readNotificationLog(config);
  assert.equal(logs.filter((entry) => entry.status === 'delivered').length, 2);
});

test('dispatch retries a failing channel up to the configured limit', async () => {
  const config = await makeConfig({
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
    notificationEmail: 'holder@example.com',
    notificationMaxRetries: 3,
    notificationRetryBaseMs: 1,
  });

  let attempts = 0;
  const emailTransport = new EmailTransport(config, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, status: 503 };
      return { ok: true, status: 202 };
    },
  });

  const job = new ExpiryNotificationJob(config, null, { emailTransport });
  const result = await job.dispatch(credentialExpiringIn(1));

  assert.equal(attempts, 3);
  const email = result.channels.find((channel) => channel.channel === 'email');
  assert.equal(email.status, 'delivered');
  assert.equal(email.attempt, 3);

  const logs = await readNotificationLog(config);
  assert.equal(logs.filter((entry) => entry.status === 'failed').length, 2);
  assert.equal(logs.filter((entry) => entry.status === 'delivered').length, 1);
});

test('dispatch throws when every configured channel fails', async () => {
  const config = await makeConfig({
    emailApiUrl: 'https://mail.example.com/send',
    emailFrom: 'noreply@example.com',
    notificationEmail: 'holder@example.com',
    notificationMaxRetries: 1,
  });

  const emailTransport = new EmailTransport(config, {
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });

  const job = new ExpiryNotificationJob(config, null, { emailTransport });
  await assert.rejects(() => job.dispatch(credentialExpiringIn(1)), /all notification channels failed/);
});

test('dispatch reports skipped when no channel is configured', async () => {
  const config = await makeConfig();
  const job = new ExpiryNotificationJob(config, null, { emailTransport: new EmailTransport(config) });
  const result = await job.dispatch(credentialExpiringIn(5));

  assert.equal(result.skipped, true);
  assert.equal(result.target, null);
  assert.ok(result.channels.every((channel) => channel.status === 'skipped'));
});

test('start uses the cron scheduler when EXPIRY_CRON_SCHEDULE is set', async () => {
  const config = await makeConfig({ expiryCronSchedule: '0 9 * * *' });
  const job = new ExpiryNotificationJob(config, null, { emailTransport: new EmailTransport(config) });

  job.start();
  assert.ok(job.cronJob, 'expected a cron job to be scheduled');
  assert.equal(job.timer, null);
  assert.ok(job.cronJob.nextRun instanceof Date);
  job.stop();
  assert.equal(job.cronJob, null);
});

test('start rejects an invalid cron expression', async () => {
  const config = await makeConfig({ expiryCronSchedule: 'not a cron' });
  const job = new ExpiryNotificationJob(config, null, { emailTransport: new EmailTransport(config) });
  assert.throws(() => job.start(), /Cron expression must have 5 fields/);
});
