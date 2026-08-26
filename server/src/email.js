import { logger } from './logger.js';

/**
 * Render the subject line for an expiry reminder.
 */
export function renderExpirySubject({ credentialType, daysRemaining }) {
  const label = credentialType ? `${credentialType} credential` : 'Credential';
  if (daysRemaining <= 0) return `${label} has expired`;
  if (daysRemaining === 1) return `${label} expires tomorrow`;
  return `${label} expires in ${daysRemaining} days`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render both the plain-text and HTML bodies for an expiry reminder.
 *
 * @param {object} params
 * @param {object} params.credential - Credential record
 * @param {number} params.daysRemaining
 * @param {number} params.threshold - Reminder threshold that triggered this send
 * @returns {{text: string, html: string}}
 */
export function renderExpiryBody({ credential, daysRemaining, threshold }) {
  const expiresAt = Number(credential.expires_at ?? credential.expiresAt ?? 0);
  const expiryDate = expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : 'unknown';

  const lines = [
    `Credential ID: ${credential.id}`,
    `Type: ${credential.credentialType ?? 'unspecified'}`,
    `Issuer: ${credential.issuer ?? 'unknown'}`,
    `Subject: ${credential.subject ?? 'unknown'}`,
    `Expires at: ${expiryDate}`,
    `Days remaining: ${daysRemaining}`,
    `Reminder threshold: ${threshold} day(s)`,
  ];

  const text = [
    daysRemaining <= 0
      ? 'One of your credentials has expired.'
      : `One of your credentials expires in ${daysRemaining} day(s).`,
    '',
    ...lines,
    '',
    'Renew or re-issue this credential to avoid verification failures.',
  ].join('\n');

  const html = [
    '<div>',
    `<p>${escapeHtml(
      daysRemaining <= 0
        ? 'One of your credentials has expired.'
        : `One of your credentials expires in ${daysRemaining} day(s).`,
    )}</p>`,
    '<ul>',
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    '</ul>',
    '<p>Renew or re-issue this credential to avoid verification failures.</p>',
    '</div>',
  ].join('');

  return { text, html };
}

/**
 * HTTP-API email transport.
 *
 * Deliberately provider-agnostic: it POSTs a JSON message to
 * `EMAIL_API_URL` with an optional bearer token. This keeps the server free of
 * an SMTP dependency while working against SendGrid-style, Mailgun-style, or
 * in-house relay endpoints behind a thin adapter.
 */
export class EmailTransport {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.emailApiUrl && this.config.emailFrom);
  }

  /**
   * Send one email.
   *
   * @param {object} message
   * @param {string} message.to
   * @param {string} message.subject
   * @param {string} message.text
   * @param {string} [message.html]
   * @returns {Promise<{status:number, durationMs:number}>}
   */
  async send({ to, subject, text, html }) {
    if (!this.enabled) {
      throw new Error('Email transport is not configured (set EMAIL_API_URL and EMAIL_FROM)');
    }
    if (!to) throw new Error('Email recipient is required');

    const headers = { 'content-type': 'application/json' };
    if (this.config.emailApiKey) {
      headers.authorization = `Bearer ${this.config.emailApiKey}`;
    }

    const body = JSON.stringify({
      from: this.config.emailFrom,
      to,
      subject,
      text,
      html,
    });

    const startTime = Date.now();
    const response = await this.fetchImpl(this.config.emailApiUrl, {
      method: 'POST',
      headers,
      body,
    });
    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      logger.error({ to, subject, status: response.status, durationMs }, 'Email delivery failed');
      throw new Error(`email dispatch failed with HTTP ${response.status}`);
    }

    logger.info({ to, subject, status: response.status, durationMs }, 'Email delivered');
    return { status: response.status, durationMs };
  }
}

/**
 * Resolve the notification email address for a credential.
 *
 * Precedence: per-credential address, then the configured per-subject map,
 * then the global fallback address.
 */
export function resolveRecipient(config, credential) {
  return (
    credential.notificationEmail ??
    credential.notification_email ??
    config.subjectNotificationEmails?.[credential.subject] ??
    config.notificationEmail ??
    null
  );
}
