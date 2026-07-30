import { SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { SorobanIdentityError } from "./errors";

export interface TxOptions {
  pollInterval?: number;
  pollRetries?: number;
}

function isNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /econnrefused|enotfound|fetch failed|econnreset|etimedout/.test(msg);
}

function getRpcUrl(server: SorobanRpc.Server): string {
  return (server as unknown as { serverURL: string }).serverURL ?? "unknown";
}

export async function executeTransaction(
  server: SorobanRpc.Server,
  tx: Transaction,
  signer: (tx: Transaction) => void,
  options?: TxOptions
): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
  let prepared: Transaction;
  try {
    prepared = (await server.prepareTransaction(tx)) as Transaction;
  } catch (e) {
    if (isNetworkError(e)) {
      throw new SorobanIdentityError(
        `Cannot reach RPC endpoint: ${getRpcUrl(server)}`,
        { code: "NETWORK_ERROR", details: { cause: e } }
      );
    }
    throw e;
  }

  signer(prepared);

  let result: SorobanRpc.Api.SendTransactionResponse;
  try {
    result = await server.sendTransaction(prepared);
  } catch (e) {
    if (isNetworkError(e)) {
      throw new SorobanIdentityError(
        `Cannot reach RPC endpoint: ${getRpcUrl(server)}`,
        { code: "NETWORK_ERROR", details: { cause: e } }
      );
    }
    throw e;
  }

  if (result.status !== "PENDING") {
    throw new Error(`Transaction failed: ${result.status}`);
  }

  const retries = options?.pollRetries ?? 10;
  const interval = options?.pollInterval ?? 2000;

  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, interval));
    let status: SorobanRpc.Api.GetTransactionResponse;
    try {
      status = await server.getTransaction(result.hash);
    } catch (e) {
      if (isNetworkError(e)) {
        throw new SorobanIdentityError(
          `Cannot reach RPC endpoint: ${getRpcUrl(server)}`,
          { code: "NETWORK_ERROR", details: { cause: e } }
        );
      }
      throw e;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error("Transaction failed on-chain");
    }
  }
  throw new SorobanIdentityError(
    `Transaction confirmation timeout (hash: ${result.hash}). The transaction was broadcast and may still succeed — check its status via this hash before resubmitting.`,
    { code: "TIMEOUT", txHash: result.hash }
  );
}
