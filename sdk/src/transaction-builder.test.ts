import { describe, it, expect } from "vitest";
import { Account, BASE_FEE, Keypair, Networks } from "@stellar/stellar-sdk";
import { SorobanTransactionBuilder } from "./transaction-builder";
import type { SorobanIdentityConfig } from "./types";

describe("SorobanTransactionBuilder default fee", () => {
  it("defaults to the BASE_FEE constant instead of a hardcoded literal", () => {
    const account = new Account(Keypair.random().publicKey(), "0");
    const config: SorobanIdentityConfig = {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
    } as SorobanIdentityConfig;

    const builder = new SorobanTransactionBuilder(account, config);
    const tx = builder.build();

    expect(tx.fee).toBe(BASE_FEE);
  });
});
