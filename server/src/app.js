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

export function createApp({ config, soroban, metrics, metricsAggregator, webhookService = new WebhookDeliveryService(config) }) {
  return function app(req, res) {
    const url = new URL(
      req.url,
      `http://${req.headers.host ?? "localhost"}`,
    );

    // Resolve API version and normalized pathname
    const { version, normalizedPath, isExplicitUrlVersion, isDeprecated } = resolveApiVersion(req, url);
    const pathname = normalizedPath;

    // Set API Version and Deprecation response headers
    setVersionHeaders(res, { version, isDeprecated, isExplicitUrlVersion });

    // Check if this is the metrics endpoint before setting X-Request-ID
    const isMetricsEndpoint = req.method === "GET" && pathname === "/metrics";
    
    // Generate requestId for all endpoints except metrics
    const requestId = isMetricsEndpoint ? null : (req.headers["x-request-id"] || crypto.randomUUID());
    
    if (!isMetricsEndpoint) {
      res.setHeader("X-Request-ID", requestId);
    }

    // Apply CORS headers
    if (setCorsHeaders(req, res, config)) {
      // Preflight OPTIONS request
      return res.writeHead(204).end();
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
    const isExempt = ["/info", "/health", "/metrics"].includes(url.pathname);
    if (!isExempt) {
      const rateResult = rateLimiter.consume(req);
      res.setHeader("X-RateLimit-Tier", rateResult.tier);
      res.setHeader("X-RateLimit-Limit", String(rateResult.limit));
      res.setHeader("X-RateLimit-Remaining", String(rateResult.remaining));
      res.setHeader("X-RateLimit-Reset", String(rateResult.resetAt));

      if (!rateResult.allowed) {
        res.setHeader("Retry-After", String(rateResult.retryAfter));
        if (rateResult.tier === "free") {
          res.setHeader(
            "X-Upgrade-Available",
            "Upgrade to Pro or Enterprise for higher limits: https://soroban-identity.org/pricing"
          );
        }
        return sendJson(res, 429, {
          error: "rate_limit_exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          message: rateResult.tier === "free"
            ? `Free tier rate limit exceeded (${rateResult.limit} req/min). Upgrade to Pro (300 req/min) or Enterprise (1200 req/min) for higher limits.`
            : `Rate limit exceeded for tier '${rateResult.tier}' (${rateResult.limit} req/min).`,
          tier: rateResult.tier,
          ...(rateResult.tier === "free"
            ? {
                upgrade: {
                  message: "Upgrade to Pro or Enterprise for increased rate limits.",
                  upgradeUrl: "https://soroban-identity.org/pricing",
                  availableTiers: ["pro", "enterprise"],
                },
              }
            : {}),
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
          const contracts = await soroban.pingAllContracts();
          const ok = Object.values(contracts).every(Boolean);
          return sendJson(res, ok ? 200 : 503, {
            status: ok ? "ok" : "degraded",
            apiVersion: version,
            supportedVersions: SUPPORTED_VERSIONS,
            deprecatedVersions: DEPRECATED_VERSIONS,
            defaultVersion: DEFAULT_VERSION,
            contracts,
            circuitBreaker: soroban.circuitBreaker.toHealthInfo(),
          });
        }

        if (req.method === "GET" && url.pathname === "/events") {
          return handleEventsRequest(req, res, url, { config, soroban });
        }

        if (req.method === "GET" && url.pathname === "/metrics") {
        if (req.method === "GET" && pathname === "/metrics") {
          if (metricsAggregator)
            await metricsAggregator
              .refresh()
              .catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Metrics refresh failed'));
          return sendText(res, 200, metrics.renderPrometheus());
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
            const { query, variables = {}, operationName } = body;
            if (!query) {
              return sendJson(res, 400, { errors: [{ message: "Must provide a GraphQL query." }] });
            }

            // Mutations require credentials:write or admin authorization
            const isMutation = /^\s*mutation\b/i.test(query);
            if (isMutation) {
              if (!requireAuth(req, res, config, ["credentials:write"])) return;
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
          const limitParam = url.searchParams.get("limit") ?? "50";
          const limitNum = Number.parseInt(limitParam, 10) || 50;
          if (limitNum > 200) {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "limit must not exceed 200" });
          }
          const credentials = await readCredentials(config);
          const { items, nextCursor } = paginateCursor(credentials, {
            limit: limitNum,
            cursor: url.searchParams.get("cursor"),
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
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          if (!credential) {
            return sendJson(res, 200, { verified: false, reason: "not_found" });
          }
          if (credential.revoked) {
            return sendJson(res, 200, { verified: false, reason: "revoked" });
          }
          const now = Math.floor(Date.now() / 1000);
          if (credential.expiresAt > 0 && credential.expiresAt < now) {
            return sendJson(res, 200, { verified: false, reason: "expired" });
          }
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
          !requireAdmin(req, res, config)
        )
          return;

        if (req.method === "POST" && (pathname === "/credentials" || pathname === "/credentials/issue")) {
          if (!requireAuth(req, res, config, ['credentials:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          if (!body.id)
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "Request body must include a credential id." });
          try {
            const updated = await createAndPersistCredential(config, body);
            await appendAuditLog(config, { action: "issue_credential", credentialId: body.id });
            webhookService.trigger("credential.issued", body).catch(() => {});
            return sendJson(res, 201, body);
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
          if (!requireAuth(req, res, config, ['credentials:write'])) return;
          const credentialId = decodeURIComponent(revokeMatch[1]);
          const revoked = await revokeAndPersistCredential(config, credentialId);
          if (!revoked) return notFound(res);
          await appendAuditLog(config, { action: "revoke_credential", credentialId });
          webhookService.trigger("credential.revoked", { id: credentialId, revokedAt: revoked.revokedAt }).catch(() => {});
          return sendJson(res, 200, { revoked: true, credential: revoked });
        }

        // ── Webhook Endpoints ──────────────────────────────────────────
        if (req.method === "GET" && pathname === "/webhooks") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const webhooks = await readWebhooks(config);
          return sendJson(res, 200, { webhooks });
        }

        if (req.method === "POST" && pathname === "/webhooks") {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          if (!body.url)
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "Webhook url is required." });
          try {
            new URL(body.url);
          } catch {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "Invalid webhook url." });
          }
          const webhook = await createWebhookRecord(config, body);
          return sendJson(res, 201, webhook);
        }

        if (req.method === "GET" && pathname === "/webhooks/logs") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
          const webhookId = url.searchParams.get("webhookId");
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        const webhookTestMatch = pathname.match(/^\/webhooks\/([^/]+)\/test$/);
        if (req.method === "POST" && (webhookTestMatch || pathname === "/webhooks/test")) {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          let webhook;
          if (webhookTestMatch) {
            const id = decodeURIComponent(webhookTestMatch[1]);
            webhook = await getWebhookRecord(config, id);
            if (!webhook) return notFound(res);
          } else {
            if (validateContentType(req, res)) return;
            const body = await readJson(req, config);
            if (!body.url) return sendJson(res, 400, { code: "INVALID_REQUEST", message: "Webhook url is required for test." });
            webhook = {
              id: "whk_test",
              url: body.url,
              secret: body.secret || "test-secret",
              authToken: body.authToken,
            };
          }
          const testResult = await webhookService.deliverTest(webhook);
          return sendJson(res, 200, testResult);
        }

        const webhookLogsMatch = pathname.match(/^\/webhooks\/([^/]+)\/logs$/);
        if (req.method === "GET" && webhookLogsMatch) {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const webhookId = decodeURIComponent(webhookLogsMatch[1]);
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        const webhookIdMatch = pathname.match(/^\/webhooks\/([^/]+)$/);
        if (req.method === "GET" && webhookIdMatch && pathname !== "/webhooks/logs") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const id = decodeURIComponent(webhookIdMatch[1]);
          const webhook = await getWebhookRecord(config, id);
          if (!webhook) return notFound(res);
          return sendJson(res, 200, webhook);
        }

        if (req.method === "DELETE" && webhookIdMatch) {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
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
          if (!body.issuer)
            return sendJson(res, 400, { error: "issuer_required" });
          await soroban.addIssuer(body.issuer);
          await appendAuditLog(config, {
            action: "add_issuer",
            actor: req.headers["x-actor"] ?? config.adminActor,
            issuer: body.issuer,
          });
          return sendJson(res, 201, { issuer: body.issuer });
        }

        if (req.method === "DELETE" && pathname === "/admin/issuers") {
          // Removing issuers requires admin:write scope
          if (!await requireAuth(req, res, config, ['admin:write'])) return;
          
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { error: "payload_too_large" });
          const issuer = body.issuer ?? url.searchParams.get("issuer");
          if (!issuer) return sendJson(res, 400, { error: "issuer_required" });
          await soroban.removeIssuer(issuer);
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
          
          const windowDays =
            Number.parseInt(url.searchParams.get("windowDays") ?? "", 10) ||
            config.expiryWarningDays;
          const credentials = await readCredentials(config);
          const expiring = findExpiringCredentials(credentials, {
            windowDays,
            includeNotified: true,
          });
          return sendJson(
            res,
            200,
            paginate(expiring, {
              page: url.searchParams.get("page"),
              pageSize: url.searchParams.get("pageSize"),
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
          if (!Array.isArray(body.thresholds)) {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "thresholds must be an array of positive integers (days)." });
          }
          const validThresholds = body.thresholds
            .map((n) => Number.parseInt(n, 10))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => b - a);

          if (validThresholds.length === 0) {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "thresholds must contain at least one positive integer." });
          }

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

          const issued = await apiKeyService.issueKey({
            name: body.name ?? "default",
            owner: body.owner ?? (req.headers["x-actor"] || config.adminActor),
            scopes: body.scopes ?? ["credentials:read"],
            tier: body.tier ?? "free",
            expiresInDays: body.expiresInDays ? Number(body.expiresInDays) : null,
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
          const rotated = await apiKeyService.rotateKey(id, {
            expiresInDays: body.expiresInDays ? Number(body.expiresInDays) : null,
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
