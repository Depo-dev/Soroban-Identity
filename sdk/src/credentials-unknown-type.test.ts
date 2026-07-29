import { describe, expect, it } from "vitest";
import { assertCredentialType, UnknownCredentialTypeError } from "./types";

describe("UnknownCredentialTypeError", () => {
  it("is thrown for unknown credential type variants", () => {
    expect(() => assertCredentialType("FutureVariant")).toThrowError(
      new UnknownCredentialTypeError("FutureVariant"),
    );
  });
});
