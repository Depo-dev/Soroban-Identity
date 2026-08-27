import { URL } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendAuditLog, readCredentials, writeCredentials, createAndPersistCredential, revokeAndPersistCredential, DuplicateCredentialError } from "./storage.js";
import { findExpiringCredentials, paginate, paginateCursor } from "./expiry.js";
import {
  createWebhookRecord,
  deleteWebhookRecord,
  getWebhookRecord,
  readWebhookLogs,
  readWebhooks,
  WebhookDeliveryService,
} from "./webhooks.js";
import { startAccessLog } from "./access-log.js";
import { createDataLoaders } from "./dataloader.js";
import { executeGraphQL, renderGraphiQLPlayground } from "./graphql.js";
import {
  resolveApiVersion,
  setVersionHeaders,
  SUPPORTED_VERSIONS,
  DEFAULT_VERSION,
  DEPRECATED_VERSIONS,
} from "./versioning.js";
import {
  notFound,
  readJson,
  requireAdmin,
  requireAuth,
  sendJson,
  sendText,
  setCorsHeaders,
  validateContentType,
} from "./http-utils.js";
import { schemas, validateRequest } from "./validation.js";
import { routeLabel } from "./route-label.js";
import { requestContextStore } from "./request-context.js";
import { handleEventsRequest } from "./sse.js";
import { logger } from "./logger.js";
import { TieredRateLimiter } from "./rate-limiter.js";
import { ApiKeyService } from "./api-keys.js";
const SERVER_VERSION = "0.1.0";
const MIN_SDK_VERSION = "0.1.0";
const SERVER_FEATURES = [
  "webhook_delivery",
  "batch_issuance",
  "event_polling",
  "graphql_api",
  "api_versioning",
];

