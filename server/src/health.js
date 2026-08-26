import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Process start time, captured once at module load so uptime is measured from
 * when the server booted rather than when the first probe arrived.
 */
const STARTED_AT = Date.now();

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Dependency health states, ordered from healthiest to least healthy.
 *
 * - `up`       — the dependency answered successfully
 * - `degraded` — the dependency answered, but not fully (partial contract set)
 * - `down`     — the dependency failed or timed out
 * - `disabled` — the dependency is not configured, so it is not a failure
 */
export const STATUS = {
  UP: 'up',
  DEGRADED: 'degraded',
  DOWN: 'down',
  DISABLED: 'disabled',
};

/**
 * Race a probe against a timeout so one hung dependency cannot stall the whole
 * health check. The timer is unref'd so it never holds the process open.
 */
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one dependency probe, recording its latency and turning any throw into a
 * `down` result. A probe never rejects, so one failing dependency cannot
 * prevent the others from being reported.
 */
async function runProbe(name, timeoutMs, probe) {
  const startTime = Date.now();
  try {
    const result = await withTimeout(probe(), timeoutMs, name);
    return { name, latencyMs: Date.now() - startTime, ...result };
  } catch (error) {
    logger.warn({ dependency: name, error: error.message }, 'Health probe failed');
    return {
      name,
      status: STATUS.DOWN,
      latencyMs: Date.now() - startTime,
      error: error.message,
    };
  }
}

/**
 * Probe the local data store: the directory must exist and be writable, since
 * every credential write goes through it.
 */
export async function checkStorage(config, { fsImpl = fs } = {}) {
  const probeFile = path.join(config.dataDir, '.health-probe');
  await fsImpl.mkdir(config.dataDir, { recursive: true });
  await fsImpl.writeFile(probeFile, String(Date.now()), 'utf8');
  await fsImpl.unlink(probeFile);
  return { status: STATUS.UP, dataDir: config.dataDir, writable: true };
}

/**
 * Probe the Soroban RPC endpoint with a `getHealth` JSON-RPC call.
 */
export async function checkRpc(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });

  if (!response.ok) {
    throw new Error(`RPC returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body?.error) {
    throw new Error(body.error.message ?? 'RPC returned an error');
  }

  const rpcStatus = body?.result?.status;
  return {
    status: rpcStatus && rpcStatus !== 'healthy' ? STATUS.DEGRADED : STATUS.UP,
    url: config.rpcUrl,
    rpcStatus: rpcStatus ?? 'unknown',
    latestLedger: body?.result?.latestLedger,
  };
}

/**
 * Probe the deployed contracts. A partial response is `degraded` rather than
 * `down`: the service can still answer requests for the reachable contracts.
 */
export async function checkContracts(soroban) {
  const contracts = await soroban.pingAllContracts();
  const values = Object.values(contracts);
  const reachable = values.filter(Boolean).length;

  let status = STATUS.UP;
  if (reachable === 0 && values.length > 0) status = STATUS.DOWN;
  else if (reachable < values.length) status = STATUS.DEGRADED;

  return { status, contracts, reachable, total: values.length };
}

/**
 * Probe Redis when one is configured. An unconfigured cache reports `disabled`
 * rather than `down`, since running without Redis is a supported deployment.
 */
export async function checkRedis(config, redisClient) {
  if (!config.redisUrl || !redisClient) {
    return { status: STATUS.DISABLED, reason: 'REDIS_URL is not configured' };
  }
  const pong = await redisClient.ping();
  return { status: STATUS.UP, url: config.redisUrl, response: pong };
}

/**
 * Roll dependency results up into one overall status.
 *
 * `disabled` dependencies are ignored. Any `down` dependency makes the service
 * unhealthy; any `degraded` one makes it degraded.
 */
export function aggregateStatus(dependencies) {
  const considered = dependencies.filter((dependency) => dependency.status !== STATUS.DISABLED);
  if (considered.some((dependency) => dependency.status === STATUS.DOWN)) return 'unhealthy';
  if (considered.some((dependency) => dependency.status === STATUS.DEGRADED)) return 'degraded';
  return 'healthy';
}

/**
 * Seconds since the process started, as a whole number.
 */
export function uptimeSeconds(now = Date.now()) {
  return Math.floor((now - STARTED_AT) / 1000);
}

/**
 * Collect the full health report: every dependency probed in parallel, each
 * with its own timeout, plus version and uptime information.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.soroban
 * @param {object} [deps.redisClient]
 * @param {string} deps.version
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} Health report with a top-level `status`.
 */
export async function collectHealth({ config, soroban, redisClient = null, version }, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.healthProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const results = await Promise.all([
    runProbe('storage', timeoutMs, () => checkStorage(config)),
    runProbe('rpc', timeoutMs, () => checkRpc(config)),
    runProbe('contracts', timeoutMs, () => checkContracts(soroban)),
    runProbe('redis', timeoutMs, () => checkRedis(config, redisClient)),
  ]);

  const dependencies = {};
  for (const { name, ...rest } of results) {
    dependencies[name] = rest;
  }

  return {
    status: aggregateStatus(results),
    version,
    uptimeSeconds: uptimeSeconds(),
    startedAt: new Date(STARTED_AT).toISOString(),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    dependencies,
  };
}

/**
 * Readiness for a Kubernetes readiness probe.
 *
 * Readiness answers "can this instance serve traffic right now", which is a
 * narrower question than liveness: only the dependencies required to answer a
 * request count. Storage and RPC are required; contracts and Redis are
 * reported but do not gate readiness, since a single unreachable contract or a
 * cold cache still leaves most endpoints serviceable.
 */
export async function collectReadiness({ config, soroban, redisClient = null, version }, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.healthProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const required = await Promise.all([
    runProbe('storage', timeoutMs, () => checkStorage(config)),
    runProbe('rpc', timeoutMs, () => checkRpc(config)),
  ]);

  const failed = required.filter((dependency) => dependency.status === STATUS.DOWN);
  const checks = {};
  for (const { name, ...rest } of required) {
    checks[name] = rest;
  }

  return {
    ready: failed.length === 0,
    version,
    uptimeSeconds: uptimeSeconds(),
    timestamp: new Date().toISOString(),
    checks,
    ...(failed.length > 0 ? { failing: failed.map((dependency) => dependency.name) } : {}),
  };
}

export { STARTED_AT, DEFAULT_PROBE_TIMEOUT_MS };
