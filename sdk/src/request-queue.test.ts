import { describe, it, expect } from "vitest";
import { RequestQueue } from "./request-queue";

describe("RequestQueue retry-after handling", () => {
  it("honors a real Retry-After header (axios-style headers) over the exponential fallback", async () => {
    const queue = new RequestQueue(5, 1000);
    let attempts = 0;
    const start = Date.now();

    const fn = async () => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error("Request failed with status code 429");
        err.response = {
          status: 429,
          headers: { "retry-after": "0" },
        };
        throw err;
      }
      return "ok";
    };

    const result = await queue.enqueue(fn, 3);

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    // With Retry-After: 0, the retry should not wait for the exponential
    // backoff base delay (1000ms) — it should fire immediately.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("honors a real Retry-After header (fetch-style Headers object)", async () => {
    const queue = new RequestQueue(5, 1000);
    let attempts = 0;

    const fn = async () => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error("429 Too Many Requests");
        err.response = {
          status: 429,
          headers: new Headers({ "retry-after": "0" }),
        };
        throw err;
      }
      return "ok";
    };

    const result = await queue.enqueue(fn, 3);

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});
