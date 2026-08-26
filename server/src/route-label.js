/**
 * Route labelling for HTTP metrics (#649).
 *
 * Prometheus labels must have bounded cardinality, so a raw request path is
 * never used as a label value — `/credentials/abc123` and `/credentials/def456`
 * would otherwise create a new time series per credential. Each request is
 * mapped to the route *pattern* it matched instead.
 */

/** Ordered longest-prefix-first so `/webhooks/logs` wins over `/webhooks/:id`. */
const ROUTE_PATTERNS = [
  [/^\/info$/, '/info'],
  [/^\/health$/, '/health'],
  [/^\/metrics$/, '/metrics'],
  [/^\/events$/, '/events'],
  [/^\/graphql$/, '/graphql'],
  [/^\/openapi\.json$/, '/openapi.json'],
  [/^\/credentials$/, '/credentials'],
  [/^\/credentials\/issue$/, '/credentials/issue'],
  [/^\/credentials\/[^/]+\/verify$/, '/credentials/:id/verify'],
  [/^\/credentials\/[^/]+\/revoke$/, '/credentials/:id/revoke'],
  [/^\/credentials\/[^/]+$/, '/credentials/:id'],
  [/^\/webhooks$/, '/webhooks'],
  [/^\/webhooks\/logs$/, '/webhooks/logs'],
  [/^\/webhooks\/test$/, '/webhooks/test'],
  [/^\/webhooks\/[^/]+\/test$/, '/webhooks/:id/test'],
  [/^\/webhooks\/[^/]+\/logs$/, '/webhooks/:id/logs'],
  [/^\/webhooks\/[^/]+$/, '/webhooks/:id'],
  [/^\/admin\/issuers$/, '/admin/issuers'],
  [/^\/admin\/expiry-report$/, '/admin/expiry-report'],
  [/^\/admin\/expiry-thresholds$/, '/admin/expiry-thresholds'],
  [/^\/expiry\/thresholds$/, '/expiry/thresholds'],
  [/^\/admin\/api-keys$/, '/admin/api-keys'],
  [/^\/admin\/api-keys\/[^/]+\/rotate$/, '/admin/api-keys/:id/rotate'],
  [/^\/admin\/api-keys\/[^/]+$/, '/admin/api-keys/:id'],
];

/**
 * Map a request pathname to a bounded route label.
 *
 * Unknown paths collapse to the single `unmatched` label so a scanner probing
 * random URLs cannot inflate the number of series.
 *
 * @param {string} pathname - Version-normalized pathname
 * @returns {string}
 */
export function routeLabel(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return 'unmatched';
  for (const [pattern, label] of ROUTE_PATTERNS) {
    if (pattern.test(pathname)) return label;
  }
  return 'unmatched';
}
