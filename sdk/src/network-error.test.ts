// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isNetworkError,
  wrapNetworkError,
  SorobanIdentityError,
  classifyError,
} from "./errors";
import { executeTransaction } from "./transaction";
import type { SorobanRpc, Transaction } from "@stellar/stellar-sdk";

// ── isNetworkError ────────────────────────────────────────────────────────────

describe("isNetworkError", () => {
  it.each([
    ["ECONNREFUSED", new Error("connect ECONNREFUSED 127.0.0.1:8000")],
    ["ENOTFOUND", new Error("getaddrinfo ENOTFOUND soroban.example.com")],
    ["ECONNRESET", new Error("read ECONNRESET")],
    ["ETIMEDOUT", new Error("connect ETIMEDOUT")],
    ["fetch failed", new Error("fetch failed")],
    ["network error", new Error("network error")],
    ["FetchError name", Object.assign(new Error("oops"), { name: "FetchError" })],
    ["TypeError fetch", Object.assign(new Error("fetch is not defined"), { name: "TypeError" })],
    ["socket hang up", new Error("socket hang up")],
  ])("returns true for %s", (_, err) => {
    expect(isNetworkError(err)).toBe(true);
  });

  it.each([
    ["contract error", new Error("Error(Contract, #3)")],
    ["simulation failed", new Error("simulation failed: missing field")],
    ["SorobanIdentityError", new SorobanIdentityError("oops", "UNKNOWN")],
    ["plain string", "some string error"],
    ["null", null],
  ])("returns false for %s", (_, err) => {
    expect(isNetworkError(err)).toBe(false);
  });
});

// ── wrapNetworkError ──────────────────────────────────────────────────────────

describe("wrapNetworkError", () => {
  it("throws SorobanIdentityError with NETWORK_ERROR code on connection refused", () => {
    const raw = new Error("connect ECONNREFUSED 127.0.0.1:8000");
    expect(() => wrapNetworkError(raw, "http://localhost:8000", "simulateTransaction"))
      .toThrow(SorobanIdentityError);

    try {
      wrapNetworkError(raw, "http://localhost:8000", "simulateTransaction");
    } catch (e) {
      const err = e as SorobanIdentityError;
      expect(err.code).toBe("NETWORK_ERROR");
      expect(err.message).toContain("http://localhost:8000");
      expect(err.message).toContain("simulateTransaction");
      expect(err.details?.cause).toBe(raw);
      expect(err.details?.rpcUrl).toBe("http://localhost:8000");
      expect(err.details?.context).toBe("simulateTransaction");
    }
  });

  it("includes RPC URL in the error message", () => {
    const raw = new Error("fetch failed");
    try {
      wrapNetworkError(raw, "https://soroban-testnet.stellar.org");
    } catch (e) {
      expect((e as SorobanIdentityError).message).toContain("https://soroban-testnet.stellar.org");
    }
  });

  it("attaches the original error as details.cause", () => {
    const raw = Object.assign(new Error("oops"), { name: "FetchError" });
    try {
      wrapNetworkError(raw, "http://rpc.example.com");
    } catch (e) {
      expect((e as SorobanIdentityError).details?.cause).toBe(raw);
      expect((e as SorobanIdentityError).originalError).toBe(raw);
    }
  });

  it("passes through SorobanIdentityError unchanged", () => {
    const already = new SorobanIdentityError("already wrapped", "CONTRACT_ERROR");
    expect(() => wrapNetworkError(already, "http://rpc.example.com"))
      .toThrowError(already);
  });

  it("re-throws non-network errors unchanged", () => {
    const contractErr = new Error("Error(Contract, #3)");
    expect(() => wrapNetworkError(contractErr, "http://rpc.example.com"))
      .toThrow(contractErr);
    try {
      wrapNetworkError(contractErr, "http://rpc.example.com");
    } catch (e) {
      // Must NOT be wrapped in SorobanIdentityError — stays as original Error
      expect(e).toBe(contractErr);
      expect(e).not.toBeInstanceOf(SorobanIdentityError);
    }
  });

  it("works without a context label", () => {
    const raw = new Error("ECONNREFUSED");
    try {
      wrapNetworkError(raw, "http://localhost:8000");
    } catch (e) {
      expect((e as SorobanIdentityError).code).toBe("NETWORK_ERROR");
    }
  });
});

