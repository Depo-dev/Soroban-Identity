import { logger } from './logger.js';

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

const MONTH_ALIASES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_ALIASES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function resolveAlias(token, fieldName) {
  const lower = String(token).toLowerCase();
  if (fieldName === 'month' && lower in MONTH_ALIASES) return MONTH_ALIASES[lower];
  if (fieldName === 'dayOfWeek' && lower in DAY_ALIASES) return DAY_ALIASES[lower];
  const parsed = Number.parseInt(token, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid cron value "${token}" in ${fieldName} field`);
  return parsed;
}

function parseField(raw, { name, min, max }) {
  const allowed = new Set();

  for (const part of String(raw).split(',')) {
    const [rangePart, stepPart = '1'] = part.split('/');
    const step = Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`Invalid cron step "${stepPart}" in ${name} field`);
    }

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [lo, hi] = rangePart.split('-');
      start = resolveAlias(lo, name);
      end = resolveAlias(hi, name);
    } else {
      start = resolveAlias(rangePart, name);
      end = stepPart === '1' && !part.includes('/') ? start : max;
    }

    // Standard cron accepts 7 as an alias for Sunday, so the day-of-week field
    // validates against 0-7 and normalises 7 to 0 when filling the set.
    const validationMax = name === 'dayOfWeek' ? 7 : max;
    if (start < min || end > validationMax || start > end) {
      throw new Error(`Cron ${name} field out of range: "${part}" (expected ${min}-${max})`);
    }

    for (let value = start; value <= end; value += step) {
      // Sunday is expressible as both 0 and 7 in standard cron.
      allowed.add(name === 'dayOfWeek' && value === 7 ? 0 : value);
    }
  }

  return allowed;
}

/**
 * Parse a standard 5-field cron expression into per-field allowed-value sets.
 *
 * Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*∕15`, `1-20/2`), and
 * the usual three-letter month/day aliases.
 *
 * @param {string} expression - e.g. "0 9 * * *"
 * @returns {{minute:Set<number>,hour:Set<number>,dayOfMonth:Set<number>,month:Set<number>,dayOfWeek:Set<number>}}
 */
export function parseCronExpression(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, received ${fields.length}: "${expression}"`);
  }
  const parsed = {};
  for (let i = 0; i < FIELD_RANGES.length; i += 1) {
    parsed[FIELD_RANGES[i].name] = parseField(fields[i], FIELD_RANGES[i]);
  }
  return parsed;
}

/**
 * Test whether a date satisfies a parsed cron schedule.
 *
 * Follows the standard cron rule: when both day-of-month and day-of-week are
 * restricted, the schedule matches if *either* one matches.
 */
export function cronMatches(parsed, date) {
  const domRestricted = parsed.dayOfMonth.size !== 31;
  const dowRestricted = parsed.dayOfWeek.size !== 7;

  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());

  const dayMatch = domRestricted && dowRestricted
    ? domMatch || dowMatch
    : domMatch && dowMatch;

  return (
    parsed.minute.has(date.getMinutes()) &&
    parsed.hour.has(date.getHours()) &&
    parsed.month.has(date.getMonth() + 1) &&
    dayMatch
  );
}

/**
 * Compute the next date at or after `from` (exclusive) matching the schedule.
 * Returns null when no match exists within the 4-year search horizon.
 */
export function nextRunAt(parsed, from = new Date()) {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // 4 years of minutes covers every leap-year-dependent schedule.
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i += 1) {
    if (cronMatches(parsed, cursor)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * Minimal cron scheduler backed by `setTimeout`.
 *
 * Each tick re-computes the next matching minute rather than relying on a
 * fixed interval, so the schedule stays aligned across DST shifts and event
 * loop delays.
 */
export class CronJob {
  constructor(expression, task, { name = 'cron', onError = null } = {}) {
    this.expression = expression;
    this.parsed = parseCronExpression(expression);
    this.task = task;
    this.name = name;
    this.onError = onError;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.schedule();
    logger.info({ job: this.name, expression: this.expression }, 'Cron job scheduled');
  }

  schedule() {
    const next = nextRunAt(this.parsed);
    if (!next) {
      logger.warn({ job: this.name, expression: this.expression }, 'Cron expression never matches; job not scheduled');
      return;
    }
    const delay = Math.max(0, next.getTime() - Date.now());
    this.nextRun = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async run() {
    // Skip overlapping executions rather than queueing them up.
    if (this.running) {
      logger.warn({ job: this.name }, 'Previous cron run still in progress; skipping tick');
      this.schedule();
      return;
    }
    this.running = true;
    try {
      await this.task();
    } catch (error) {
      logger.error({ job: this.name, error: error.message, stack: error.stack }, 'Cron job failed');
      if (this.onError) this.onError(error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRun = null;
  }
}
