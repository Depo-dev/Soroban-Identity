import { describe, it, expect } from "vitest";
import { SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { executeTransaction } from "./transaction";
import { SorobanIdentityError } from "./errors";

describe("executeTransaction confirmation timeout", () => {
  it("attaches the transaction hash to the thrown error so callers can avoid resubmission", async () => {
    const hash = "abc123deadbeef";

    const server = {
      prepareTransaction: async (tx: Transaction) => tx,
      sendTransaction: async () => ({ status: "PENDING", hash }),
      getTransaction: async () => ({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND }),
    } as unknown as SorobanRpc.Server;

    const tx = {} as Transaction;
    const signer = () => undefined;

    await expect(
      executeTransaction(server, tx, signer, { pollRetries: 1, pollInterval: 0 })
    ).rejects.toMatchObject({
      txHash: hash,
    });

    try {
      await executeTransaction(server, tx, signer, { pollRetries: 1, pollInterval: 0 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SorobanIdentityError);
      expect((err as SorobanIdentityError).txHash).toBe(hash);
      expect((err as SorobanIdentityError).code).toBe("TIMEOUT");
    }
  });
});
