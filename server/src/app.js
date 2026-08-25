import { URL } from "node:url";
import crypto from "node:crypto";
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
import { logger } from "./logger.js";
const SERVER_VERSION = "0.1.0";
const MIN_SDK_VERSION = "0.1.0";
const SERVER_FEATURES = ["webhook_delivery", "batch_issuance", "event_polling"];

export function createApp({ config, soroban, metrics, metricsAggregator, webhookService = new WebhookDeliveryService(config) }) {
  return function app(req, res) {
    const url = new URL(
      req.url,
      `http://${req.headers.host ?? "localhost"}`,
    );

    // Check if this is the metrics endpoint before setting X-Request-ID
    const isMetricsEndpoint = req.method === "GET" && url.pathname === "/metrics";
    
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

    return requestContextStore.run({ requestId }, async () => {
      try {
        if (req.method === "GET" && url.pathname === "/info") {
          return sendJson(res, 200, {
            version: SERVER_VERSION,
            features: SERVER_FEATURES,
            minSdkVersion: MIN_SDK_VERSION,
          });
        }

        if (req.method === "GET" && url.pathname === "/health") {
          const contracts = await soroban.pingAllContracts();
          const ok = Object.values(contracts).every(Boolean);
          return sendJson(res, ok ? 200 : 503, {
            status: ok ? "ok" : "degraded",
            contracts,
            circuitBreaker: soroban.circuitBreaker.toHealthInfo(),
          });
        }

        if (req.method === "GET" && url.pathname === "/metrics") {
          if (metricsAggregator)
            await metricsAggregator
              .refresh()
              .catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Metrics refresh failed'));
          return sendText(res, 200, metrics.renderPrometheus());
        }

        // ── GraphQL Endpoint ─────────────────────────────────────────
        if (url.pathname === "/graphql") {
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
        if (req.method === "GET" && url.pathname === "/credentials") {
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
          return sendJson(res, 200, { items, nextCursor });
        }

        // Single-item GET /credentials/:id
        const credentialIdMatch = url.pathname.match(/^\/credentials\/([^/]+)$/);
        if (req.method === "GET" && credentialIdMatch) {
          const credentialId = decodeURIComponent(credentialIdMatch[1]);
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          if (!credential) return notFound(res);
          return sendJson(res, 200, credential);
        }

        const verifyMatch = url.pathname.match(/^\/credentials\/([^/]+)\/verify$/);
        if (req.method === "POST" && verifyMatch) {
          // Verify endpoint requires credentials:read scope
          if (!requireAuth(req, res, config, ['credentials:read'])) return;
          
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

        if (
          url.pathname.startsWith("/admin/") &&
          !requireAdmin(req, res, config)
        )
          return;

        if (req.method === "POST" && url.pathname === "/credentials") {
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
        const revokeMatch = url.pathname.match(/^\/credentials\/([^/]+)(\/revoke)?$/);
        if ((req.method === "DELETE" || (req.method === "POST" && url.pathname.endsWith("/revoke"))) && revokeMatch) {
          if (!requireAuth(req, res, config, ['credentials:write'])) return;
          const credentialId = decodeURIComponent(revokeMatch[1]);
          const revoked = await revokeAndPersistCredential(config, credentialId);
          if (!revoked) return notFound(res);
          await appendAuditLog(config, { action: "revoke_credential", credentialId });
          webhookService.trigger("credential.revoked", { id: credentialId, revokedAt: revoked.revokedAt }).catch(() => {});
          return sendJson(res, 200, { revoked: true, credential: revoked });
        }

        // ── Webhook Endpoints ──────────────────────────────────────────
        if (req.method === "GET" && url.pathname === "/webhooks") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const webhooks = await readWebhooks(config);
          return sendJson(res, 200, { webhooks });
        }

        if (req.method === "POST" && url.pathname === "/webhooks") {
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

        if (req.method === "GET" && url.pathname === "/webhooks/logs") {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
          const webhookId = url.searchParams.get("webhookId");
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        const webhookTestMatch = url.pathname.match(/^\/webhooks\/([^/]+)\/test$/);
        if (req.method === "POST" && (webhookTestMatch || url.pathname === "/webhooks/test")) {
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

        const webhookLogsMatch = url.pathname.match(/^\/webhooks\/([^/]+)\/logs$/);
        if (req.method === "GET" && webhookLogsMatch) {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          const webhookId = decodeURIComponent(webhookLogsMatch[1]);
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
          const logs = await readWebhookLogs(config, { webhookId, limit });
          return sendJson(res, 200, { logs });
        }

        const webhookIdMatch = url.pathname.match(/^\/webhooks\/([^/]+)$/);
        if (req.method === "GET" && webhookIdMatch && url.pathname !== "/webhooks/logs") {
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

        if (req.method === "GET" && url.pathname === "/admin/issuers") {
          // Reading issuers requires admin:read or wildcard scope
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          
          const issuers = await soroban.getIssuers();
          return sendJson(res, 200, { issuers });
        }

        if (req.method === "POST" && url.pathname === "/admin/issuers") {
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

        if (req.method === "DELETE" && url.pathname === "/admin/issuers") {
          // Removing issuers requires admin:write scope
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          
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

        if (req.method === "GET" && url.pathname === "/admin/expiry-report") {
          // Reading expiry reports requires admin:read scope
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          
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
