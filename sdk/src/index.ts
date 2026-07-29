// ── Core clients ──────────────────────────────────────────────────────────────
export { IdentityClient } from './identity';
export { CredentialClient } from './credentials';
export type { CredentialInput, BatchOptions, BatchResult } from './credentials';
export { ReputationClient } from './reputation';
export type { ReputationRecord, ScoreHistoryEntry } from './reputation';

// ── Base client (multi-sig pipeline, closes #564) ─────────────────────────────
//
// All SDK clients extend BaseClient which exposes:
//   buildUnsignedTransaction(operation, accountInfo, options?) → { xdr, hash }
//   submitSignedTransaction(signedXdr) → { hash }
//
// Multi-sig workflow:
//   1. Fetch account once while online:
//        const account = await server.getAccount(signerA);
//        const accountInfo = { publicKey: signerA, sequence: account.sequence };
//   2. Build the unsigned transaction (no RPC needed):
//        const { xdr } = client.buildUnsignedTransaction(operation, accountInfo);
//   3. Route the XDR to each required signer (hardware wallet, air-gap device, etc.):
//        const signed1 = await walletA.sign(xdr);
//        const signed2 = await walletB.sign(signed1); // attach second signature
//   4. Submit the fully-signed transaction:
//        const { hash } = await client.submitSignedTransaction(signed2);
export { BaseClient, getOrCreateServer, clearServerCache, SDK_VERSION } from './base-client';
export type { AccountInfo } from './types';

// ── Presentation ──────────────────────────────────────────────────────────────
export { PresentationClient } from './presentation';
export type {
  VerifiablePresentation,
  VerifiableCredentialSubset,
  PresentationProof,
  PresentationVerifyResult,
  PresentationVerifyFailReason,
} from './presentation';

// ── Events ────────────────────────────────────────────────────────────────────
export { SorobanEventListener, getEvents, subscribeToEvents } from './events';
export type { SubscribeOptions, EventFilter, ContractEvent, GetEventsOptions } from './events';

// ── Health ────────────────────────────────────────────────────────────────────
export { health, healthCheck } from './health';
export type { HealthResult, HealthCheckResult } from './health';

// ── Server info ───────────────────────────────────────────────────────────────
export { getServerInfo, UnsupportedEndpointError } from './server-info';
export type { ServerInfo } from './server-info';

// ── Transaction helpers ───────────────────────────────────────────────────────
export { SorobanTransactionBuilder } from './transaction-builder';
export { executeTransaction } from './transaction';
export type { TxOptions } from './transaction';

// ── Errors ────────────────────────────────────────────────────────────────────
export {
  ContractError,
  SorobanIdentityError,
  RateLimitError,
  ClientDisposedError,
  classifyError,
  wrapError,
  parseContractError,
} from './errors';
export type { SorobanErrorCode, SorobanIdentityErrorInit } from './errors';
export {
  SorobanErrorCodes,
  IDENTITY_REGISTRY_ERRORS,
  CREDENTIAL_MANAGER_ERRORS,
  REPUTATION_ERRORS,
} from './error-codes';

// ── Utils ─────────────────────────────────────────────────────────────────────
export {
  retryWithBackoff,
  checkConnection,
  validateStellarAddress,
  computeCredentialId,
  runConcurrent,
  pollTransactionStatus,
} from './utils';
export { RequestQueue } from './request-queue';

// ── Serializers ───────────────────────────────────────────────────────────────
export {
  toW3CDidDocument,
  exportDidDocumentAsJsonLd,
  flattenSubject,
  serializeClaimValue,
  hashSubjectClaims,
} from './serializers';

// ── Contract arg builders ─────────────────────────────────────────────────────
export {
  buildCreateDidArgs,
  buildUpdateDidArgs,
  buildResolveDidArgs,
  buildHasActiveDidArgs,
  buildDeactivateDidArgs,
  buildIssueCredentialArgs,
  buildRevokeCredentialArgs,
  buildRevokeBatchArgs,
  buildVerifyCredentialArgs,
  buildGetCredentialArgs,
  buildGetSubjectCredentialsArgs,
  buildIsIssuerArgs,
  buildGetCredentialCountArgs,
  buildListSubjectCredentialsArgs,
  buildListIssuersArgs,
  buildGetIssuerCredentialsArgs,
  buildListIssuerCredentialsArgs,
  buildGetReputationArgs,
  buildGetHistoryArgs,
  buildPassesSybilCheckDefaultArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
  buildListReportersArgs,
  buildListHistoryArgs,
} from './contract-args';

// ── Types ─────────────────────────────────────────────────────────────────────
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
  CallOptions,
  WriteResult,
  SorobanResponse,
  IdentityStorageStats,
  CredentialStorageStats,
  ReputationStorageStats,
  Page,
  PaginationOptions,
  FeeEstimate,
} from './types';
export { validateConfig, assertCredentialType, UnknownCredentialTypeError, SimulationError } from './types';

// ── OpenAPI / v1 ──────────────────────────────────────────────────────────────
export * as v1 from './v1';
export * from './server';

// ── Network configs ───────────────────────────────────────────────────────────
import type { SorobanIdentityConfig } from './types';

/** Testnet defaults — fill contract IDs after deployment. */
export const TESTNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-testnet.stellar.org', 'https://soroban-testnet-backup.stellar.org'],
  networkPassphrase: 'Test SDF Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};

/** Mainnet defaults — fill contract IDs after deployment. */
export const MAINNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-mainnet.stellar.org', 'https://soroban-mainnet-backup.stellar.org'],
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};
