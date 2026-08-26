import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

const QR_SIZE = 220;

export type DidQrCodeProps = {
  /** Stellar address the DID is derived from. */
  address: string;
  /** Rendered when the DID string is already built elsewhere. */
  did?: string;
  /** Rendered as a card when false, as a modal dialog when true. */
  asModal?: boolean;
  /** Called when the modal is dismissed. Ignored in card mode. */
  onClose?: () => void;
};

/**
 * Build the shareable DID string for a Stellar address.
 */
export function buildDid(address: string): string {
  return `did:stellar:${address}`;
}

/**
 * Filename used for the downloaded QR image, scoped to the DID it encodes.
 */
export function qrFileName(address: string): string {
  return `did-stellar-${address}.png`;
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea on browsers
 * without the async clipboard API (or when the page is not a secure context).
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * QR code for a DID, with copy-to-clipboard and PNG download.
 *
 * Renders inline as a card by default, or as a focus-trapped modal dialog when
 * `asModal` is set.
 */
export default function DidQrCode({ address, did, asModal = false, onClose }: DidQrCodeProps) {
  const value = did ?? buildDid(address);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(value);
    setCopied(ok);
  }, [value]);

  const handleDownload = useCallback(() => {
    setDownloadError(null);
    const canvas = canvasWrapperRef.current?.querySelector('canvas');
    if (!canvas) {
      setDownloadError('QR code is not ready yet.');
      return;
    }
    try {
      const url = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = qrFileName(address);
      link.click();
    } catch {
      // toDataURL throws on a tainted canvas and in environments without a
      // canvas implementation; surface it rather than failing silently.
      setDownloadError('Could not generate the PNG in this browser.');
    }
  }, [address]);

  // Modal-only behaviour: dismiss on Escape and keep focus inside the dialog.
  useEffect(() => {
    if (!asModal) return;

    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [asModal, onClose]);

  const body = (
    <div ref={dialogRef} className="did-qr">
      <h3 id="did-qr-title" style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem' }}>
        DID QR Code
      </h3>

      <div
        ref={canvasWrapperRef}
        style={{
          display: 'inline-block',
          background: '#fff',
          padding: '0.75rem',
          borderRadius: '0.5rem',
        }}
      >
        <QRCodeCanvas
          value={value}
          size={QR_SIZE}
          level="M"
          marginSize={2}
        />
      </div>

      <p
        data-testid="did-qr-value"
        style={{
          margin: '0.75rem 0 0',
          fontSize: '0.8rem',
          wordBreak: 'break-all',
          color: 'var(--text-muted)',
        }}
      >
        {value}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={handleCopy} aria-label="Copy DID to clipboard">
          {copied ? '✓ Copied!' : '📋 Copy DID'}
        </button>
        <button type="button" onClick={handleDownload} aria-label="Download QR code as PNG">
          ⬇ Download PNG
        </button>
        {asModal && (
          <button type="button" ref={closeButtonRef} onClick={onClose} aria-label="Close QR code dialog">
            Close
          </button>
        )}
      </div>

      <p aria-live="polite" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', minHeight: '1rem' }}>
        {copied && <span style={{ color: 'var(--sybil-pass-text, green)' }}>DID copied to clipboard</span>}
        {downloadError && <span style={{ color: 'var(--danger-text, #721c24)' }}>{downloadError}</span>}
      </p>
    </div>
  );

  if (!asModal) {
    return (
      <div className="card" style={{ marginTop: '0.75rem', textAlign: 'center' }}>
        {body}
      </div>
    );
  }

  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="did-qr-title"
        className="card"
        style={{
          maxWidth: '360px',
          width: '100%',
          textAlign: 'center',
          background: 'var(--card-bg, #fff)',
        }}
      >
        {body}
      </div>
    </div>
  );
}

export { QR_SIZE };
