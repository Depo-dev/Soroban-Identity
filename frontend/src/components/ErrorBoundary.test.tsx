/**
 * Unit tests for ErrorBoundary — issue #331
 *
 * Verifies:
 *  - Fallback UI is shown when a child throws during render.
 *  - Changing `resetKey` while in error state clears the boundary.
 *  - Re-entering the same broken route (same resetKey) does NOT clear the
 *    error — it stays caught.
 *  - The Retry button manually resets the boundary.
 *  - The `resetKeys` array prop still works as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React, { Component, ReactNode } from "react";
import ErrorBoundary from "./ErrorBoundary";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A component that throws on the first render. */
function BrokenComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("test render error");
  return <div>Healthy content</div>;
}

/** Suppress expected React error output during tests. */
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ErrorBoundary (#331)", () => {
  it("renders children normally when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <div>Normal content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Normal content")).toBeTruthy();
  });

  it("shows fallback UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
  });

  it("does not show fallback when child does not throw", () => {
    render(
      <ErrorBoundary>
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.getByText("Healthy content")).toBeTruthy();
  });

  it("clears error state when resetKey changes — simulates navigation", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/broken-route">
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Boundary should be showing the fallback.
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();

    // Simulate navigating to a different route — reset key changes, child is
    // now healthy.
    rerender(
      <ErrorBoundary resetKey="/new-route">
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.getByText("Healthy content")).toBeTruthy();
  });

  it("does NOT clear error when the same resetKey is re-passed", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/broken-route">
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();

    // Same key — should still show fallback.
    rerender(
      <ErrorBoundary resetKey="/broken-route">
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
  });

  it("re-catches an error when re-entering the same broken route after navigation", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/broken-route">
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();

    // Navigate away — boundary should clear.
    rerender(
      <ErrorBoundary resetKey="/good-route">
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();

    // Navigate back to the broken route — error is re-caught.
    rerender(
      <ErrorBoundary resetKey="/broken-route">
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
  });

  it("Retry button manually resets the boundary", () => {
    const { rerender, container } = render(
      <ErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Confirm the fallback is shown.
    expect(container.querySelector("h1")).not.toBeNull();

    // Click Retry — then immediately rerender with a healthy child.
    const { getByRole: getByRoleInContainer } = within(container);
    fireEvent.click(getByRoleInContainer("button", { name: /retry/i }));

    rerender(
      <ErrorBoundary>
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );

    // The fallback h1 should be gone and healthy content visible.
    expect(container.textContent).toContain("Healthy content");
  });

  it("resetKeys array prop still clears error when an element changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={["/route-a"]}>
        <BrokenComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();

    rerender(
      <ErrorBoundary resetKeys={["/route-b"]}>
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.getByText("Healthy content")).toBeTruthy();
  });
});
