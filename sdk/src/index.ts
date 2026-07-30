// ── Clients ───────────────────────────────────────────────────────────────────
export { IdentityClient } from './identity';
export { CredentialClient } from './credentials';
export type { CredentialInput, BatchOptions, BatchResult } from './credentials';
export { ReputationClient } from './reputation';
export { PresentationClient } from './presentation';

// ── Errors ────────────────────────────────────────────────────────────────────
export {
  SorobanIdentityError,
  ContractError,
  RateLimitError,
  ClientDisposedError,
  ClaimsValidationError,
  classifyError,
  wrapError,
  parseContractError,
} from './errors';
export type { SorobanErrorCode, SorobanIdentityErrorInit } from './errors';

// ── Error codes ───────────────────────────────────────────────────────────────
export {
  SorobanErrorCodes,
  IDENTITY_REGISTRY_ERRORS,
  CREDENTIAL_MANAGER_ERRORS,
  REPUTATION_ERRORS,
} from './error-codes';

// ── Types ─────────────────────────────────────────────────────────────────────
export {
  UnknownCredentialTypeError,
  assertCredentialType,
  SimulationError,
  validateConfig,
} from './types';
export type {
  DidDocument,
  ServiceEndpoint,
  Credential,
  RevokedCredential,
  CredentialType,
  CredentialListOptions,
  VerifyResult,
  VerifyFailReason,
  SorobanIdentityConfig,
  SorobanIdentityLogger,
  ReputationRecord,
  ScoreHistoryEntry,
  AccountInfo,
  CallOptions,
  IdentityStorageStats,
  CredentialStorageStats,
  ReputationStorageStats,
  Page,
  PaginationOptions,
  SorobanIdentityContractIdField,
  ValidateConfigOptions,
  SorobanResponse,
  WriteResult,
  FeeEstimate,
} from './types';

// ── Transaction helpers ───────────────────────────────────────────────────────
export { executeTransaction } from './transaction';
export type { TxOptions } from './transaction';

// ── Events ────────────────────────────────────────────────────────────────────
export { SorobanEventListener, getEvents, subscribeToEvents } from './events';
export type {
  SubscribeOptions,
  EventFilter,
  ContractEvent,
  GetEventsOptions,
} from './events';

// ── Presentation ──────────────────────────────────────────────────────────────
export type {
  VerifiablePresentation,
  VerifiableCredentialSubset,
  PresentationProof,
  PresentationVerifyResult,
  PresentationVerifyFailReason,
} from './presentation';

// ── Server info ───────────────────────────────────────────────────────────────
export { getServerInfo, UnsupportedEndpointError } from './server-info';
export type { ServerInfo } from './server-info';

// ── Utilities ─────────────────────────────────────────────────────────────────
export { SorobanTransactionBuilder } from './transaction-builder';
export { RequestQueue } from './request-queue';
export {
  retryWithBackoff,
  checkConnection,
  validateStellarAddress,
  computeCredentialId,
  runConcurrent,
} from './utils';
export { clearServerCache, SDK_VERSION } from './base-client';
export {
  toW3CDidDocument,
  exportDidDocumentAsJsonLd,
  flattenSubject,
  serializeClaimValue,
  hashSubjectClaims,
} from './serializers';

// ── Contract-arg builders ─────────────────────────────────────────────────────
export {
  buildCreateDidArgs,
  buildUpdateDidArgs,
  buildResolveDidArgs,
  buildHasActiveDidArgs,
  buildDeactivateDidArgs,
  buildIssueCredentialArgs,
  buildRevokeCredentialArgs,
  buildVerifyCredentialArgs,
  buildGetCredentialArgs,
  buildGetSubjectCredentialsArgs,
  buildIsIssuerArgs,
  buildGetCredentialCountArgs,
  buildListSubjectCredentialsArgs,
  buildListIssuersArgs,
  buildGetReputationArgs,
  buildGetHistoryArgs,
  buildPassesSybilCheckDefaultArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
  buildListReportersArgs,
  buildListHistoryArgs,
  buildGetIssuerCredentialsArgs,
  buildListIssuerCredentialsArgs,
} from './contract-args';

// ── Health ────────────────────────────────────────────────────────────────────
export { health, healthCheck } from './health';
export type { HealthResult, HealthCheckResult } from './health';

// ── Server-side helpers (API keys, rate-limiting, webhooks) ───────────────────
export type {
  ApiKeyScope,
  ApiKeyMetadata,
  ApiKeyRecord,
  ApiKeyStore,
  IssueApiKeyResult,
  IssueApiKeyOptions,
  AuthContext,
  ApiKeyMiddlewareOptions,
} from './server/api-keys';
export {
  InMemoryApiKeyStore,
  hashApiKey,
  issueApiKey,
  parseAuthorizationHeader,
  createApiKeyAuthMiddleware,
} from './server/api-keys';

export type {
  RateClass,
  RateLimitConfig,
  RateLimitOptions,
  RateLimitMiddlewareOptions,
} from './server/rate-limit';
export {
  RATE_LIMIT_DEFAULTS,
  TokenBucketRateLimiter,
  createRateLimitMiddleware,
} from './server/rate-limit';

export type {
  WebhookEvent,
  WebhookRegistration,
  WebhookStore,
  RegisterWebhookInput,
  RegisterWebhookOptions,
  FetchResponseLike,
  FetchLike,
  DeliverOptions,
  DeliveryAttempt,
  DeliveryResult,
  DlqRecord,
  DlqWriter,
} from './server/webhooks';
export {
  WEBHOOK_EVENTS,
  InMemoryWebhookStore,
  registerWebhook,
  signPayload,
  verifySignature,
  WebhookDispatcher,
  WEBHOOK_HEADERS,
  FileDlqWriter,
  WebhookDispatcherWithDLQ,
} from './server/webhooks';

// ── v1 namespace ──────────────────────────────────────────────────────────────
export * as v1 from './v1';

// ── Network defaults ──────────────────────────────────────────────────────────
import type { SorobanIdentityConfig } from './types';

export const TESTNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-testnet.stellar.org', 'https://soroban-testnet-backup.stellar.org'],
  networkPassphrase: 'Test SDF Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};

export const MAINNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-mainnet.stellar.org', 'https://soroban-mainnet-backup.stellar.org'],
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};
