import {
  Account,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { CallOptions, DidDocument, IdentityStorageStats, SorobanIdentityConfig, SorobanResponse, WriteResult } from "./types";
import { validateConfig } from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus, runConcurrent } from "./utils";
import { ContractError, SorobanIdentityError, wrapError } from "./errors";
import { IDENTITY_REGISTRY_ERRORS } from "./error-codes";
import { BaseClient } from "./base-client";
import {
  buildCreateDidArgs,
  buildUpdateDidArgs,
  buildResolveDidArgs,
  buildHasActiveDidArgs,
  buildDeactivateDidArgs,
  buildDidExistsArgs,
} from "./contract-args";

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

function isTransientRpcError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (/\b(400|404)\b/.test(msg)) return false;
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client for the identity-registry contract.
 *
 * @example
 * ```ts
 * import { IdentityClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const identity = new IdentityClient({ ...TESTNET_CONFIG, identityRegistryId: '...' });
 * const { did } = await identity.createDid(keypair, { email: 'a@b.c' });
 * ```
 */
export class IdentityClient extends BaseClient {
  constructor(config: SorobanIdentityConfig) {
    validateConfig(config, { contractIdField: "identityRegistryId" });
    super(config, config.identityRegistryId);
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
              "has_active_did",
              ...buildHasActiveDidArgs({ controller: PROBE_ADDRESS })
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
   * Create a new DID for the given keypair.
   *
   * @param keypair  The Stellar keypair whose public key will own the DID.
   * @param metadata Arbitrary `string → string` map embedded in the DID document.
   * @param options  Per-call overrides.
   * @returns The resolved DID and the estimated transaction fee.
   * @throws {SorobanIdentityError} with code `VALIDATION_ERROR` if a DID already exists.
   */
  async createDid(
    keypair: Keypair,
    metadata: Record<string, string> = {},
    options?: CallOptions
  ): Promise<SorobanResponse<{ did: string } & WriteResult>> {
    const account = await this.server.getAccount(keypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "create_did",
          ...buildCreateDidArgs({ controller: keypair.publicKey(), metadata })
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(keypair);

    const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
    this.debug('sdk.submission_outcome', { operation: 'identity.sendTransaction', status: result.status });
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    const txHash = result.hash;
    try {
      await pollTransactionStatus(this.server, txHash, {
        maxRetries: this.config.maxRetries ?? this.config.pollingRetries,
        retryIntervalMs: this.config.retryIntervalMs ?? this.config.pollingIntervalMs,
        exponentialBackoff: this.config.pollingExponentialBackoff,
      });
      const confirmed = await this.server.getTransaction(txHash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const did = scValToNative(confirmed.returnValue!) as string;
      return { data: { did, estimatedFee, estimatedFeeXlm }, txHash };
    } catch (e: unknown) {
      if (e instanceof SorobanIdentityError && e.code === "TIMEOUT") throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID already exists")) {
        throw new SorobanIdentityError(
          `A DID already exists for address ${keypair.publicKey()}. Each address can only have one DID.`,
          "VALIDATION_ERROR"
        );
      }
      throw wrapError(e);
    }
  }

  /**
   * Update metadata on an existing DID.
   *
   * @param keypair  Controller of the DID being updated.
   * @param metadata Replacement metadata map.
   * @param options  Per-call overrides.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` or `UNAUTHORIZED`.
   */
  async updateDid(
    keypair: Keypair,
    metadata: Record<string, string>,
    options?: CallOptions
  ): Promise<SorobanResponse<void>> {
    const account = await this.server.getAccount(keypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "update_did",
          ...buildUpdateDidArgs({ controller: keypair.publicKey(), metadata })
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
    prepared.sign(keypair);

    const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
    this.debug('sdk.submission_outcome', { operation: 'identity.sendTransaction', status: result.status });
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    const txHash = result.hash;
    try {
      await pollTransactionStatus(this.server, txHash, {
        maxRetries: this.config.maxRetries ?? this.config.pollingRetries,
        retryIntervalMs: this.config.retryIntervalMs ?? this.config.pollingIntervalMs,
        exponentialBackoff: this.config.pollingExponentialBackoff,
      });
    } catch (e: unknown) {
      if (e instanceof SorobanIdentityError && e.code === "TIMEOUT") throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID not found")) {
        throw new SorobanIdentityError(
          `No DID found for address ${keypair.publicKey()}. Create one first with createDid.`,
          "NOT_FOUND"
        );
      }
      if (msg.includes("require_auth") || msg.includes("not authorized")) {
        throw new SorobanIdentityError(
          `Address ${keypair.publicKey()} is not the controller of this DID.`,
          "UNAUTHORIZED"
        );
      }
      throw wrapError(e);
    }
    return { data: undefined, txHash };
  }

  /**
   * Resolve a DID document by controller address.
   *
   * @param controllerAddress The Stellar address that controls the DID.
   * @param options           Per-call overrides.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` if no DID exists.
   */
  async resolveDid(controllerAddress: string, options?: CallOptions): Promise<DidDocument> {
    validateStellarAddress(controllerAddress);
    const account = new Account(controllerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "resolve_did",
          ...buildResolveDidArgs({ controller: controllerAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const maxRetries = options?.maxRetries ?? this.config.maxRetries ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? this.config.baseDelayMs ?? 500;
    const backoffFactor = options?.backoffFactor ?? this.config.backoffFactor ?? 2;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.server.simulateTransaction(tx);
        const isSimulationError = SorobanRpc.Api.isSimulationError(result);
        this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
        if (isSimulationError) {
          const errMsg = result.error ?? "";
          const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
          if (contractErr) throw contractErr;
          if (errMsg.includes("DidDeactivated")) {
            throw new SorobanIdentityError(`DID for address ${controllerAddress} has been deactivated.`, "VALIDATION_ERROR");
          }
          if (errMsg.includes("DidNotFound")) {
            throw new SorobanIdentityError(`NOT_FOUND: No DID found for address ${controllerAddress}.`, "NOT_FOUND");
          }
          throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
        }
        const retval = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval;
        if (retval && typeof retval === "object" && "id" in (retval as unknown as Record<string, unknown>)) {
          return retval as unknown as DidDocument;
        }
        return scValToNative(retval) as DidDocument;
      } catch (err) {
        if (attempt === maxRetries || !isTransientRpcError(err)) throw err;
        lastError = err;
        const delayMs = Math.floor(baseDelayMs * Math.pow(backoffFactor, attempt) + Math.random() * 100);
        this.debug(`[identity] resolveDID retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`, {});
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  /**
   * Check if an address has an active (non-deactivated) DID.
   */
  async hasActiveDid(controllerAddress: string, options?: CallOptions): Promise<boolean> {
    validateStellarAddress(controllerAddress);
    const account = new Account(controllerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "has_active_did",
          ...buildHasActiveDidArgs({ controller: controllerAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Get the total count of active DIDs registered.
   */
  async getDidCount(options?: CallOptions): Promise<number> {
    const account = new Account(this.config.identityRegistryId, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("get_did_count"))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError("Failed to get DID count", "UNKNOWN");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as number;
  }

  /**
   * Deactivate the DID owned by `keypair`. Deactivation is irreversible.
   */
  async deactivateDid(keypair: Keypair): Promise<SorobanResponse<void>> {
    const isActive = await this.hasActiveDid(keypair.publicKey());
    if (!isActive) {
      throw new SorobanIdentityError(
        `DID for ${keypair.publicKey()} is already inactive or does not exist`,
        "VALIDATION_ERROR"
      );
    }

    const account = await this.server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "deactivate_did",
          ...buildDeactivateDidArgs({ controller: keypair.publicKey() })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(keypair);

    const result = await this.server.sendTransaction(prepared);
    this.debug('sdk.submission_outcome', { operation: 'identity.deactivateDid.sendTransaction', status: result.status });
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    const txHash = result.hash;
    await pollTransactionStatus(this.server, txHash, {
      maxRetries: this.config.maxRetries ?? this.config.pollingRetries,
      retryIntervalMs: this.config.retryIntervalMs ?? this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
    return { data: undefined, txHash };
  }

  /**
   * List DID documents with offset-based pagination.
   */
  async listDIDs(
    callerAddress: string,
    page = 1,
    pageSize = 20,
    options?: CallOptions
  ): Promise<DidDocument[]> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const offset = (Math.max(1, page) - 1) * pageSize;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "list_dids",
          nativeToScVal(offset, { type: "u32" }),
          nativeToScVal(pageSize, { type: "u32" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.listDIDs', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as DidDocument[];
  }

  /**
   * Get storage usage statistics for the identity registry.
   */
  async getStorageStats(callerAddress: string, options?: CallOptions): Promise<IdentityStorageStats> {
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
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as IdentityStorageStats;
  }

  /**
   * Resolve multiple DID documents in parallel.
   */
  async resolveMany(
    addresses: string[],
    options?: CallOptions & { concurrency?: number }
  ): Promise<DidDocument[]> {
    const concurrency = options?.concurrency ?? this.config.maxConcurrentRequests ?? 5;
    return runConcurrent(
      addresses,
      (address) => this.resolveDid(address, options),
      concurrency
    );
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
        "Health check failed: identity-registry not responding",
        "CONTRACT_ERROR"
      );
    }
    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as number;
  }
}