export function createApp({ config, soroban, metrics, metricsAggregator, rateLimiter = null, webhookService = new WebhookDeliveryService(config) }) {
  // One limiter per app instance, so its buckets live as long as the server
  // rather than being rebuilt per request.
  const limiter =
    rateLimiter ??
    new TieredRateLimiter({
      whitelist: config.rateLimitWhitelist ?? [],
      trustProxy: config.trustProxy ?? false,
      maxBuckets: config.rateLimitMaxBuckets ?? 10000,
    });
export function createApp({ config, soroban, metrics, metricsAggregator, didCache = null, webhookService = new WebhookDeliveryService(config) }) {
export function createApp({
  config,
  soroban,
  metrics,
  metricsAggregator,
  webhookService = new WebhookDeliveryService(config),
  apiKeyService = new ApiKeyService(config),
  rateLimiter = new TieredRateLimiter(),
  realtime = null,
}) {
  // Expose the key service on config so http-utils.requireAuth can validate
  // issued API keys instead of falling back to the single admin key.
  config.apiKeyService = apiKeyService;

export function createApp({ config, soroban, metrics, metricsAggregator, redisClient = null, webhookService = new WebhookDeliveryService(config) }) {
export function createApp({ config, soroban, metrics, metricsAggregator, accessLogSink = null, webhookService = new WebhookDeliveryService(config) }) {
  return async function app(req, res) {
    const url = new URL(
      req.url,
      `http://${req.headers.host ?? "localhost"}`,
    );

    // Resolve API version and normalized pathname
    const { version, normalizedPath, isExplicitUrlVersion, isDeprecated } = resolveApiVersion(req, url);
    const pathname = normalizedPath;

    // Set API Version and Deprecation response headers
    setVersionHeaders(res, { version, isDeprecated, isExplicitUrlVersion });

    // Instrument the request for the Prometheus HTTP metrics. `res.once`
    // fires whether the handler returned a response, threw, or the client
    // disconnected, so in-flight can never leak.
    if (metrics?.observeHttpRequest) {
      const startedAt = process.hrtime.bigint();
      metrics.httpInFlight?.inc();
      res.once("close", () => {
        metrics.httpInFlight?.dec();
        metrics.observeHttpRequest({
          method: req.method,
          route: routeLabel(pathname),
          statusCode: res.statusCode,
          durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
        });
      });
    }

    // Check if this is the metrics endpoint before setting X-Request-ID
    const isMetricsEndpoint = req.method === "GET" && pathname === "/metrics";
    
    // Generate requestId for all endpoints except metrics
    const requestId = isMetricsEndpoint ? null : (req.headers["x-request-id"] || crypto.randomUUID());
    
    if (!isMetricsEndpoint) {
      res.setHeader("X-Request-ID", requestId);
    }

    // Access logging is attached before any routing so a request that is
    // rejected by CORS, auth, or the rate limiter is still recorded.
    if (config.accessLogEnabled && !isMetricsEndpoint) {
      const finishAccessLog = startAccessLog(req, res, {
        requestId,
        config,
        sink: accessLogSink,
      });
      res.on("finish", () => finishAccessLog({ requestBody: req.loggedBody ?? null }));
    }

    // Apply CORS headers
    if (setCorsHeaders(req, res, config)) {
      // Preflight OPTIONS request
      return res.writeHead(204).end();
    }

    // Validate well-known request headers before any routing or auth work.
    if (!validateRequest(res, schemas.commonHeaders, { headers: req.headers }).ok) {
      return;
    }

    // Extract tier and API key ID from API key or headers early if present
    const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
    if (authHeader) {
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
      try {
        const keyRecord = await apiKeyService.validateKey(token);
        if (keyRecord) {
          req.apiKeyId = keyRecord.id;
          req.userTier = keyRecord.tier || 'free';
          req.auth = { apiKey: keyRecord };
        } else {
          const parts = token.split(":");
          if (parts.length >= 2 && ["free", "pro", "enterprise"].includes(parts[1].toLowerCase())) {
            req.userTier = parts[1].toLowerCase();
          }
        }
      } catch {
        // fallback
      }
    }
    if (req.headers["x-user-tier"]) {
      req.userTier = req.headers["x-user-tier"].toLowerCase();
    }

    // Rate limiting check (exempt /info, /health, /metrics)
    const isExempt = ["/info", "/health", "/ready", "/live", "/metrics"].includes(url.pathname);
    if (!isExempt) {
      const rateResult = limiter.check(req, url.pathname);

      if (rateResult.whitelisted) {
        res.setHeader("X-RateLimit-Bypass", "whitelist");
      } else {
        // Report whichever budget is closest to exhaustion, so a client sees
        // the limit that will actually stop it first.
        const reported = rateResult.binding ?? rateResult;
        res.setHeader("X-RateLimit-Tier", String(rateResult.tier ?? reported.rule ?? "free"));
        res.setHeader("X-RateLimit-Limit", String(reported.limit));
        res.setHeader("X-RateLimit-Remaining", String(reported.remaining));
        res.setHeader("X-RateLimit-Reset", String(reported.resetAt));
        if (rateResult.scope === "endpoint" || rateResult.endpoint?.rule) {
          res.setHeader("X-RateLimit-Scope", rateResult.scope === "endpoint" ? "endpoint" : "tier");
        }
      }

      if (!rateResult.allowed) {
        res.setHeader("Retry-After", String(rateResult.retryAfter));

        // An endpoint denial is not a tier problem, so it must not be dressed
        // up as one — upgrading would not raise a per-endpoint limit.
        const isEndpointDenial = rateResult.scope === "endpoint";

        if (!isEndpointDenial && rateResult.tier === "free") {
          res.setHeader(
            "X-Upgrade-Available",
            "Upgrade to Pro or Enterprise for higher limits: https://soroban-identity.org/pricing"
          );
        }

        const windowMinutes = Math.round(
          ((rateResult.resetAt * 1000) - Date.now()) / 60000
        );

        return sendJson(res, 429, {
          error: "rate_limit_exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          scope: rateResult.scope,
          message: isEndpointDenial
            ? `Rate limit exceeded for '${rateResult.rule}' (${rateResult.limit} requests per window). Retry in ${rateResult.retryAfter}s.`
            : rateResult.tier === "free"
              ? `Free tier rate limit exceeded (${rateResult.limit} req/min). Upgrade to Pro (300 req/min) or Enterprise (1200 req/min) for higher limits.`
              : `Rate limit exceeded for tier '${rateResult.tier}' (${rateResult.limit} req/min).`,
          ...(isEndpointDenial ? { rule: rateResult.rule, windowMinutes } : { tier: rateResult.tier }),
          ...(!isEndpointDenial && rateResult.tier === "free"
            ? {
                upgrade: {
                  message: "Upgrade to Pro or Enterprise for increased rate limits.",
                  upgradeUrl: "https://soroban-identity.org/pricing",
                  availableTiers: ["pro", "enterprise"],
                },
              }
            : {}),
          limit: rateResult.limit,
          retryAfter: rateResult.retryAfter,
        });
      }
    }

    return requestContextStore.run({ requestId }, async () => {
      try {
        if (req.method === "GET" && pathname === "/info") {
          return sendJson(res, 200, {
            version: SERVER_VERSION,
            apiVersion: version,
            supportedVersions: SUPPORTED_VERSIONS,
            features: SERVER_FEATURES,
            minSdkVersion: MIN_SDK_VERSION,
          });
        }

        if (req.method === "GET" && pathname === "/health") {
          const health = await collectHealth({
            config,
            soroban,
            redisClient,
            version: SERVER_VERSION,
          });

          const contracts = health.dependencies.contracts?.contracts ?? {};
          // 200 while the service can still answer requests; 503 only when a
          // required dependency is down, so a partially-degraded deployment is
          // not pulled out of a load balancer.
          const statusCode = health.status === "unhealthy" ? 503 : 200;

          return sendJson(res, statusCode, {
            ...health,
            // Retained for existing consumers of this endpoint.
            apiVersion: version,
            supportedVersions: SUPPORTED_VERSIONS,
            deprecatedVersions: DEPRECATED_VERSIONS,
            defaultVersion: DEFAULT_VERSION,
            contracts,
            circuitBreaker: soroban.circuitBreaker.toHealthInfo(),
          });
        }

        if (req.method === "GET" && pathname === "/ready") {
          const readiness = await collectReadiness({
            config,
            soroban,
            redisClient,
            version: SERVER_VERSION,
          });
          return sendJson(res, readiness.ready ? 200 : 503, readiness);
        }

        if (req.method === "GET" && pathname === "/live") {
          // Liveness answers "is the process still running and able to respond"
          // and must never probe a dependency: a dependency outage should not
          // cause the orchestrator to restart an otherwise healthy process.
          return sendJson(res, 200, {
            status: "alive",
            version: SERVER_VERSION,
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
          });
        }

        if (req.method === "GET" && url.pathname === "/events") {
          return handleEventsRequest(req, res, url, { config, soroban });
        }

        if (req.method === "GET" && pathname === "/metrics") {
          if (metricsAggregator)
            await metricsAggregator
              .refresh()
              .catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Metrics refresh failed'));

          // Recompute the business gauges at scrape time so they reflect the
          // credential store as it is now, not as it was at the last write.
          if (metrics.updateBusinessMetrics) {
            try {
              metrics.updateBusinessMetrics(await readCredentials(config));
            } catch (error) {
              logger.error({ error: error.message }, 'Business metrics refresh failed');
            }
          }

          const body = await metrics.renderPrometheus();
          return sendText(res, 200, body, metrics.contentType ? { "content-type": metrics.contentType } : {});
        }

        // ── GraphQL Endpoint ─────────────────────────────────────────
        if (pathname === "/graphql") {
          if (req.method === "GET") {
            const queryParam = url.searchParams.get("query");
            if (!queryParam) {
              // Interactive GraphQL Playground in dev mode / browser requests
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              return res.end(renderGraphiQLPlayground());
            }
            let variables = {};
            try {
              const varsStr = url.searchParams.get("variables");
              if (varsStr) variables = JSON.parse(varsStr);
            } catch {
              return sendJson(res, 400, { errors: [{ message: "Invalid variables JSON." }] });
            }
            const loaders = createDataLoaders({ config, soroban });
            const result = await executeGraphQL({
              query: queryParam,
              variables,
              context: { config, soroban, metrics, webhookService, loaders, req, res },
            });
            return sendJson(res, result.errors ? 400 : 200, result);
          }

          if (req.method === "POST") {
            if (validateContentType(req, res)) return;
            const body = await readJson(req, config);
            if (body.__payloadTooLarge) {
              return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
            }
            const validated = validateRequest(res, schemas.graphql, { body });
            if (!validated.ok) return;
            const { query, variables = {}, operationName } = validated.data.body;

            // Mutations require credentials:write or admin authorization
            const isMutation = /^\s*mutation\b/i.test(query);
            if (isMutation) {
              if (!await requireAuth(req, res, config, ["credentials:write"])) return;
            }

            const loaders = createDataLoaders({ config, soroban });
            const result = await executeGraphQL({
              query,
              variables,
              operationName,
              context: { config, soroban, metrics, webhookService, loaders, req, res },
            });
            return sendJson(res, 200, result);
          }
        }


        // #390: paginated credential list
        if (req.method === "GET" && pathname === "/credentials") {
          const validated = validateRequest(res, schemas.listCredentials, {
            query: url.searchParams,
          });
          if (!validated.ok) return;
          const limitNum = validated.data.query.limit ?? 50;
          const credentials = await readCredentials(config);
          const { items, nextCursor } = paginateCursor(credentials, {
            limit: limitNum,
            cursor: validated.data.query.cursor ?? null,
          });
          if (version === "v2") {
            return sendJson(res, 200, {
              apiVersion: "v2",
              data: {
                items,
                pageInfo: {
                  nextCursor,
                  hasNextPage: Boolean(nextCursor),
                  count: items.length,
                },
              },
              meta: {
                timestamp: new Date().toISOString(),
              },
            });
          }
          return sendJson(res, 200, { items, nextCursor });
        }

        // Single-item GET /credentials/:id
        const credentialIdMatch = pathname.match(/^\/credentials\/([^/]+)$/);
        if (req.method === "GET" && credentialIdMatch) {
          const credentialId = decodeURIComponent(credentialIdMatch[1]);
          if (!validateRequest(res, schemas.credentialByIdParams, { params: { credentialId } }).ok) {
            return;
          }
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          if (!credential) return notFound(res);
          if (version === "v2") {
            return sendJson(res, 200, {
              apiVersion: "v2",
              data: credential,
            });
          }
          return sendJson(res, 200, credential);
        }

        const verifyMatch = pathname.match(/^\/credentials\/([^/]+)\/verify$/);
        if (req.method === "POST" && verifyMatch) {
          // Verify endpoint requires credentials:read scope
          if (!await requireAuth(req, res, config, ['credentials:read'])) return;
          
          const credentialId = decodeURIComponent(verifyMatch[1]);
          if (!validateRequest(res, schemas.credentialByIdParams, { params: { credentialId } }).ok) {
            return;
          }
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          const recordVerification = (result) =>
            metrics?.observeCredentialVerification?.(result);
          if (!credential) {
            recordVerification("not_found");
            return sendJson(res, 200, { verified: false, reason: "not_found" });
          }
          if (credential.revoked) {
            recordVerification("revoked");
            return sendJson(res, 200, { verified: false, reason: "revoked" });
          }
          const now = Math.floor(Date.now() / 1000);
          if (credential.expiresAt > 0 && credential.expiresAt < now) {
            recordVerification("expired");
            return sendJson(res, 200, { verified: false, reason: "expired" });
          }
          recordVerification("verified");
          return sendJson(res, 200, { verified: true, credential });
        }

        if (req.method === "GET" && pathname === "/openapi.json") {
          try {
            const openApiPath = path.resolve(process.cwd(), "openapi.json");
            const content = await fs.readFile(openApiPath, "utf8");
            return sendJson(res, 200, JSON.parse(content));
          } catch {
            try {
              const fallbackPath = path.resolve(process.cwd(), "server/openapi.json");
              const content = await fs.readFile(fallbackPath, "utf8");
              return sendJson(res, 200, JSON.parse(content));
            } catch (err) {
              return sendJson(res, 500, { error: "openapi_spec_unavailable", message: err.message });
            }
          }
        }

        if (
          pathname.startsWith("/admin/") &&
          !(await requireAdmin(req, res, config))
        )
          return;

        if (req.method === "POST" && (pathname === "/credentials" || pathname === "/credentials/issue")) {
          if (!await requireAuth(req, res, config, ['credentials:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          const validated = validateRequest(res, schemas.issueCredential, { body });
          if (!validated.ok) return;
          const credential = validated.data.body;
          try {
            await createAndPersistCredential(config, credential);
            await appendAuditLog(config, { action: "issue_credential", credentialId: credential.id });
            webhookService.trigger("credential.issued", credential).catch(() => {});
            realtime?.emitCredentialEvent("issued", credential);
            return sendJson(res, 201, credential);
          } catch (err) {
            if (err instanceof DuplicateCredentialError) {
              return sendJson(res, 409, {
                code: "CREDENTIAL_ALREADY_EXISTS",
                message: err.message,
                details: [{ field: "id", value: err.id }],
              });
            }
            throw err;
          }
        }

        // Credential revocation: DELETE /credentials/:id/revoke or POST /credentials/:id/revoke or DELETE /credentials/:id
        const revokeMatch = pathname.match(/^\/credentials\/([^/]+)(\/revoke)?$/);
        if ((req.method === "DELETE" || (req.method === "POST" && pathname.endsWith("/revoke"))) && revokeMatch) {
          if (!await requireAuth(req, res, config, ['credentials:write'])) return;
          const credentialId = decodeURIComponent(revokeMatch[1]);
          if (!validateRequest(res, schemas.credentialByIdParams, { params: { credentialId } }).ok) {
            return;
          }
          const revoked = await revokeAndPersistCredential(config, credentialId);
          if (!revoked) return notFound(res);
          await appendAuditLog(config, { action: "revoke_credential", credentialId });
          webhookService.trigger("credential.revoked", { id: credentialId, revokedAt: revoked.revokedAt }).catch(() => {});
          realtime?.emitCredentialEvent("revoked", revoked);
          return sendJson(res, 200, { revoked: true, credential: revoked });
        }

        // ── Webhook Endpoints ──────────────────────────────────────────
        if (req.method === "GET" && pathname === "/webhooks") {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const webhooks = await readWebhooks(config);
          return sendJson(res, 200, { webhooks });
        }

        if (req.method === "POST" && pathname === "/webhooks") {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          const validated = validateRequest(res, schemas.createWebhook, { body });
          if (!validated.ok) return;
          const webhook = await createWebhookRecord(config, validated.data.body);
          return sendJson(res, 201, webhook);
        }

        if (req.method === "GET" && pathname === "/webhooks/logs") {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const validated = validateRequest(res, schemas.webhookLogsQuery, { query: url.searchParams });
          if (!validated.ok) return;
          const limit = validated.data.query.limit ?? 50;
          const webhookId = validated.data.query.webhookId ?? null;
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        if (req.method === "GET" && pathname === "/notifications/logs") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
          if (limit > 200) {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "limit must not exceed 200" });
          }
          const logs = await readNotificationLog(config, {
            limit,
            credentialId: url.searchParams.get("credentialId") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
          });
          return sendJson(res, 200, { logs });
        }

        if (req.method === "GET" && pathname === "/cache/stats") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          return sendJson(res, 200, didCache ? didCache.getStats() : { enabled: false });
        }

        if (req.method === "DELETE" && pathname === "/cache/dids") {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          const cleared = didCache ? await didCache.invalidateAll() : 0;
          return sendJson(res, 200, { cleared });
        }

        const cacheDidMatch = pathname.match(/^\/cache\/dids\/([^/]+)$/);
        if (req.method === "DELETE" && cacheDidMatch) {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          const did = decodeURIComponent(cacheDidMatch[1]);
          const invalidated = didCache ? await didCache.invalidate(did) : false;
          return sendJson(res, 200, { did, invalidated });
        if (req.method === "GET" && pathname === "/notifications/summary") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const summary = await summarizeNotificationLog(config);
          return sendJson(res, 200, summary);
        }

        const webhookTestMatch = pathname.match(/^\/webhooks\/([^/]+)\/test$/);
        if (req.method === "POST" && (webhookTestMatch || pathname === "/webhooks/test")) {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          let webhook;
          if (webhookTestMatch) {
            const id = decodeURIComponent(webhookTestMatch[1]);
            webhook = await getWebhookRecord(config, id);
            if (!webhook) return notFound(res);
          } else {
            if (validateContentType(req, res)) return;
            const body = await readJson(req, config);
            const validated = validateRequest(res, schemas.testWebhook, { body });
            if (!validated.ok) return;
            webhook = {
              id: "whk_test",
              url: validated.data.body.url,
              secret: validated.data.body.secret || "test-secret",
              authToken: validated.data.body.authToken,
            };
          }
          const testResult = await webhookService.deliverTest(webhook);
          return sendJson(res, 200, testResult);
        }

        const webhookLogsMatch = pathname.match(/^\/webhooks\/([^/]+)\/logs$/);
        if (req.method === "GET" && webhookLogsMatch) {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const webhookId = decodeURIComponent(webhookLogsMatch[1]);
          const validated = validateRequest(res, schemas.webhookLogsQuery, { query: url.searchParams });
          if (!validated.ok) return;
          const limit = validated.data.query.limit ?? 50;
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        const webhookIdMatch = pathname.match(/^\/webhooks\/([^/]+)$/);
        if (req.method === "GET" && webhookIdMatch && pathname !== "/webhooks/logs") {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const id = decodeURIComponent(webhookIdMatch[1]);
          const webhook = await getWebhookRecord(config, id);
          if (!webhook) return notFound(res);
          return sendJson(res, 200, webhook);
        }

        if (req.method === "DELETE" && webhookIdMatch) {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          const id = decodeURIComponent(webhookIdMatch[1]);
          const deleted = await deleteWebhookRecord(config, id);
          if (!deleted) return notFound(res);
          return sendJson(res, 200, { success: true, id });
        }

        if (req.method === "GET" && pathname === "/admin/issuers") {
          // Reading issuers requires admin:read or wildcard scope
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          
          const issuers = await soroban.getIssuers();
          return sendJson(res, 200, { issuers });
        }

        if (req.method === "POST" && pathname === "/admin/issuers") {
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { error: "payload_too_large" });
          const validated = validateRequest(res, schemas.addIssuer, { body });
          if (!validated.ok) return;
          const { issuer } = validated.data.body;
          await soroban.addIssuer(issuer);
          realtime?.emitDidEvent("issuer_added", issuer, { subject: issuer });
          await appendAuditLog(config, {
            action: "add_issuer",
            actor: req.headers["x-actor"] ?? config.adminActor,
            issuer,
          });
          return sendJson(res, 201, { issuer });
        }

        if (req.method === "DELETE" && pathname === "/admin/issuers") {
          // Removing issuers requires admin:write scope
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { error: "payload_too_large" });
          const validated = validateRequest(res, schemas.removeIssuer, {
            body,
            query: url.searchParams,
          });
          if (!validated.ok) return;
          const issuer = validated.data.body.issuer ?? validated.data.query.issuer;
          if (!issuer) {
            return sendJson(res, 400, {
              error: "validation_failed",
              code: "VALIDATION_FAILED",
              message: "Request validation failed.",
              errors: [
                {
                  field: "issuer",
                  source: "body",
                  message: "issuer is required in the request body or as a query parameter",
                  code: "required",
                },
              ],
            });
          }
          await soroban.removeIssuer(issuer);
          realtime?.emitDidEvent("issuer_removed", issuer, { subject: issuer });
          await appendAuditLog(config, {
            action: "remove_issuer",
            actor: req.headers["x-actor"] ?? config.adminActor,
            issuer,
          });
          return sendJson(res, 200, { issuer });
        }

        if (req.method === "GET" && pathname === "/admin/expiry-report") {
          // Reading expiry reports requires admin:read scope
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          
          const validated = validateRequest(res, schemas.expiryReportQuery, {
            query: url.searchParams,
          });
          if (!validated.ok) return;
          const windowDays = validated.data.query.windowDays ?? config.expiryWarningDays;
          const credentials = await readCredentials(config);
          const expiring = findExpiringCredentials(credentials, {
            windowDays,
            includeNotified: true,
          });
          return sendJson(
            res,
            200,
            paginate(expiring, {
              page: validated.data.query.page ?? null,
              pageSize: validated.data.query.pageSize ?? null,
            }),
          );
        }

        if (req.method === "GET" && (url.pathname === "/admin/expiry-thresholds" || url.pathname === "/expiry/thresholds")) {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          return sendJson(res, 200, {
            thresholds: config.expiryReminderThresholds ?? [30, 7, 1],
            warningDays: config.expiryWarningDays ?? 7,
          });
        }

        if (req.method === "POST" && (url.pathname === "/admin/expiry-thresholds" || url.pathname === "/expiry/thresholds")) {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge) {
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          }
          const validated = validateRequest(res, schemas.expiryThresholds, { body });
          if (!validated.ok) return;
          const validThresholds = [...validated.data.body.thresholds].sort((a, b) => b - a);

          config.expiryReminderThresholds = validThresholds;
          await appendAuditLog(config, {
            action: "update_expiry_thresholds",
            thresholds: validThresholds,
          });

          return sendJson(res, 200, {
            success: true,
            thresholds: validThresholds,
          });
        }

        // #679: API Key Management Endpoints
        if (req.method === "POST" && url.pathname === "/admin/api-keys") {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge) {
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          }

          const validated = validateRequest(res, schemas.createApiKey, { body });
          if (!validated.ok) return;
          const keyInput = validated.data.body;
          const issued = await apiKeyService.issueKey({
            name: keyInput.name ?? "default",
            owner: keyInput.owner ?? (req.headers["x-actor"] || config.adminActor),
            scopes: keyInput.scopes ?? ["credentials:read"],
            tier: keyInput.tier ?? "free",
            expiresInDays: keyInput.expiresInDays ?? null,
          });

          await appendAuditLog(config, {
            action: "issue_api_key",
            actor: req.headers["x-actor"] ?? config.adminActor,
            keyId: issued.id,
            owner: issued.owner,
            scopes: issued.scopes,
            tier: issued.tier,
          });

          return sendJson(res, 201, issued);
        }

        if (req.method === "GET" && url.pathname === "/admin/api-keys") {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const keys = await apiKeyService.listKeys();
          return sendJson(res, 200, { keys });
        }

        const apiKeyIdMatch = url.pathname.match(/^\/admin\/api-keys\/([^/]+)$/);
        if (req.method === "GET" && apiKeyIdMatch) {
          if (!await requireAuth(req, res, config, ['admin:read'])) return;
          const id = decodeURIComponent(apiKeyIdMatch[1]);
          const keyMeta = await apiKeyService.getKey(id);
          if (!keyMeta) return notFound(res);
          return sendJson(res, 200, keyMeta);
        }

        if (req.method === "DELETE" && apiKeyIdMatch) {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          const id = decodeURIComponent(apiKeyIdMatch[1]);
          const revoked = await apiKeyService.revokeKey(id);
          if (!revoked) return notFound(res);
          await appendAuditLog(config, {
            action: "revoke_api_key",
            actor: req.headers["x-actor"] ?? config.adminActor,
            keyId: id,
          });
          return sendJson(res, 200, { success: true, id, status: "revoked" });
        }

        const apiKeyRotateMatch = url.pathname.match(/^\/admin\/api-keys\/([^/]+)\/rotate$/);
        if (req.method === "POST" && apiKeyRotateMatch) {
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          const id = decodeURIComponent(apiKeyRotateMatch[1]);
          const body = await readJson(req, config);
          const validated = validateRequest(res, schemas.rotateApiKey, { body });
          if (!validated.ok) return;
          const rotated = await apiKeyService.rotateKey(id, {
            expiresInDays: validated.data.body.expiresInDays ?? null,
          });
          if (!rotated) return notFound(res);
          await appendAuditLog(config, {
            action: "rotate_api_key",
            actor: req.headers["x-actor"] ?? config.adminActor,
            keyId: id,
          });
          return sendJson(res, 200, rotated);
        }

        return notFound(res);
      } catch (error) {
        if (error.name === "SorobanError") {
          logger.error({ 
            error: error.category, 
            message: error.publicMessage,
            internalDetail: error.internalDetail 
          }, 'Soroban error occurred');
          return sendJson(res, 500, {
            error: error.category,
            message: error.publicMessage,
          });
        }
        logger.error({ error: error.message, stack: error.stack }, 'Internal server error');
        return sendJson(res, 500, {
          error: "internal_server_error",
          message: error.message,
        });
      }
    });
  };
}
