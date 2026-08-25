# Soroban Identity GraphQL API Specification

The Soroban Identity GraphQL API provides a unified, strongly-typed query and mutation interface alongside the REST API. It is optimized for client applications requiring flexible field selection, batching via DataLoader, and minimal round trips.

## Endpoint

- **URL:** `/graphql` (also available via `/v1/graphql` and `/v2/graphql`)
- **HTTP Methods:**
  - `POST /graphql`: Query and mutation execution (Content-Type: `application/json`)
  - `GET /graphql`: Interactive GraphQL Playground / GraphiQL (in development mode or browser requests)

---

## Authentication & Authorization

All mutations and sensitive queries require authorization via API Key:

- **Header:** `X-API-Key: <api_key>` or `Authorization: Bearer <api_key>`
- **Scope Requirements:**
  - Querying credentials / verification: `credentials:read` or `*`
  - Issuing / revoking credentials: `credentials:write` or `*`
  - Admin & webhook operations: `admin:read` / `admin:write` or `*`

---

## Schema Definition Language (SDL)

```graphql
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
  did(id: ID!): DIDDocument
  resolveDid(did: String!): DIDResolutionResult
  credential(id: ID!): Credential
  credentials(limit: Int, cursor: String, subject: String, issuer: String): PaginatedCredentials!
  verifyCredential(id: ID!): VerificationResult!
  reputation(did: ID!): ReputationScore
  issuers: [String!]!
  webhooks: [Webhook!]!
  webhookLogs(webhookId: String, limit: Int): [WebhookLog!]!
  serverInfo: ServerInfo!
  schemaDoc: String!
}

type Mutation {
  issueCredential(input: IssueCredentialInput!): Credential!
  revokeCredential(id: ID!): Credential
  registerWebhook(input: RegisterWebhookInput!): Webhook!
  deleteWebhook(id: ID!): Boolean!
  testWebhook(id: ID!): WebhookLog
}
```

---

## DataLoader Caching & Batching

The GraphQL server employs per-request DataLoader instances for:
- **DIDs (`didLoader`)**: Batches DID resolution requests to avoid duplicate ledger lookups.
- **Credentials (`credentialLoader`)**: Caches and memoizes credential lookups within a single query execution.
- **Reputation Scores (`reputationLoader`)**: Aggregates and caches reputation scores across subjects in parallel.

---

## Example Queries

### Query Server Info & Credential Overview
```graphql
query GetOverview {
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
}
```

### Verify Credential and Fetch Reputation
```graphql
query VerifyAndScore {
  verifyCredential(id: "cred-123") {
    verified
    reason
    credential {
      id
      subject
      issuer
    }
  }
  reputation(did: "did:stellar:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF") {
    score
    tier
    breakdown {
      credentialCount
      activeDays
    }
  }
}
```

### Issue a Credential via Mutation
```graphql
mutation IssueNewCredential {
  issueCredential(input: {
    id: "cred-789",
    subject: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    issuer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
    expiresAt: 1893456000
  }) {
    id
    subject
    issuer
    issuedAt
  }
}
```
