import { createDataLoaders } from './dataloader.js';
import {
  readCredentials,
  createAndPersistCredential,
  revokeAndPersistCredential,
  appendAuditLog,
  DuplicateCredentialError,
} from './storage.js';
import {
  readWebhooks,
  createWebhookRecord,
  deleteWebhookRecord,
  getWebhookRecord,
  readWebhookLogs,
} from './webhooks.js';
import { paginateCursor } from './expiry.js';
import { requireAuth, sendJson, sendText } from './http-utils.js';
import { logger } from './logger.js';

export const GRAPHQL_SCHEMA_SDL = `
"""
W3C Decentralized Identifier (DID) Document
"""
type DIDDocument {
  id: ID!
  controller: String
  verificationMethod: [VerificationMethod!]!
  authentication: [String!]
  assertionMethod: [String!]
  service: [Service!]
}

type VerificationMethod {
  id: ID!
  type: String!
  controller: String!
  publicKeyMultibase: String
}

type Service {
  id: ID!
  type: String!
  serviceEndpoint: String!
}

type DIDMetadata {
  created: String
  updated: String
  deactivated: Boolean
  versionId: String
}

type DIDResolutionResult {
  didDocument: DIDDocument
  didResolutionMetadata: String
  didDocumentMetadata: DIDMetadata
}

"""
Verifiable Credential Object
"""
type Credential {
  id: ID!
  subject: String!
  issuer: String!
  issuedAt: String
  expiresAt: Float
  expires_at: Float
  revoked: Boolean
  revokedAt: String
  schema: String
  claims: String
  source: String
  expiry_notified_at: String
}

type PaginatedCredentials {
  items: [Credential!]!
  nextCursor: String
  total: Int
}

type VerificationResult {
  verified: Boolean!
  reason: String
  credential: Credential
}

"""
Reputation Score and Breakdown for a DID
"""
type ReputationScore {
  did: ID!
  score: Float!
  tier: String
  lastUpdated: String
  breakdown: ReputationBreakdown
}

type ReputationBreakdown {
  credentialCount: Int!
  activeDays: Int!
  trustScore: Float
}

"""
Webhook Registration
"""
type Webhook {
  id: ID!
  url: String!
  events: [String!]!
  active: Boolean!
  description: String
  createdAt: String!
  updatedAt: String
}

"""
Webhook Event Delivery Log
"""
type WebhookLog {
  deliveryId: ID!
  webhookId: String!
  url: String!
  event: String!
  statusCode: Int
  success: Boolean!
  attempt: Int!
  durationMs: Int
  timestamp: String!
  error: String
}

type ServerInfo {
  version: String!
  features: [String!]!
  minSdkVersion: String!
}

input IssueCredentialInput {
  id: ID!
  subject: String!
  issuer: String!
  expiresAt: Float
  expires_at: Float
  schema: String
  claims: String
}

input RegisterWebhookInput {
  url: String!
  events: [String!]
  secret: String
  authToken: String
  description: String
}

type Query {
  """
  Retrieve a DID document by identifier
  """
  did(id: ID!): DIDDocument

  """
  Full W3C DID Resolution
  """
  resolveDid(did: String!): DIDResolutionResult

  """
  Get a credential by ID
  """
  credential(id: ID!): Credential

  """
  List credentials with pagination and filtering
  """
  credentials(limit: Int, cursor: String, subject: String, issuer: String): PaginatedCredentials!

  """
  Verify a credential by ID
  """
  verifyCredential(id: ID!): VerificationResult!

  """
  Fetch reputation score for a DID
  """
  reputation(did: ID!): ReputationScore

  """
  List all trusted issuers from smart contract
  """
  issuers: [String!]!

  """
  List registered webhooks
  """
  webhooks: [Webhook!]!

  """
  Query webhook delivery logs
  """
  webhookLogs(webhookId: String, limit: Int): [WebhookLog!]!

  """
  Server metadata and supported features
  """
  serverInfo: ServerInfo!

  """
  Export the full GraphQL Schema SDL
  """
  schemaDoc: String!
}

type Mutation {
  """
  Issue and persist a new Verifiable Credential
  """
  issueCredential(input: IssueCredentialInput!): Credential!

  """
  Revoke an existing credential
  """
  revokeCredential(id: ID!): Credential

  """
  Register a new webhook subscription
  """
  registerWebhook(input: RegisterWebhookInput!): Webhook!

  """
  Delete a webhook subscription
  """
  deleteWebhook(id: ID!): Boolean!

  """
  Trigger a test webhook delivery
  """
  testWebhook(id: ID!): WebhookLog
}
`;

/**
 * Execute GraphQL query against resolvers and dataLoaders.
 */
