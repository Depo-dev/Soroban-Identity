import { SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { SorobanIdentityError } from "./errors";

export interface TxOptions {
  pollInterval?: number;
  pollRetries?: number;
}

export async function executeTransaction(
  server: SorobanRpc.Server,
  tx: Transaction,
  signer: (tx: Transaction) => void,
  options?: TxOptions
): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
  const prepared = await server.prepareTransaction(tx);
  signer(prepared as Transaction);

  const result = await server.sendTransaction(prepared);
  if (result.status !== "PENDING") {
    throw new Error(`Transaction failed: ${result.status}`);
  }

  const retries = options?.pollRetries ?? 10;
  const interval = options?.pollInterval ?? 2000;

  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, interval));
    const status = await server.getTransaction(result.hash);
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
