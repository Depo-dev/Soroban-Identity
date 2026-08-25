import {
  Account,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import type {
  CallOptions,
  Credential,
  CredentialListOptions,
  CredentialStorageStats,
  CredentialType,
  Page,
  PaginationOptions,
  RevokedCredential,
  SorobanIdentityConfig,
  SorobanResponse,
  VerifyResult,
  WriteResult,
} from "./types";
import { validateConfig } from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus, runConcurrent } from "./utils";
import { ContractError, SorobanIdentityError, wrapError, ClaimsValidationError } from "./errors";
import { CREDENTIAL_MANAGER_ERRORS } from "./error-codes";
import { BaseClient } from "./base-client";
import {
  buildIssueCredentialArgs,
  buildRevokeCredentialArgs,
  buildRevokeBatchArgs,
  buildRenewCredentialArgs,
  buildVerifyCredentialArgs,
  buildGetCredentialArgs,
  buildGetSubjectCredentialsArgs,
  buildIsIssuerArgs,
  buildGetCredentialCountArgs,
  buildListSubjectCredentialsArgs,
  buildListIssuersArgs,
  buildGetIssuerCredentialsArgs,
  buildListIssuerCredentialsArgs,
  buildGetRevocationsArgs,
} from "./contract-args";

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

/** All parameters required for a single {@link CredentialClient.issueCredential} call. */
export interface CredentialInput {
  issuerKeypair: Keypair;
  subjectAddress: string;
  credentialType: CredentialType;
  claims: Record<string, string>;
  claimsHashHex: string;
  expiresAt?: number;
  options?: CallOptions & { nonce?: string; schemaId?: string };
  signatureHex?: string;
}

/** Options for {@link CredentialClient.issueCredentialBatch}. */
export interface BatchOptions {
  /** Maximum parallel in-flight issuances per chunk. Defaults to `5`. */
  concurrency?: number;
}

/** Return type of {@link CredentialClient.issueCredentialBatch}. */
export interface BatchResult {
  succeeded: Array<SorobanResponse<{ credentialId: string } & WriteResult>>;
  failed: Array<{ input: CredentialInput; error: SorobanIdentityError }>;
}

/**
 * Converts a JavaScript Date or millisecond timestamp to Unix seconds.
 */
export function toCredentialExpiry(dateOrMs: Date | number): number {
  const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : dateOrMs;
  return Math.floor(ms / 1000);
}

/** Contract error codes returned by credential-manager — see {@link CREDENTIAL_MANAGER_ERRORS}. */
const CREDENTIAL_NOT_FOUND_CODE = 3;
const CREDENTIAL_REVOKED_CODE = 4;
const CREDENTIAL_EXPIRED_CODE = 9;

/**
 * Client for the credential-manager contract.
 *
 * @example
 * ```ts
 * import { CredentialClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const credentials = new CredentialClient({ ...TESTNET_CONFIG, credentialManagerId: '...' });
 * const page = await credentials.listCredentialsBySubject(caller, subject, { limit: 50 });
 * ```
 */
export class CredentialClient extends BaseClient {
  constructor(config: SorobanIdentityConfig) {
    validateConfig(config, { contractIdField: "credentialManagerId" });
    super(config, config.credentialManagerId);
  }

