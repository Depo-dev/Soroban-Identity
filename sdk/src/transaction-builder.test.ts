import { describe, it, expect, vi } from "vitest";
import { Account, BASE_FEE, Contract, Keypair, Networks, xdr } from "@stellar/stellar-sdk";
import { SorobanTransactionBuilder } from "./transaction-builder";
import type { SorobanIdentityConfig } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuilder() {
  const account = new Account(Keypair.random().publicKey(), "0");
  const config: SorobanIdentityConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  } as SorobanIdentityConfig;
  return new SorobanTransactionBuilder(account, config);
}

/** Synthetic no-op operation for testing multi-op accumulation. */
function makeOp(): xdr.Operation {
  // bumpSequence is a lightweight op available in stellar-sdk that doesn't
  // need a contract and satisfies the xdr.Operation type.
  return xdr.Operation.fromXDR(
    xdr.Operation.bumpSequence({ bumpTo: xdr.SequenceNumber.fromString("9999999") }).toXDR(),
    "raw",
  );
}

// ---------------------------------------------------------------------------

describe("SorobanTransactionBuilder default fee", () => {
  it("defaults to the BASE_FEE constant instead of a hardcoded literal", () => {
    const builder = makeBuilder();
    const tx = builder.addOperation(makeOp()).build();
    expect(tx.fee).toBe(BASE_FEE);
  });
});

// ---------------------------------------------------------------------------
// Issue #477 — estimateFee must reflect accumulated multi-operation state
// ---------------------------------------------------------------------------

describe("SorobanTransactionBuilder.estimateFee (#477)", () => {
  it("builds a single-op tx when the builder is empty (fallback path)", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");

    // Capture the tx passed to simulateTransaction so we can inspect its ops.
    let capturedTx: any = null;
    const mockServer = {
      simulateTransaction: vi.fn(async (tx: any) => {
        capturedTx = tx;
        return { minResourceFee: "100" };
      }),
    };
    vi.spyOn(SorobanRpc, "Server" as any).mockImplementation(() => mockServer);

    const builder = makeBuilder(); // no ops accumulated
    const op = makeOp();
    await builder.estimateFee(op);

    expect(capturedTx).not.toBeNull();
    expect(capturedTx.operations).toHaveLength(1);

    vi.restoreAllMocks();
  });

  it("uses accumulated operations instead of the single argument (#477)", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");

    let capturedTx: any = null;
    const mockServer = {
      simulateTransaction: vi.fn(async (tx: any) => {
        capturedTx = tx;
        return { minResourceFee: "300" };
      }),
    };
    vi.spyOn(SorobanRpc, "Server" as any).mockImplementation(() => mockServer);

    const builder = makeBuilder();
    // Accumulate 3 operations on the builder.
    builder.addOperation(makeOp()).addOperation(makeOp()).addOperation(makeOp());

    // Pass a fourth "dummy" op — it must NOT appear in the simulated tx.
    const dummyOp = makeOp();
    const estimate = await builder.estimateFee(dummyOp);

    // The simulated transaction must contain all 3 accumulated ops,
    // not just the single argument passed to estimateFee.
    expect(capturedTx).not.toBeNull();
    expect(capturedTx.operations).toHaveLength(3);

    // Fee must be built from the simulation result, not re-computed for 1 op.
    const baseFee = parseInt(BASE_FEE, 10);
    expect(estimate.resourceFee).toBe(300);
    expect(estimate.totalFee).toBe(baseFee + 300);

    vi.restoreAllMocks();
  });

  it("fee estimate scales with operation count (single vs multi)", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");

    // Simulate a server that charges 100 minResourceFee per operation.
    const mockServer = {
      simulateTransaction: vi.fn(async (tx: any) => ({
        minResourceFee: String(tx.operations.length * 100),
      })),
    };
    vi.spyOn(SorobanRpc, "Server" as any).mockImplementation(() => mockServer);

    const singleBuilder = makeBuilder();
    const singleEstimate = await singleBuilder.estimateFee(makeOp());

    const multiBuilder = makeBuilder();
    multiBuilder.addOperation(makeOp()).addOperation(makeOp()).addOperation(makeOp());
    const multiEstimate = await multiBuilder.estimateFee(makeOp());

    // Multi-op estimate must exceed single-op estimate.
    expect(multiEstimate.totalFee).toBeGreaterThan(singleEstimate.totalFee);
    // And must reflect all 3 accumulated ops (300 resource fee vs 100).
    expect(multiEstimate.resourceFee).toBe(300);
    expect(singleEstimate.resourceFee).toBe(100);

    vi.restoreAllMocks();
  });
});