export async function executeGraphQL({
  query,
  variables = {},
  operationName,
  context,
}) {
  if (!query || typeof query !== 'string') {
    return { errors: [{ message: 'Must provide a valid GraphQL query string.' }] };
  }

  const { config, soroban, webhookService, loaders, req } = context;

  // Resolvers implementation
  const rootResolvers = {
    Query: {
      async did({ id }) {
        return loaders.didLoader.load(id);
      },
      async resolveDid({ did }) {
        const doc = await loaders.didLoader.load(did);
        return {
          didDocument: doc,
          didResolutionMetadata: JSON.stringify({ contentType: 'application/did+ld+json' }),
          didDocumentMetadata: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            deactivated: false,
            versionId: '1',
          },
        };
      },
      async credential({ id }) {
        return loaders.credentialLoader.load(id);
      },
      async credentials({ limit = 50, cursor = null, subject = null, issuer = null }) {
        let all = await readCredentials(config);
        if (subject) all = all.filter((c) => c.subject === subject);
        if (issuer) all = all.filter((c) => c.issuer === issuer);
        const { items, nextCursor } = paginateCursor(all, { limit, cursor });
        return {
          items,
          nextCursor,
          total: all.length,
        };
      },
      async verifyCredential({ id }) {
        const credential = await loaders.credentialLoader.load(id);
        if (!credential) {
          return { verified: false, reason: 'not_found', credential: null };
        }
        if (credential.revoked) {
          return { verified: false, reason: 'revoked', credential };
        }
        const now = Math.floor(Date.now() / 1000);
        const expiry = credential.expiresAt || credential.expires_at;
        if (expiry > 0 && expiry < now) {
          return { verified: false, reason: 'expired', credential };
        }
        return { verified: true, reason: null, credential };
      },
      async reputation({ did }) {
        return loaders.reputationLoader.load(did);
      },
      async issuers() {
        if (!soroban) return [];
        return soroban.getIssuers();
      },
      async webhooks() {
        return readWebhooks(config);
      },
      async webhookLogs({ webhookId = null, limit = 50 }) {
        return readWebhookLogs(config, { webhookId, limit });
      },
      async serverInfo() {
        return {
          version: '0.1.0',
          features: ['webhook_delivery', 'batch_issuance', 'event_polling', 'graphql_api', 'api_versioning'],
          minSdkVersion: '0.1.0',
        };
      },
      async schemaDoc() {
        return GRAPHQL_SCHEMA_SDL.trim();
      },
    },
    Mutation: {
      async issueCredential({ input }) {
        if (!input || !input.id) {
          throw new Error('Credential input must include an id.');
        }
        const body = {
          id: input.id,
          subject: input.subject,
          issuer: input.issuer,
          expiresAt: input.expiresAt || input.expires_at || 0,
          expires_at: input.expires_at || input.expiresAt || 0,
          schema: input.schema || null,
          claims: input.claims || null,
          issuedAt: new Date().toISOString(),
        };
        await createAndPersistCredential(config, body);
        await appendAuditLog(config, { action: 'issue_credential', credentialId: body.id });
        if (webhookService) {
          webhookService.trigger('credential.issued', body).catch(() => {});
        }
        loaders.credentialLoader.clear(body.id);
        loaders.reputationLoader.clear(body.subject);
        return body;
      },
      async revokeCredential({ id }) {
        const revoked = await revokeAndPersistCredential(config, id);
        if (!revoked) throw new Error(`Credential with id "${id}" not found.`);
        await appendAuditLog(config, { action: 'revoke_credential', credentialId: id });
        if (webhookService) {
          webhookService.trigger('credential.revoked', { id, revokedAt: revoked.revokedAt }).catch(() => {});
        }
        loaders.credentialLoader.clear(id);
        return revoked;
      },
      async registerWebhook({ input }) {
        const webhook = await createWebhookRecord(config, input);
        return webhook;
      },
      async deleteWebhook({ id }) {
        return deleteWebhookRecord(config, id);
      },
      async testWebhook({ id }) {
        const webhook = await getWebhookRecord(config, id);
        if (!webhook) throw new Error(`Webhook with id "${id}" not found.`);
        if (!webhookService) throw new Error('Webhook service is unavailable.');
        return webhookService.deliverTest(webhook);
      },
    },
  };

  try {
    const data = await executeParsedQuery(query, variables, rootResolvers, context);
    return { data };
  } catch (err) {
    logger.error({ error: err.message, stack: err.stack }, 'GraphQL execution error');
    return { errors: [{ message: err.message }] };
  }
}

/**
 * Lightweight GraphQL AST-like parser and executor.
 */
async function executeParsedQuery(queryString, variables, rootResolvers, context) {
  const clean = queryString
    .replace(/#[^\n\r]*/g, '') // remove comments
    .trim();

  const isMutation = /^\s*mutation\b/i.test(clean);
  const typeResolvers = isMutation ? rootResolvers.Mutation : rootResolvers.Query;
  const result = {};

  // Extract root selections
  const fieldRegex = /([a-zA-Z0-9_]+)(?:\s*\(([^)]*)\))?\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})?/g;
  
  // Find body inside outermost { ... }
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Invalid GraphQL syntax: missing braces.');
  }

  const selectionBlock = clean.slice(firstBrace + 1, lastBrace).trim();
  let match;

  while ((match = fieldRegex.exec(selectionBlock)) !== null) {
    const fieldName = match[1];
    const rawArgs = match[2];
    const subFieldsRaw = match[3];

    // Skip keyword identifiers like 'query' or 'mutation' if matched
    if ((fieldName === 'query' || fieldName === 'mutation') && !typeResolvers[fieldName]) {
      continue;
    }

    const resolver = typeResolvers[fieldName];
    if (!resolver) {
      // If field not found on root, skip or mark null
      continue;
    }

    const args = parseFieldArgs(rawArgs, variables);
    const resolvedValue = await resolver(args, context);

    if (subFieldsRaw && resolvedValue && typeof resolvedValue === 'object') {
      result[fieldName] = selectSubFields(resolvedValue, subFieldsRaw);
    } else {
      result[fieldName] = resolvedValue;
    }
  }

  return result;
}