  async isInitialized(): Promise<boolean> {
    try {
      return await this.executeWithFailover(async (server) => {
        const account = new Account(PROBE_ADDRESS, "0");
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "is_issuer",
              ...buildIsIssuerArgs({ address: PROBE_ADDRESS })
            )
          )
          .setTimeout(10)
          .build();
        const result = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(result)) {
          const err: string = (result as { error: string }).error ?? "";
          if (err.includes("not initialized") || err.includes("NotInitialized") || err.includes("#0")) {
            return false;
          }
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Estimate the XLM fee for issuing a credential without signing or submitting.
   */
  async estimateIssuanceFee(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    claimsHashHex: string,
    expiresAt = 0,
    options?: CallOptions
  ): Promise<{ fee: string; feeXLM: string }> {
    if (!/^[0-9a-fA-F]{64}$/.test(claimsHashHex)) {
      throw new SorobanIdentityError(
        "InvalidClaimsHashFormat: claimsHash must be a 64-character hex string (32 bytes)",
        "VALIDATION_ERROR"
      );
    }

    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const dummySignature = Buffer.alloc(64);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "issue_credential",
          ...buildIssueCredentialArgs({
            issuer: issuerKeypair.publicKey(),
            subject: subjectAddress,
            credentialType,
            claims,
            claimsHash: Buffer.from(claimsHashHex, "hex"),
            signature: dummySignature,
            expiresAt: BigInt(expiresAt),
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx)) as import("@stellar/stellar-sdk").Transaction;
    const feeStroops = prepared.fee;
    const feeXLM = (parseInt(feeStroops, 10) / 10_000_000).toFixed(7);
    return { fee: feeStroops, feeXLM };
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   *
   * @param issuerKeypair   The registered issuer signing the transaction.
   * @param subjectAddress  The Stellar address receiving the credential.
   * @param credentialType  Credential category.
   * @param claims          Arbitrary `string → string` claims to embed.
   * @param claimsHashHex   64-char hex (32 bytes) SHA-256 of the off-chain claims payload.
   * @param expiresAt       Unix timestamp (seconds) after which the credential is invalid. Pass `0` for no expiry.
   * @param options         Per-call overrides. Also accepts `nonce` and `schemaId`.
   * @param signatureHex    Optional pre-computed 64-byte issuer signature as a 128-char hex string.
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    claimsHashHex: string,
    expiresAt = 0,
    options?: CallOptions & { nonce?: string; schemaId?: string },
    signatureHex?: string
  ): Promise<SorobanResponse<{ credentialId: string } & WriteResult>> {
    if (!/^[0-9a-fA-F]{64}$/.test(claimsHashHex)) {
      throw new SorobanIdentityError(
        "InvalidClaimsHashFormat: claimsHash must be a 64-character hex string (32 bytes)",
        "VALIDATION_ERROR"
      );
    }

    if (signatureHex !== undefined) {
      if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
        throw new SorobanIdentityError(
          "InvalidSignatureFormat: signature must be a 128-character hex string (64 bytes)",
          "VALIDATION_ERROR"
        );
      }
    }

    const timeoutMs = options?.timeoutMs ?? this.config.defaultTimeoutMs ?? 30_000;
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), timeoutMs);

