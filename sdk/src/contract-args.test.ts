import { describe, it, expect } from "vitest";
import {
  buildIssueCredentialArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
} from "./contract-args";

const ADDRESS = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJ";

describe("contract-args numeric field validation", () => {
  it("buildIssueCredentialArgs rejects a negative expiresAt with a clear client-side error", () => {
    expect(() =>
      buildIssueCredentialArgs({
        issuer: ADDRESS,
        subject: ADDRESS,
        credentialType: "kyc" as any,
        claims: {},
        claimsHash: Buffer.alloc(32),
        signature: Buffer.alloc(64),
        expiresAt: -1n,
      })
    ).toThrow("encodeU64: expected a non-negative integer");
  });

  it("buildPassesSybilCheckArgs rejects an out-of-range minScore with a clear client-side error", () => {
    expect(() =>
      buildPassesSybilCheckArgs({
        subject: ADDRESS,
        minScore: 2n ** 100n,
        minReporters: 1,
      })
    ).toThrow();
  });

  it("buildSubmitScoreArgs rejects an out-of-range delta with a clear client-side error", () => {
    expect(() =>
      buildSubmitScoreArgs({
        reporter: ADDRESS,
        subject: ADDRESS,
        delta: -(2n ** 100n),
        reason: "test",
      })
    ).toThrow();
  });
});
