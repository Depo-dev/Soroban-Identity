import { URL } from "node:url";
import crypto from "node:crypto";
import { appendAuditLog, readCredentials, writeCredentials, createAndPersistCredential, DuplicateCredentialError } from "./storage.js";
import { findExpiringCredentials, paginate, paginateCursor } from "./expiry.js";
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
import { TieredRateLimiter } from "./rate-limiter.js";
const SERVER_VERSION = "0.1.0";
const MIN_SDK_VERSION = "0.1.0";
const SERVER_FEATURES = ["webhook_delivery", "batch_issuance", "event_polling", "tiered_rate_limiting"];

export function createApp({ config, soroban, metrics, metricsAggregator, rateLimiter = new TieredRateLimiter() }) {
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

    // Extract tier from API key or headers early if present
    const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
    if (authHeader) {
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
      const parts = token.split(":");
      if (parts.length >= 2 && ["free", "pro", "enterprise"].includes(parts[1].toLowerCase())) {
        req.userTier = parts[1].toLowerCase();
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

        // #678: Bulk credential verification endpoint
        if (req.method === "POST" && url.pathname === "/credentials/verify/batch") {
          if (!requireAuth(req, res, config, ['credentials:read'])) return;
          if (validateContentType(req, res)) return;

          const body = await readJson(req, config);
          if (body.__payloadTooLarge) {
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          }

          const ids = Array.isArray(body) ? body : (body.ids ?? body.credentialIds);
          if (!Array.isArray(ids) || ids.length === 0) {
            return sendJson(res, 400, {
              code: "INVALID_REQUEST",
              message: "Request body must include an array of credential IDs.",
            });
          }

          if (ids.length > 50) {
            return sendJson(res, 400, {
              code: "INVALID_REQUEST",
              message: "Batch size exceeds limit of 50 credentials per request.",
            });
          }

          const credentials = await readCredentials(config);
          const credMap = new Map(credentials.map((c) => [c.id, c]));
          const now = Math.floor(Date.now() / 1000);

          const results = ids.map((id) => {
            if (typeof id !== "string" || !id.trim()) {
              return { id, verified: false, reason: "invalid_id" };
            }
            const credential = credMap.get(id);
            if (!credential) {
              return { id, verified: false, reason: "not_found" };
            }
            if (credential.revoked) {
              return { id, verified: false, reason: "revoked" };
            }
            if (credential.expiresAt > 0 && credential.expiresAt < now) {
              return { id, verified: false, reason: "expired" };
            }
            return { id, verified: true, credential };
          });

          return sendJson(res, 200, {
            results,
            total: results.length,
            verifiedCount: results.filter((r) => r.verified).length,
          });
        }

        const snoozeMatch = url.pathname.match(/^\/credentials\/([^/]+)\/(?:expiry-reminder\/)?snooze$/);
        if (req.method === "POST" && snoozeMatch) {
          if (!requireAuth(req, res, config, ['credentials:write'])) return;
          if (validateContentType(req, res)) return;

          const credentialId = decodeURIComponent(snoozeMatch[1]);
          const body = await readJson(req, config);
          if (body.__payloadTooLarge) {
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          }

          const credentials = await readCredentials(config);
          const index = credentials.findIndex((c) => c.id === credentialId);
          if (index === -1) return notFound(res);

          const days = Number(body.days ?? body.snoozeDays ?? 7);
          const untilMs = body.until ? new Date(body.until).getTime() : Date.now() + days * 24 * 60 * 60 * 1000;

          credentials[index] = {
            ...credentials[index],
            snoozed_until: untilMs,
          };
          await writeCredentials(config, credentials);
          await appendAuditLog(config, {
            action: "snooze_expiry_reminder",
            credentialId,
            snoozedUntil: new Date(untilMs).toISOString(),
          });

          return sendJson(res, 200, {
            success: true,
            credentialId,
            snoozedUntil: new Date(untilMs).toISOString(),
          });
        }

        const dismissMatch = url.pathname.match(/^\/credentials\/([^/]+)\/(?:expiry-reminder\/)?dismiss$/);
        if (req.method === "POST" && dismissMatch) {
          if (!requireAuth(req, res, config, ['credentials:write'])) return;

          const credentialId = decodeURIComponent(dismissMatch[1]);
          const credentials = await readCredentials(config);
          const index = credentials.findIndex((c) => c.id === credentialId);
          if (index === -1) return notFound(res);

          credentials[index] = {
            ...credentials[index],
            expiry_dismissed: true,
          };
          await writeCredentials(config, credentials);
          await appendAuditLog(config, {
            action: "dismiss_expiry_reminder",
            credentialId,
          });

          return sendJson(res, 200, {
            success: true,
            credentialId,
            dismissed: true,
          });
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

        if (req.method === "GET" && (url.pathname === "/admin/expiry-thresholds" || url.pathname === "/expiry/thresholds")) {
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          return sendJson(res, 200, {
            thresholds: config.expiryReminderThresholds ?? [30, 7, 1],
            warningDays: config.expiryWarningDays ?? 7,
          });
        }

        if (req.method === "POST" && (url.pathname === "/admin/expiry-thresholds" || url.pathname === "/expiry/thresholds")) {
          if (!requireAuth(req, res, config, ['admin:write'])) return;
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
