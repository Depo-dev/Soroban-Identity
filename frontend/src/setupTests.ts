import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Automatically unmount and clean up rendered components after each test.
// This is required when vitest globals are not enabled (they are not in this
// project — each function is imported explicitly).
afterEach(() => {
  cleanup();
});

// jsdom does not implement matchMedia, which useTheme reads on mount. Provide a
// non-matching stub so components under test can render.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
