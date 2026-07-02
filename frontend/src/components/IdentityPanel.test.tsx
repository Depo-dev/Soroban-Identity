/**
 * Tests for IdentityPanel — issue #336
 *
 * Verifies the DID segmented display:
 *   - DID renders as three visually distinct segments (did:stellar: prefix + identifier).
 *   - Full and short (mobile-truncated) identifier spans are rendered.
 *   - Copy button copies the full untruncated DID to clipboard.
 *   - The container carries a title attribute with the full DID for tooltip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import IdentityPanel from "./IdentityPanel";
import { WalletContext } from "../context/WalletContext";

// ─── Stub heavy SDK / network imports ──────────────────────────────────────

const MOCK_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

// Bypass address validation so the resolve flow is not blocked.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    StrKey: {
      ...actual.StrKey,
      isValidEd25519PublicKey: vi.fn().mockReturnValue(true),
    },
  };
});

const mockDidDoc = {
  id: `did:stellar:${MOCK_ADDRESS}`,
  controller: MOCK_ADDRESS,
  createdAt: 1700000000,
  updatedAt: 1700000000,
  metadata: {},
  active: true,
};

vi.mock("../../../sdk/src", () => ({
  IdentityClient: vi.fn().mockImplementation(() => ({
    resolveDid: vi.fn().mockResolvedValue(mockDidDoc),
  })),
  ReputationClient: vi.fn().mockImplementation(() => ({
    getReputation: vi.fn().mockResolvedValue(null),
    getScoreHistory: vi.fn().mockResolvedValue([]),
    passesSybilCheck: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock("../network", () => ({
  getNetworkConfig: vi.fn(() => ({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    identityRegistryId: "CTEST",
    credentialManagerId: "CTEST",
    reputationId: "CTEST",
  })),
}));

vi.mock("../hooks/useAddressHistory", () => ({
  useAddressHistory: vi.fn(() => ({
    history: [],
    addAddress: vi.fn(),
    clearHistory: vi.fn(),
  })),
}));

vi.mock("../utils/handleError", () => ({
  handleError: vi.fn((e: unknown) => String(e)),
  isNetworkError: vi.fn(() => false),
}));

vi.mock("../../../sdk/src/serializers", () => ({
  exportDidDocumentAsJsonLd: vi.fn(() => "{}"),
}));

vi.mock("../utils/formatDate", () => ({
  formatTimestamp: vi.fn((ts: number) => String(ts)),
}));

// ─── Clipboard mock ──────────────────────────────────────────────────────────

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.defineProperty(navigator, "clipboard", {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

// ─── Wallet context stub ─────────────────────────────────────────────────────

const disconnectedWallet = {
  connected: false,
  publicKey: null,
  connecting: false,
  txLoading: false,
  error: null,
  walletType: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signTransaction: vi.fn(),
  retry: vi.fn(),
  isConnecting: false,
  connectionError: null,
  retryCount: 0,
  networkPassphrase: "Test SDF Network ; September 2015",
};

function renderPanel(wallet = disconnectedWallet) {
  return render(
    <WalletContext.Provider value={wallet as any}>
      <IdentityPanel />
    </WalletContext.Provider>,
  );
}

// ─── Helper: resolve a DID through the panel UI ──────────────────────────────

async function resolveDid() {
  const input = screen.getByPlaceholderText(/Stellar address/i);
  fireEvent.change(input, { target: { value: MOCK_ADDRESS } });
  fireEvent.click(screen.getByRole("button", { name: /Resolve/i }));
  await waitFor(() => {
    const full = document.querySelector(".did-identifier-full");
    expect(full).not.toBeNull();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IdentityPanel — DID segmented display (#336)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboard.writeText.mockResolvedValue(undefined);
  });

  it("does not show DID display before a resolve has been performed", () => {
    renderPanel();
    expect(document.querySelector(".did-identifier-full")).toBeNull();
  });

  it("renders muted 'did:stellar:' prefix after resolving", async () => {
    renderPanel();
    await resolveDid();

    // The prefix span sits as a sibling before .did-identifier
    const wrapper = document.querySelector(".did-identifier")?.parentElement;
    expect(wrapper?.textContent).toContain("did:stellar:");
  });

  it("renders the full identifier in .did-identifier-full", async () => {
    renderPanel();
    await resolveDid();

    const fullEl = document.querySelector(".did-identifier-full");
    expect(fullEl?.textContent).toBe(MOCK_ADDRESS);
  });

  it("renders truncated identifier (first 8 + last 4) in .did-identifier-short", async () => {
    renderPanel();
    await resolveDid();

    const shortEl = document.querySelector(".did-identifier-short");
    expect(shortEl).not.toBeNull();
    const expected = `${MOCK_ADDRESS.slice(0, 8)}\u2026${MOCK_ADDRESS.slice(-4)}`;
    expect(shortEl?.textContent).toBe(expected);
  });

  it("DID container has title attribute with full did:stellar: string", async () => {
    renderPanel();
    await resolveDid();

    const titled = document.querySelector(`[title="did:stellar:${MOCK_ADDRESS}"]`);
    expect(titled).not.toBeNull();
  });

  it("copy button has accessible aria-label", async () => {
    renderPanel();
    await resolveDid();

    const copyBtn = screen.getByRole("button", { name: /Copy full DID to clipboard/i });
    expect(copyBtn).not.toBeNull();
  });

  it("copy button writes full DID to clipboard", async () => {
    renderPanel();
    await resolveDid();

    const copyBtn = screen.getByRole("button", { name: /Copy full DID to clipboard/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledWith(
        `did:stellar:${MOCK_ADDRESS}`,
      );
    });
  });

  it("copy button shows confirmation text after successful copy", async () => {
    renderPanel();
    await resolveDid();

    const copyBtn = screen.getByRole("button", { name: /Copy full DID to clipboard/i });
    fireEvent.click(copyBtn);

    // After click the button text should switch to the "Copied!" confirmation.
    await waitFor(() => {
      expect(copyBtn.textContent).toContain("Copied");
    });
  });
});