function parseFieldArgs(rawArgs, variables) {
  if (!rawArgs || !rawArgs.trim()) return {};
  const args = {};
  const pairs = rawArgs.split(/,(?![^()]*\))/); // split top-level commas

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const key = pair.slice(0, colonIdx).trim();
    let valStr = pair.slice(colonIdx + 1).trim();

    if (valStr.startsWith('$')) {
      const varName = valStr.slice(1);
      args[key] = variables[varName];
    } else if (valStr.startsWith('"') && valStr.endsWith('"')) {
      args[key] = valStr.slice(1, -1);
    } else if (valStr === 'true') {
      args[key] = true;
    } else if (valStr === 'false') {
      args[key] = false;
    } else if (valStr === 'null') {
      args[key] = null;
    } else if (!isNaN(Number(valStr))) {
      args[key] = Number(valStr);
    } else if (valStr.startsWith('{') && valStr.endsWith('}')) {
      try {
        // Simple JSON-like parse
        const normalized = valStr.replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":');
        args[key] = JSON.parse(normalized);
      } catch {
        args[key] = valStr;
      }
    } else {
      args[key] = valStr;
    }
  }
  return args;
}

function selectSubFields(target, subFieldsRaw) {
  if (Array.isArray(target)) {
    return target.map((item) => selectSubFields(item, subFieldsRaw));
  }
  if (!target || typeof target !== 'object') return target;

  const requestedFields = subFieldsRaw
    .replace(/\{[^}]*\}/g, '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (requestedFields.length === 0) return target;

  const out = {};
  for (const field of requestedFields) {
    if (target[field] !== undefined) {
      out[field] = target[field];
    }
  }
  return out;
}

/**
 * Render GraphiQL Playground HTML page for dev mode.
 */
export function renderGraphiQLPlayground() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Soroban Identity GraphQL Playground</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      background: #1e293b;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #334155;
    }
    h1 { margin: 0; font-size: 1.1rem; font-weight: 600; color: #38bdf8; }
    .container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 16px;
      border-right: 1px solid #334155;
    }
    .panel:last-child { border-right: none; }
    textarea {
      flex: 1;
      background: #020617;
      color: #f1f5f9;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 12px;
      font-family: "Fira Code", monospace;
      font-size: 14px;
      resize: none;
      outline: none;
    }
    textarea:focus { border-color: #38bdf8; }
    pre {
      flex: 1;
      background: #020617;
      color: #a5f3fc;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 12px;
      margin: 0;
      overflow: auto;
      font-family: "Fira Code", monospace;
      font-size: 14px;
    }
    button {
      background: #0284c7;
      color: white;
      border: none;
      padding: 8px 20px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 12px;
    }
    button:hover { background: #0369a1; }
    .label { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px; }
  </style>
</head>
<body>
  <header>
    <h1>✦ Soroban Identity GraphQL Explorer</h1>
    <span style="color: #94a3b8; font-size: 0.9rem;">Endpoint: <code>/graphql</code></span>
  </header>
  <div class="container">
    <div class="panel">
      <div class="label">Query Editor</div>
      <textarea id="query" spellcheck="false">query GetOverview {
  serverInfo {
    version
    features
  }
  credentials(limit: 10) {
    items {
      id
      subject
      issuer
      revoked
    }
    total
  }
  issuers
}</textarea>
      <div style="display: flex; gap: 8px;">
        <button id="runBtn">▶ Run Query</button>
      </div>
    </div>
    <div class="panel">
      <div class="label">Variables (JSON)</div>
      <textarea id="vars" style="flex: 0 0 100px; margin-bottom: 12px;" spellcheck="false">{}</textarea>
      <div class="label">Response</div>
      <pre id="output">Click "Run Query" to execute...</pre>
    </div>
  </div>
  <script>
    document.getElementById('runBtn').addEventListener('click', async () => {
      const query = document.getElementById('query').value;
      let variables = {};
      try {
        variables = JSON.parse(document.getElementById('vars').value || '{}');
      } catch (e) {
        document.getElementById('output').textContent = 'Invalid variables JSON: ' + e.message;
        return;
      }
      document.getElementById('output').textContent = 'Loading...';
      try {
        const res = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables })
        });
        const json = await res.json();
        document.getElementById('output').textContent = JSON.stringify(json, null, 2);
      } catch (err) {
        document.getElementById('output').textContent = 'Network Error: ' + err.message;
      }
    });
  </script>
</body>
</html>`;
}
