import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DidQrCode, { buildDid, qrFileName } from './DidQrCode';

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

describe('buildDid', () => {
  it('prefixes the address with the stellar DID method', () => {
    expect(buildDid(ADDRESS)).toBe(`did:stellar:${ADDRESS}`);
  });
});

describe('qrFileName', () => {
  it('names the download after the DID it encodes', () => {
    expect(qrFileName(ADDRESS)).toBe(`did-stellar-${ADDRESS}.png`);
  });
});

describe('DidQrCode', () => {
  beforeEach(() => {
    stubClipboard();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a canvas QR code and the DID string in card mode', () => {
    const { container } = render(<DidQrCode address={ADDRESS} />);

    expect(container.querySelector('canvas')).not.toBeNull();
    expect(screen.getByTestId('did-qr-value').textContent).toBe(`did:stellar:${ADDRESS}`);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('prefers an explicitly supplied DID over one derived from the address', () => {
    render(<DidQrCode address={ADDRESS} did="did:stellar:CUSTOM" />);
    expect(screen.getByTestId('did-qr-value').textContent).toBe('did:stellar:CUSTOM');
  });

  it('copies the DID to the clipboard and confirms it', async () => {
    // userEvent.setup() installs its own clipboard stub, so replace it after.
    const user = userEvent.setup();
    const writeText = stubClipboard();

    render(<DidQrCode address={ADDRESS} />);
    await user.click(screen.getByRole('button', { name: /copy did to clipboard/i }));

    expect(writeText).toHaveBeenCalledWith(`did:stellar:${ADDRESS}`);
    await waitFor(() => {
      expect(screen.getByText(/DID copied to clipboard/i)).toBeTruthy();
    });
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    // Removed after setup(), which installs its own clipboard stub.
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    render(<DidQrCode address={ADDRESS} />);
    await user.click(screen.getByRole('button', { name: /copy did to clipboard/i }));

    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('downloads the QR code as a PNG named after the DID', async () => {
    const click = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: unknown) => {
      const element = realCreateElement(tag, options as ElementCreationOptions);
      if (tag === 'a') {
        Object.defineProperty(element, 'click', { value: click, configurable: true });
      }
      return element;
    });

    const { container } = render(<DidQrCode address={ADDRESS} />);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    // jsdom has no canvas backend, so stub the encoder the download relies on.
    Object.defineProperty(canvas!, 'toDataURL', {
      value: vi.fn().mockReturnValue('data:image/png;base64,AAAA'),
      configurable: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download qr code as png/i }));

    expect(click).toHaveBeenCalledTimes(1);
    const anchor = vi
      .mocked(document.createElement)
      .mock.results.map((result) => result.value)
      .find((element: HTMLElement) => element.tagName === 'A') as HTMLAnchorElement;
    expect(anchor.download).toBe(`did-stellar-${ADDRESS}.png`);
    expect(anchor.href).toContain('data:image/png');
  });

  it('surfaces an error instead of failing silently when PNG encoding fails', async () => {
    const { container } = render(<DidQrCode address={ADDRESS} />);
    Object.defineProperty(container.querySelector('canvas')!, 'toDataURL', {
      value: vi.fn().mockImplementation(() => {
        throw new Error('tainted canvas');
      }),
      configurable: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download qr code as png/i }));

    expect(screen.getByText(/could not generate the png/i)).toBeTruthy();
  });

  it('renders as a labelled modal dialog when asModal is set', () => {
    render(<DidQrCode address={ADDRESS} asModal onClose={() => {}} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('did-qr-title');
    expect(screen.getByRole('button', { name: /close qr code dialog/i })).toBeTruthy();
  });

  it('moves focus to the close button when the modal opens', async () => {
    render(<DidQrCode address={ADDRESS} asModal onClose={() => {}} />);

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /close qr code dialog/i }),
      );
    });
  });

  it('closes the modal on Escape, on the close button, and on backdrop click', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<DidQrCode address={ADDRESS} asModal onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /close qr code dialog/i }));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(3);

    unmount();
  });

  it('does not close when a click lands inside the dialog', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DidQrCode address={ADDRESS} asModal onClose={onClose} />);

    await user.click(screen.getByTestId('did-qr-value'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<DidQrCode address={ADDRESS} asModal onClose={() => {}} />);

    const buttons = screen.getAllByRole('button');
    const last = buttons[buttons.length - 1];
    last.focus();

    await user.tab();
    expect(buttons).toContain(document.activeElement);
  });

  it('ignores Escape in card mode', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DidQrCode address={ADDRESS} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