    const work = async (): Promise<SorobanResponse<{ credentialId: string } & WriteResult>> => {
      if (options?.schemaId) {
        await this._validateClaimsAgainstSchema(options.schemaId, claims);
      }

      const account = await this.server.getAccount(issuerKeypair.publicKey());
      const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

      const signature = signatureHex
        ? Buffer.from(signatureHex, "hex")
        : (() => {
            const issuerBytes = Buffer.from(issuerKeypair.publicKey(), "utf8");
            const subjectBytes = Buffer.from(subjectAddress, "utf8");
            const claimsHashBytes = Buffer.from(claimsHashHex, "hex");
            const parts: Buffer[] = [issuerBytes, subjectBytes, claimsHashBytes];
            if (options?.nonce) {
              parts.push(Buffer.from(options.nonce, "utf8"));
            }
            const msg = Buffer.concat(parts);
            const digest = createHash("sha256").update(msg).digest();
            return issuerKeypair.sign(digest);
          })();

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "issue_credential",
            ...buildIssueCredentialArgs({
              issuer: issuerKeypair.publicKey(),
              subject: subjectAddress,
              credentialType,
              claims,
              claimsHash: Buffer.from(claimsHashHex, "hex"),
              signature: Buffer.from(signature),
              expiresAt: BigInt(expiresAt),
            })
          )
        )
        .setTimeout(timeout)
        .build();

      const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
      const estimatedFee = parseInt(prepared.fee, 10);
      const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
      prepared.sign(issuerKeypair);

      const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
      this.debug('sdk.submission_outcome', { operation: 'credentials.sendTransaction', status: result.status });
      if (result.status !== "PENDING") {
        throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
      }

      const txHash = result.hash;
      await pollTransactionStatus(this.server, txHash, {
        maxRetries: this.config.maxRetries ?? this.config.pollingRetries,
        retryIntervalMs: this.config.retryIntervalMs ?? this.config.pollingIntervalMs,
        exponentialBackoff: this.config.pollingExponentialBackoff,
      });
      const confirmed = await this.server.getTransaction(txHash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      // Returns BytesN<32> — encode as hex
      const decoded = scValToNative(confirmed.returnValue!);
      const raw = decoded instanceof Uint8Array
        ? decoded
        : confirmed.returnValue instanceof Uint8Array
          ? confirmed.returnValue
          : Buffer.alloc(32);
      const credentialId = Buffer.from(raw).toString("hex");
      return { data: { credentialId, estimatedFee, estimatedFeeXlm }, txHash };
    };

    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => {
            reject(new SorobanIdentityError(`issueCredential timed out after ${timeoutMs}ms`, "TIMEOUT"));
          });
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Revoke a credential that was issued by `issuerKeypair`.
   */
  async revokeCredential(
    issuerKeypair: Keypair,
    credentialId: string,
    options?: CallOptions
  ): Promise<SorobanResponse<RevokedCredential>> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const idBytes = Buffer.from(credentialId, 'hex');

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'revoke_credential',
          ...buildRevokeCredentialArgs({ issuer: issuerKeypair.publicKey(), credentialId: idBytes })
        )
      )
      .setTimeout(timeout)
      .build();

    try {
      const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
      prepared.sign(issuerKeypair);

      const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
      this.debug('sdk.submission_outcome', { operation: 'credentials.revokeCredential', status: result.status });
      if (result.status !== 'PENDING') {
        throw new SorobanIdentityError(`Transaction failed: ${result.status}`, 'CONTRACT_ERROR');
      }

      const txHash = result.hash;
      await pollTransactionStatus(this.server, txHash);

      const confirmed = await this.server.getTransaction(txHash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const revokedAt = new Date((confirmed as { createdAt: number }).createdAt * 1000).toISOString();

      const credential = await this.getCredential(issuerKeypair.publicKey(), credentialId, options);
      const revokedCredential: RevokedCredential = { ...credential, revokedAt, status: 'revoked' };
      return { data: revokedCredential, txHash };
    } catch (e) {
      throw wrapError(e);
    }
  }

  /**
   * Renew a credential by extending its expiry without changing the credential ID.
   *
   * Only the original issuer may call this. The credential must not be revoked.
   * `newExpiresAt` must be strictly greater than the current `expires_at`.
   *
   * @param issuerKeypair  The registered issuer keypair that originally issued the credential.
   * @param credentialId   Hex-encoded credential ID (32 bytes).
   * @param newExpiresAt   New Unix timestamp (seconds). Use {@link toCredentialExpiry} to
   *                       convert from milliseconds. Must be > current expires_at.
   * @param options        Per-call overrides.
   * @returns `{ txHash }` — the on-chain transaction hash.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` if credential does not exist,
   *   `UNAUTHORIZED` if the caller is not the issuer, `VALIDATION_ERROR` if the credential
   *   is revoked, or `INVALID_ARGUMENT` if newExpiresAt is not later than the current expiry.
   *
   * @example
   * ```ts
   * const { txHash } = await credentials.renewCredential(
   *   issuerKeypair,
   *   credentialId,
   *   toCredentialExpiry(Date.now() + 30 * 24 * 60 * 60 * 1000) // +30 days
   * );
   * ```
   */
  async renewCredential(
    issuerKeypair: Keypair,
    credentialId: string,
    newExpiresAt: number,
    options?: CallOptions
  ): Promise<{ txHash: string }> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const idBytes = Buffer.from(credentialId, 'hex');

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'renew_credential',
          ...buildRenewCredentialArgs({
            issuer: issuerKeypair.publicKey(),
            credentialId: idBytes,
            newExpiresAt,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    try {
      const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
      prepared.sign(issuerKeypair);

      const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
      this.debug('sdk.submission_outcome', { operation: 'credentials.renewCredential', status: result.status });
      if (result.status !== 'PENDING') {
        throw new SorobanIdentityError(`Transaction failed: ${result.status}`, 'CONTRACT_ERROR');
      }

      const txHash = result.hash;
      await pollTransactionStatus(this.server, txHash);
      return { txHash };
    } catch (e) {
      throw wrapError(e);
    }
  }

  /**
   * Atomically revoke multiple credentials in a single transaction.
   * Maximum batch size is 50.
   */
  async revokeBatch(
    issuerKeypair: Keypair,
    ids: string[],
    reason: string,
    options?: CallOptions
  ): Promise<{ txHash: string }> {
    if (ids.length > 50) {
      throw new SorobanIdentityError(
        `Batch size ${ids.length} exceeds maximum of 50`,
        'BATCH_TOO_LARGE'
      );
    }

    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const idBuffers = ids.map((id) => Buffer.from(id, 'hex'));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'revoke_credentials_batch',
          ...buildRevokeBatchArgs({
            issuer: issuerKeypair.publicKey(),
            credentialIds: idBuffers,
            reason,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    try {
      const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
      prepared.sign(issuerKeypair);

      const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
      this.debug('sdk.submission_outcome', { operation: 'credentials.revokeBatch', status: result.status });
      if (result.status !== 'PENDING') {
        throw new SorobanIdentityError(`Transaction failed: ${result.status}`, 'CONTRACT_ERROR');
      }

      const txHash = result.hash;
      await pollTransactionStatus(this.server, txHash);
      return { txHash };
    } catch (e) {
      throw wrapError(e);
    }
  }

  private async _validateClaimsAgainstSchema(
    schemaId: string,
    claims: Record<string, string>
  ): Promise<void> {
    // Lazy-load ajv to avoid bundling it for callers who don't use schemaId
    let Ajv: any;
    try {
      const moduleName = "ajv";
      ({ default: Ajv } = await import(moduleName));
    } catch {
      throw new SorobanIdentityError(
        "ClaimsValidationError: ajv is required for schema validation. Install it with: npm install ajv",
        "INVALID_INPUT"
      );
    }

    let schema: Record<string, unknown>;
    try {
      const res = await fetch(schemaId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      schema = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new SorobanIdentityError(
        `ClaimsValidationError: failed to fetch schema ${schemaId}: ${e instanceof Error ? e.message : String(e)}`,
        "INVALID_INPUT"
      );
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(claims);
    if (!valid) {
      const fieldErrors: Record<string, string> = {};
      for (const err of validate.errors ?? []) {
        const field = err.instancePath?.replace(/^\//, "") || err.params?.missingProperty as string || "root";
        fieldErrors[field] = err.message ?? "invalid";
      }
      throw new ClaimsValidationError(
        `Claims failed schema validation for schemaId: ${schemaId}`,
        fieldErrors
      );
    }
  }

  /**
   * Verify a credential and get a typed result describing any failure reason.
   */
  async verifyCredential(
    callerAddress: string,
    credentialId: string,
    options?: CallOptions
  ): Promise<VerifyResult> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const idBytes = Buffer.from(credentialId, "hex");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "verify_credential",
          ...buildVerifyCredentialArgs({ credentialId: idBytes })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });

    if (isSimulationError) {
      const error: string = (result as { error: string }).error ?? "";
      const contractErr = ContractError.extract(error, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) {
        if (contractErr.code === CREDENTIAL_NOT_FOUND_CODE) return { valid: false, reason: 'not_found' };
        if (contractErr.code === CREDENTIAL_REVOKED_CODE) return { valid: false, reason: 'revoked' };
        if (contractErr.code === CREDENTIAL_EXPIRED_CODE) return { valid: false, reason: 'expired' };
        return { valid: false, reason: 'unknown' };
      }
      const lowerError = error.toLowerCase();
      if (lowerError.includes('not found') || lowerError.includes('credentialnotfound')) {
        return { valid: false, reason: 'not_found' };
      }
      return { valid: false, reason: 'unknown' };
    }

    const retval = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );

    if (retval !== false) {
      return { valid: true };
    }

    // Contract returned false — fetch the credential to determine why
    try {
      const credential = await this.getCredential(callerAddress, credentialId, options);
      if (credential.revoked) return { valid: false, reason: 'revoked' };
      if (credential.expiresAt > 0 && credential.expiresAt < Math.floor(Date.now() / 1000)) {
        return { valid: false, reason: 'expired' };
      }
      return { valid: false, reason: 'unknown' };
    } catch {
      return { valid: false, reason: 'unknown' };
    }
  }

  /**
   * Get all credentials issued to a subject address.
   */
  async getCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<Credential[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_subject_credentials",
          ...buildGetSubjectCredentialsArgs({ subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const idsResult = await retryWithBackoff(() => this.server.simulateTransaction(idsTx));
    const idsSimulationError = SorobanRpc.Api.isSimulationError(idsResult);
    this.debug('sdk.simulation_result', { operation: 'credentials.getCredentialsBySubject.ids', success: !idsSimulationError });
    if (idsSimulationError) {
      const errMsg = idsResult.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    const ids = scValToNative(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Uint8Array[];

    if (!ids || ids.length === 0) return [];

    return Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString("hex"), options)
      )
    );
  }

  /**
   * Find credentials issued to a subject that contain a specific claim key/value pair.
   *
   * **Performance caveat:** Claim values are not indexed on-chain. This method
   * fetches all credentials for the subject via {@link CredentialClient.getCredentialsBySubject}
   * and filters them client-side. For subjects with many credentials, prefer
   * building an off-chain index using contract events (`CRED.issued`).
   *
   * @param callerAddress  Stellar address used to build the read simulations.
   * @param subjectAddress The subject whose credentials to search.
   * @param claimKey       The claim key to match (case-sensitive).
   * @param claimValue     The expected claim value (case-sensitive).
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of {@link Credential} records where `claims[claimKey] === claimValue`.
   * @throws {SorobanIdentityError} on simulation failure.
   *
   * @example
   * ```ts
   * // Find all KYC credentials where country=NG
   * const results = await credentials.getCredentialsByClaimKey(
   *   caller,
   *   subject,
   *   'country',
   *   'NG'
   * );
   * ```
   */
  async getCredentialsByClaimKey(
    callerAddress: string,
    subjectAddress: string,
    claimKey: string,
    claimValue: string,
    options?: CallOptions
  ): Promise<Credential[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const all = await this.getCredentialsBySubject(callerAddress, subjectAddress, options);
    return all.filter((cred) => {
      const claims = cred.claims as Record<string, string>;
      return claims[claimKey] === claimValue;
    });
  }

  /**
   * Get a credential by ID.
   */
  async getCredential(
    callerAddress: string,
    credentialId: string,
    options?: CallOptions
  ): Promise<Credential> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const idBytes = Buffer.from(credentialId, "hex");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_credential",
          ...buildGetCredentialArgs({ credentialId: idBytes })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const error: string = (result as { error: string }).error ?? "";
      const contractErr = ContractError.extract(error, CREDENTIAL_MANAGER_ERRORS);
      if (!contractErr) {
        const lower = error.toLowerCase();
        if (
          lower.includes("credentialnotfound") ||
          lower.includes("credential not found") ||
          lower.includes("not found")
        ) {
          throw new SorobanIdentityError(
            `CredentialNotFound: credential ${credentialId} does not exist`,
            "NOT_FOUND"
          );
        }
        throw new SorobanIdentityError(`Simulation failed: ${error}`, "CONTRACT_ERROR");
      }
      if (contractErr.code === CREDENTIAL_NOT_FOUND_CODE) {
        throw new SorobanIdentityError("CredentialNotFound: credential does not exist", "NOT_FOUND");
      }
      if (contractErr.code === CREDENTIAL_REVOKED_CODE) {
        throw new SorobanIdentityError("CredentialRevoked: credential has been revoked", "VALIDATION_ERROR");
      }
      throw contractErr;
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Credential;
  }

  /**
   * Check if an address is a registered issuer.
   */
  async isIssuer(
    callerAddress: string,
    targetAddress: string,
    options?: CallOptions
  ): Promise<boolean> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(targetAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "is_issuer",
          ...buildIsIssuerArgs({ address: targetAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Verify multiple credentials in parallel with a configurable concurrency limit.
   */
  async verifyMany(
    callerAddress: string,
    credentialIds: string[],
    options?: CallOptions & { concurrency?: number }
  ): Promise<VerifyResult[]> {
    validateStellarAddress(callerAddress);
    const concurrency = options?.concurrency ?? this.config.maxConcurrentRequests ?? 5;
    return runConcurrent(
      credentialIds,
      (id) => this.verifyCredential(callerAddress, id, options),
      concurrency
    );
  }

  /** @deprecated Use {@link verifyMany} instead. */
  async verifyCredentialsBatch(
    callerAddress: string,
    credentialIds: string[],
    options?: CallOptions
  ): Promise<VerifyResult[]> {
    validateStellarAddress(callerAddress);
    return Promise.all(
      credentialIds.map((id) => this.verifyCredential(callerAddress, id, options))
    );
  }

  /**
   * Get the total number of credentials issued to a subject.
   */
  async getCredentialCount(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<number> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_credential_count",
          ...buildGetCredentialCountArgs({ subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as number;
  }

  /**
   * Get the list of all registered issuers.
   */
  async getIssuers(callerAddress: string, options?: CallOptions): Promise<string[]> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("get_issuers"))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as string[];
  }


  /**
   * Return all revoked credential IDs for an issuer/subject pair.
   *
   * Active credentials are not included; when the pair has no revocations the
   * contract returns an empty vector and this method resolves to `[]`.
   */
  async getRevocations(
    issuerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<string[]> {
    validateStellarAddress(issuerAddress);
    validateStellarAddress(subjectAddress);
    const account = await this.server.getAccount(issuerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'get_revocations',
          ...buildGetRevocationsArgs({ issuer: issuerAddress, subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const ids = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as Uint8Array[];
    return (ids ?? []).map((raw) => Buffer.from(raw).toString('hex'));
  }

  /**
   * Get storage usage statistics for the credential manager.
   */
  async getStorageStats(callerAddress: string, options?: CallOptions): Promise<CredentialStorageStats> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("get_storage_stats"))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as CredentialStorageStats;
  }

  /**
   * Cursor-paginated, optionally type-filtered credential IDs for a subject.
   */
  async listCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string,
    options?: CredentialListOptions
  ): Promise<Page<string>> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const cursorArg = options?.cursor === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.cursor }, {
          type: { Some: ['u64'] } as never,
        });
    const filterArg = options?.credentialType === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.credentialType }, {
          type: { Some: ['symbol'] } as never,
        });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'list_subject_credentials',
          ...buildListSubjectCredentialsArgs({
            subject: subjectAddress,
            cursor: cursorArg,
            limit: options?.limit ?? 0,
            filter: filterArg,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: Uint8Array[]; next_cursor: number | null };

    return {
      items: raw.items.map((b) => Buffer.from(b).toString('hex')),
      nextCursor: raw.next_cursor ?? null,
    };
  }

  /**
   * Cursor-paginated list of registered issuers.
   */
  async listIssuers(
    callerAddress: string,
    options?: PaginationOptions
  ): Promise<Page<string>> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const cursorArg = options?.cursor === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.cursor }, {
          type: { Some: ['u64'] } as never,
        });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'list_issuers',
          ...buildListIssuersArgs({
            cursor: cursorArg,
            limit: options?.limit ?? 0,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: string[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
  }

  /**
   * Get all credentials issued by an issuer address.
   */
  async getCredentialsByIssuer(
    callerAddress: string,
    issuerAddress: string,
    options?: CallOptions
  ): Promise<Credential[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(issuerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'get_issuer_credentials',
          ...buildGetIssuerCredentialsArgs({ issuer: issuerAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const idsResult = await retryWithBackoff(() => this.server.simulateTransaction(idsTx));
    const idsSimulationError = SorobanRpc.Api.isSimulationError(idsResult);
    this.debug('sdk.simulation_result', { operation: 'credentials.getCredentialsByIssuer.ids', success: !idsSimulationError });
    if (idsSimulationError) {
      const errMsg = idsResult.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const ids = scValToNative(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as Uint8Array[];

    if (!ids || ids.length === 0) return [];

    return Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString('hex'), options)
      )
    );
  }

  /**
   * Cursor-paginated credential IDs issued by an issuer.
   */
  async listCredentialsByIssuer(
    callerAddress: string,
    issuerAddress: string,
    options?: PaginationOptions
  ): Promise<Page<string>> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(issuerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const cursorArg = options?.cursor === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.cursor }, { type: { Some: ['u64'] } as never });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'list_issuer_credentials',
          ...buildListIssuerCredentialsArgs({
            issuer: issuerAddress,
            cursor: cursorArg,
            limit: options?.limit ?? 0,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: Uint8Array[]; next_cursor: number | null };

    return {
      items: raw.items.map((b) => Buffer.from(b).toString('hex')),
      nextCursor: raw.next_cursor ?? null,
    };
  }

  /**
   * Issue multiple credentials in controlled-concurrency chunks.
   */
  async issueCredentialBatch(items: CredentialInput[], opts?: BatchOptions): Promise<BatchResult> {
    const concurrency = opts?.concurrency ?? 5;
    const succeeded: BatchResult["succeeded"] = [];
    const failed: BatchResult["failed"] = [];

    for (let i = 0; i < items.length; i += concurrency) {
      const chunk = items.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        chunk.map((item) =>
          this.issueCredential(
            item.issuerKeypair,
            item.subjectAddress,
            item.credentialType,
            item.claims,
            item.claimsHashHex,
            item.expiresAt ?? 0,
            item.options,
            item.signatureHex
          )
        )
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j]!;
        if (result.status === "fulfilled") {
          succeeded.push(result.value);
        } else {
          const error =
            result.reason instanceof SorobanIdentityError
              ? result.reason
              : new SorobanIdentityError(
                  result.reason instanceof Error ? result.reason.message : String(result.reason),
                  "UNKNOWN",
                  result.reason
                );
          failed.push({ input: chunk[j]!, error });
        }
      }
    }

    return { succeeded, failed };
  }

  /**
   * Liveness probe — calls the on-chain `ping()` function.
   */
  async ping(options?: CallOptions): Promise<number> {
    const account = new Account(PROBE_ADDRESS, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("ping"))
      .setTimeout(timeout)
      .build();
    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new SorobanIdentityError(
        "Health check failed: credential-manager not responding",
        "CONTRACT_ERROR"
      );
    }
    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as number;
  }

  /**
   * Returns all revoked credential IDs for the given issuer.
   *
   * Closes #553: because on-chain `verify_credential` results must not be
   * cached indefinitely, consumers can call this method periodically (or
   * subscribe to `credential_revoked` events via {@link SorobanEventListener})
   * to detect newly-revoked credentials and invalidate local caches.
   *
   * The list is derived by iterating the issuer's on-chain credential index
   * and filtering for entries where `revoked === true`. For large issuers
   * use the paginated form via {@link CredentialClient.listIssuerCredentials}
   * and filter client-side, or subscribe to the `credential_revoked` event
   * stream for push-based invalidation.
   *
   * @param callerAddress  Any valid Stellar address (used as the fee-payer account).
   * @param issuerAddress  The issuer whose revocation list to fetch.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of hex-encoded 32-byte credential IDs that have been revoked.
   *
   * @example
   * ```ts
   * // closes #553 — re-verify or invalidate any locally-cached result for these IDs
   * const revoked = await credentials.getRevocationList(caller, issuerAddress);
   * for (const id of revoked) {
   *   cache.invalidate(id);
   * }
   * ```
   */
  async getRevocationList(
    callerAddress: string,
    issuerAddress: string,
    options?: CallOptions
  ): Promise<string[]> {
    validateStellarAddress(issuerAddress);
    // Fetch all credentials for this issuer and return the revoked IDs.
    // Closes #553: consumers must re-verify or subscribe to credential_revoked
    // events rather than cache verify_credential results indefinitely.
    const allCredentials = await this.getCredentialsByIssuer(callerAddress, issuerAddress, options);
    return allCredentials
      .filter((cred) => cred.revoked)
      .map((cred) => cred.id);
  }
}
