import {
  Account,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import type {
  CallOptions,
  Page,
  PaginationOptions,
  ReputationRecord,
  ReputationStorageStats,
  ScoreHistoryEntry,
  SorobanIdentityConfig,
  SorobanResponse,
  WriteResult,
} from './types';
import { validateConfig } from './types';
import {
  retryWithBackoff,
  validateStellarAddress,
  pollTransactionStatus,
  runConcurrent,
} from './utils';
import { SorobanTransactionBuilder } from './transaction-builder';
import { ContractError, SorobanIdentityError } from "./errors";
import { REPUTATION_ERRORS } from './error-codes';
import { BaseClient } from './base-client';
import {
  buildGetReputationArgs,
  buildGetHistoryArgs,
  buildPassesSybilCheckDefaultArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
  buildListReportersArgs,
  buildListHistoryArgs,
} from './contract-args';

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

export interface ReputationRecord {
  subject: string;
  score: number;
  reporterCount: number;
  updatedAt: number;
}

export interface ScoreHistoryEntry {
  reporter: string;
  delta: number;
  reason: string;
  submittedAt: number;
}

/**
 * Client for the reputation contract.
 *
 * @example
 * ```ts
 * import { ReputationClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const reputation = new ReputationClient({ ...TESTNET_CONFIG, reputationId: '...' });
 * const ok = await reputation.passesSybilCheckDefault(caller, subject);
 * ```
 */
export class ReputationClient extends BaseClient {
  constructor(config: SorobanIdentityConfig) {
    validateConfig(config, { contractIdField: 'reputationId' });
    super(config, config.reputationId);
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
              'passes_sybil_check_default',
              ...buildPassesSybilCheckDefaultArgs({ subject: PROBE_ADDRESS })
            )
          )
          .setTimeout(10)
          .build();

        const result = await server.simulateTransaction(tx);
        this.debug('sdk.simulation_result', {
          operation: 'reputation.isInitialized',
          success: !SorobanRpc.Api.isSimulationError(result),
        });

        if (SorobanRpc.Api.isSimulationError(result)) {
          const err: string = (result as { error: string }).error ?? '';
          if (
            err.includes('not initialized') ||
            err.includes('NotInitialized') ||
            err.includes('#0')
          ) {
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
   * Get the list of all registered reporters.
   */
  async getReporters(
    callerAddress: string,
    options?: CallOptions
  ): Promise<string[]> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call('get_reporters_list'))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as string[];
  }

  /**
   * Get the aggregate reputation record for a subject.
   */
  async getReputation(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<ReputationRecord> {
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
          'get_reputation',
          ...buildGetReputationArgs({ subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg: string = (result as { error: string }).error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr?.code === 2) {
        return { subject: subjectAddress, score: 0, reporterCount: 0, updatedAt: 0 };
      }
      if (contractErr) throw contractErr;
      if (
        errMsg.includes('not found') ||
        errMsg.includes('no record') ||
        errMsg.includes('MissingValue') ||
        errMsg.includes('KeyNotFound')
      ) {
        return { subject: subjectAddress, score: 0, reporterCount: 0, updatedAt: 0 };
      }
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationRecord;
  }

  /**
   * Get score submission history for a subject from a specific reporter.
   *
   * @param fromTimestamp Optional minimum timestamp (Unix seconds).
   * @param toTimestamp   Optional maximum timestamp (Unix seconds).
   */
  async getScoreHistory(
    callerAddress: string,
    subjectAddress: string,
    reporterAddress: string,
    offset = 0,
    limit = 20,
    fromTimestamp?: number,
    toTimestamp?: number,
    options?: CallOptions
  ): Promise<ScoreHistoryEntry[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    validateStellarAddress(reporterAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'get_history',
          ...buildGetHistoryArgs({
            subject: subjectAddress,
            reporter: reporterAddress,
            offset,
            limit,
            fromTimestamp,
            toTimestamp,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ScoreHistoryEntry[];
  }

  /**
   * Check if a subject passes the sybil threshold using the contract's stored default.
   */
  async passesSybilCheckDefault(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<boolean> {
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
          'passes_sybil_check_default',
          ...buildPassesSybilCheckDefaultArgs({ subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as boolean;
  }

  /**
   * Check if a subject passes a caller-supplied sybil threshold.
   */
  async passesSybilCheck(
    callerAddress: string,
    subjectAddress: string,
    minScore: number,
    minReporters: number,
    options?: CallOptions
  ): Promise<boolean> {
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
          'passes_sybil_check',
          ...buildPassesSybilCheckArgs({ subject: subjectAddress, minScore: BigInt(minScore), minReporters })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as boolean;
  }

  /**
   * Submit a score delta for a subject. Caller must be a registered reporter.
   */
  async submitScore(
    reporterKeypair: Keypair,
    subjectAddress: string,
    delta: number,
    reason: string,
    options?: CallOptions
  ): Promise<SorobanResponse<WriteResult>> {
    const account = await this.server.getAccount(reporterKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const builder = new SorobanTransactionBuilder(account, this.config);
    builder.addContractCall(
      this.config.reputationId,
      'submit_score',
      ...buildSubmitScoreArgs({
        reporter: reporterKeypair.publicKey(),
        subject: subjectAddress,
        delta: BigInt(delta),
        reason,
      })
    );

    const tx = builder.build(timeout);
    const prepared = await retryWithBackoff(() =>
      this.server.prepareTransaction(tx)
    );
    this.debug('sdk.simulation_result', { operation: 'reputation.submitScore.prepare', success: true });
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(reporterKeypair);

    const result = await retryWithBackoff(() =>
      this.server.sendTransaction(prepared)
    );
    this.debug('sdk.submission_outcome', { operation: 'reputation.submitScore.send', status: result.status });
    if (result.status !== 'PENDING') {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, 'CONTRACT_ERROR');
    }

    const txHash = result.hash;
    await pollTransactionStatus(this.server, txHash, {
      maxRetries: this.config.maxRetries ?? this.config.pollingRetries,
      retryIntervalMs: this.config.retryIntervalMs ?? this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
    return { data: { estimatedFee, estimatedFeeXlm }, txHash };
  }

  /**
   * Fetch reputation records for multiple addresses in parallel.
   */
  async getScores(
    callerAddress: string,
    addresses: string[],
    options?: CallOptions & { concurrency?: number }
  ): Promise<ReputationRecord[]> {
    validateStellarAddress(callerAddress);
    const concurrency = options?.concurrency ?? this.config.maxConcurrentRequests ?? 5;
    return runConcurrent(
      addresses,
      (address) => this.getReputation(callerAddress, address, options),
      concurrency
    );
  }

  /**
   * Get storage usage statistics for the reputation contract.
   */
  async getStorageStats(
    callerAddress: string,
    options?: CallOptions
  ): Promise<ReputationStorageStats> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call('get_storage_stats'))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationStorageStats;
  }

  /**
   * Get one page of registered reporter addresses.
   */
  async listReporters(
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
          'list_reporters',
          ...buildListReportersArgs({ cursor: cursorArg, limit: options?.limit ?? 0 })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: string[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
  }

  /**
   * Get the current numeric score for a subject.
   */
  async getScore(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<number> {
    const record = await this.getReputation(callerAddress, subjectAddress, options);
    return record.score;
  }

  /**
   * Cursor-paginated score history for a subject/reporter pair.
   */
  async listScoreHistory(
    callerAddress: string,
    subjectAddress: string,
    reporterAddress: string,
    options?: PaginationOptions
  ): Promise<Page<ScoreHistoryEntry>> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    validateStellarAddress(reporterAddress);
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
          'list_history',
          ...buildListHistoryArgs({
            subject: subjectAddress,
            reporter: reporterAddress,
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
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: ScoreHistoryEntry[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
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
        "Health check failed: reputation contract not responding",
        "CONTRACT_ERROR"
      );
    }
    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as number;
  }
}
