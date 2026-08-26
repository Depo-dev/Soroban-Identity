/**
 * Accessibility tests for the App shell — issue #643.
 *
 * Covers the skip-to-content link, the main landmark, and the WAI-ARIA tab
 * pattern (roles, selection state, roving tabindex, and arrow-key navigation).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import App from './App';

// ─── Stub heavy SDK / network imports ──────────────────────────────────────

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    SorobanRpc: { Server: vi.fn().mockImplementation(() => ({})) },
  };
});

vi.mock('../../sdk/src/index', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  IdentityClient: vi.fn().mockImplementation(() => ({
    isInitialized: vi.fn().mockResolvedValue(true),
  })),
  CredentialClient: vi.fn().mockImplementation(() => ({
    isInitialized: vi.fn().mockResolvedValue(true),
  })),
  ReputationClient: vi.fn().mockImplementation(() => ({
    isInitialized: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('./components/IdentityPanel', () => ({
  default: () => <div data-testid="identity-panel">Identity</div>,
}));

vi.mock('./components/CredentialsPanel', () => ({
  default: () => <div data-testid="credentials-panel">Credentials</div>,
}));

vi.mock('./components/WalletButton', () => ({
  default: () => <button type="button">Connect Wallet</button>,
}));

vi.mock('./hooks/useWallet', () => ({
  useWallet: () => ({ connected: false, publicKey: null }),
}));

vi.mock('./hooks/useCredentialExpiryCheck', () => ({
  useCredentialExpiryCheck: () => ({ notification: null, dismiss: vi.fn() }),
}));

describe('App accessibility', () => {
  it('renders a skip link that targets the main landmark', () => {
    render(<App />);

    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    expect(skipLink.getAttribute('href')).toBe('#main-content');

    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.id).toBe('main-content');
    // Focusable programmatically so the skip link actually moves focus.
    expect(main!.getAttribute('tabindex')).toBe('-1');
  });

  it('reaches the skip link with the very first Tab press', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /skip to main content/i }));
  });

  it('exposes the section switcher as a labelled tablist', () => {
    render(<App />);

    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('aria-label')).toBeTruthy();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBeTruthy();
    }
  });

  it('marks exactly one tab selected and links it to its panel', () => {
    render(<App />);

    const tabs = screen.getAllByRole('tab');
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);

    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected[0].id);
    expect(panel.id).toBe(selected[0].getAttribute('aria-controls'));
  });

  it('keeps only the selected tab in the tab order (roving tabindex)', () => {
    render(<App />);

    const tabs = screen.getAllByRole('tab');
    const inOrder = tabs.filter((tab) => tab.getAttribute('tabindex') === '0');
    expect(inOrder).toHaveLength(1);
    expect(inOrder[0].getAttribute('aria-selected')).toBe('true');
  });

  it('moves between tabs with the arrow keys and wraps around', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [identityTab, credentialsTab] = screen.getAllByRole('tab');
    identityTab.focus();

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(credentialsTab.getAttribute('aria-selected')).toBe('true');
    });
    expect(document.activeElement).toBe(credentialsTab);

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(identityTab.getAttribute('aria-selected')).toBe('true');
    });

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(credentialsTab.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [identityTab, credentialsTab] = screen.getAllByRole('tab');
    identityTab.focus();

    await user.keyboard('{End}');
    await waitFor(() => {
      expect(credentialsTab.getAttribute('aria-selected')).toBe('true');
    });

    await user.keyboard('{Home}');
    await waitFor(() => {
      expect(identityTab.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('activates a tab on click and hides the other panel', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [, credentialsTab] = screen.getAllByRole('tab');
    await user.click(credentialsTab);

    await waitFor(() => {
      expect(screen.getByTestId('credentials-panel')).toBeTruthy();
    });
    expect(screen.queryByTestId('identity-panel')).toBeNull();

    // The inactive panel stays in the DOM but hidden, so its labelling
    // relationship survives without being announced.
    const panels = document.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(2);
    expect(Array.from(panels).filter((panel) => !panel.hasAttribute('hidden'))).toHaveLength(1);
  });

  it('hides decorative glyphs and status dots from screen readers', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });

    const dot = screen.getByRole('status').querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });

    const results = await axe.run(container, {
      // Colour contrast needs real layout and computed styles, which jsdom
      // does not provide; it is verified against the running app instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.html),
      })),
    ).toEqual([]);
  });
});
