import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Automatically unmount and clean up rendered components after each test.
// This is required when vitest globals are not enabled (they are not in this
// project — each function is imported explicitly).
afterEach(() => {
  cleanup();
});