// ── classifyError integration ─────────────────────────────────────────────────

describe("classifyError NETWORK_ERROR cases", () => {
  it.each([
    "connect ECONNREFUSED 127.0.0.1:8000",
    "getaddrinfo ENOTFOUND soroban.example.com",
    "fetch failed",
    "network error occurred",
  ])("classifies '%s' as NETWORK_ERROR", (msg) => {
    expect(classifyError(msg)).toBe("NETWORK_ERROR");
  });

  it("classifies ECONNRESET as NETWORK_ERROR via classifyError", () => {
    expect(classifyError("read ECONNRESET")).toBe("NETWORK_ERROR");
  });
});

// ── executeTransaction network error wrapping ─────────────────────────────────

describe("executeTransaction — network error wrapping", () => {
  function makeServer(rpcUrl: string, overrides: Partial<SorobanRpc.Server> = {}) {
    return {
      serverURL: rpcUrl,
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      ...overrides,
    } as unknown as SorobanRpc.Server;
  }

  const mockTx = {} as Transaction;
  const mockSigner = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it("wraps ECONNREFUSED from prepareTransaction as NETWORK_ERROR", async () => {
    const server = makeServer("http://localhost:8000", {
      prepareTransaction: vi.fn().mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:8000")
      ),
    });

    await expect(executeTransaction(server, mockTx, mockSigner))
      .rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: expect.stringContaining("localhost:8000"),
      });
  });

  it("wraps FetchError from sendTransaction as NETWORK_ERROR", async () => {
    const fetchErr = Object.assign(new Error("fetch failed"), { name: "FetchError" });
    const server = makeServer("https://soroban-testnet.stellar.org", {
      prepareTransaction: vi.fn().mockResolvedValue(mockTx),
      sendTransaction: vi.fn().mockRejectedValue(fetchErr),
    });

    await expect(executeTransaction(server, mockTx, mockSigner))
      .rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: expect.stringContaining("soroban-testnet.stellar.org"),
      });
  });

  it("attaches original error as details.cause", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8000");
    const server = makeServer("http://localhost:8000", {
      prepareTransaction: vi.fn().mockRejectedValue(cause),
    });

    try {
      await executeTransaction(server, mockTx, mockSigner);
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as SorobanIdentityError;
      expect(err.details?.cause).toBe(cause);
      expect(err.originalError).toBe(cause);
    }
  });

  it("wraps ECONNREFUSED from getTransaction polling as NETWORK_ERROR", async () => {
    const server = makeServer("http://localhost:8000", {
      prepareTransaction: vi.fn().mockResolvedValue(mockTx),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "abc123" }),
      getTransaction: vi.fn().mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:8000")
      ),
    });

    await expect(
      executeTransaction(server, mockTx, mockSigner, { pollRetries: 1, pollInterval: 0 })
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("does NOT wrap contract errors — they pass through unchanged", async () => {
    const contractErr = new Error("Error(Contract, #3)");
    const server = makeServer("http://localhost:8000", {
      prepareTransaction: vi.fn().mockRejectedValue(contractErr),
    });

    try {
      await executeTransaction(server, mockTx, mockSigner);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe(contractErr);
      expect(e).not.toBeInstanceOf(SorobanIdentityError);
    }
  });

  it("includes context label 'prepareTransaction' in error message", async () => {
    const server = makeServer("http://localhost:8000", {
      prepareTransaction: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });

    await expect(executeTransaction(server, mockTx, mockSigner))
      .rejects.toMatchObject({
        message: expect.stringContaining("prepareTransaction"),
      });
  });
});
