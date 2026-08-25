import { logger } from './logger.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Formats a single SSE frame ("event: ...\ndata: ...\n\n").
 *
 * Malformed/non-serializable event data (circular references, BigInt, etc.)
 * must not crash the server or take down the whole stream — instead this
 * logs the failure and returns null so the caller can skip just that event.
 */
export function formatEvent(eventName, data) {
  let payload;
  try {
    payload = JSON.stringify(data);
  } catch (error) {
    logger.error({ error: error.message, eventName }, 'Failed to serialize SSE event data');
    return null;
  }
  const lines = [`event: ${eventName}`];
  for (const line of payload.split('\n')) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * Normalizes a raw event from SorobanClient#getEvents into the shape clients
 * expect. RPC nodes can return events with missing or unexpected fields
 * (e.g. mid-upgrade, or from a misbehaving contract) — those are coerced to
 * safe defaults here rather than throwing, so one bad payload doesn't
 * interrupt streaming for every other subscriber. Returns null only when the
 * raw value isn't an object at all.
 */
export function normalizeContractEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    logger.error({ raw }, 'Skipping malformed contract event: not an object');
    return null;
  }
  try {
    const topic = Array.isArray(raw.topic)
      ? raw.topic.map((entry) => (typeof entry === 'string' ? entry : safeStringify(entry)))
      : [];
    const ledger = Number.isFinite(raw.ledger) ? raw.ledger : Number.parseInt(raw.ledger, 10);

    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : safeStringify({ ledger: raw.ledger, topic }),
      type: topic[0] ?? 'unknown',
      contractId: typeof raw.contractId === 'string' ? raw.contractId : '',
      topic,
      value: raw.value ?? null,
      ledger: Number.isFinite(ledger) ? ledger : 0,
      txHash: typeof raw.txHash === 'string' ? raw.txHash : '',
      timestamp: typeof raw.ledgerClosedAt === 'string' ? raw.ledgerClosedAt : new Date().toISOString(),
    };
  } catch (error) {
    logger.error({ error: error.message }, 'Skipping malformed contract event: normalization failed');
    return null;
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function eventMatchesFilter(event, { contractId, topics }) {
  if (contractId && event.contractId !== contractId) return false;
  if (topics && topics.length > 0) {
    return topics.every((expected, i) => expected === '' || event.topic[i] === expected);
  }
  return true;
}

/**
 * Handles GET /events: subscribes the response as a Server-Sent Events
 * stream and polls soroban.getEvents() on config.eventPollIntervalMs,
 * forwarding new contract events (optionally filtered by contractId/topic
 * query params) to the client.
 *
 * A malformed event from the RPC node, or one that fails to serialize, is
 * logged and skipped — it never throws out of the poll loop, so it can't
 * crash the process or drop the connection for other subscribers.
 */
export function handleEventsRequest(req, res, url, { config, soroban }) {
  const contractId = url.searchParams.get('contractId') || undefined;
  const topicParam = url.searchParams.get('topic');
  const topics = topicParam ? topicParam.split(',') : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const connectedFrame = formatEvent('connected', { ok: true });
  if (connectedFrame) res.write(connectedFrame);

  let nextLedger = 0;
  let closed = false;
  let polling = false;

  const heartbeatTimer = setInterval(() => {
    const frame = formatEvent('heartbeat', { ts: new Date().toISOString() });
    if (frame) res.write(frame);
  }, HEARTBEAT_INTERVAL_MS);

  const pollIntervalMs = config.eventPollIntervalMs > 0 ? config.eventPollIntervalMs : 5000;
  const pollTimer = setInterval(async () => {
    if (polling) return; // avoid overlapping polls if getEvents is slow
    polling = true;
    try {
      const rawEvents = await soroban.getEvents(nextLedger);
      for (const raw of rawEvents) {
        const event = normalizeContractEvent(raw);
        if (!event) continue;
        if (event.ledger >= nextLedger) nextLedger = event.ledger + 1;
        if (!eventMatchesFilter(event, { contractId, topics })) continue;
        const frame = formatEvent('contract-event', event);
        if (frame) res.write(frame);
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to poll contract events for SSE stream');
    } finally {
      polling = false;
    }
  }, pollIntervalMs);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
}
