import { useState, useCallback, useRef, useEffect } from "react";
import type { WalletType } from "../hooks/useWallet";
import { useWalletContext } from "../context/WalletContext";

export default function WalletButton() {
  const {
    connected,
    publicKey,
    connecting,
    txLoading,
    error,
    walletType,
    connect,
    disconnect,
  } = useWalletContext();
  const [showPicker, setShowPicker] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

  const handleSelect = (type: WalletType) => {
    setShowPicker(false);
    connect(type);
  };

  const handleCopyAddress = useCallback(async () => {
    if (!publicKey) return;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(publicKey);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = publicKey;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(textArea);
        }
        console.warn(
          "[WalletButton] Using fallback clipboard method for non-secure context",
        );
      }

      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch (err) {
      console.error("[WalletButton] Failed to copy address:", err);
    }
  }, [publicKey]);

  const handleSwitchAccount = useCallback(async () => {
    try {
      if (walletType === "freighter") {
        // Trigger Freighter's account picker
        await (window as any).freighter.setAllowedHosts(
          [(window as any).location.hostname],
          () => {}
        );
        // Disconnect and reconnect to trigger account picker
        disconnect();
        setTimeout(() => connect("freighter"), 100);
      } else if (walletType === "walletconnect") {
        // For WalletConnect, disconnect and reconnect
        disconnect();
        setTimeout(() => connect("walletconnect"), 100);
      }
      setShowDropdown(false);
    } catch (err) {
      console.error("[WalletButton] Failed to switch account:", err);
    }
  }, [walletType, disconnect, connect]);

  // Handle outside clicks and Escape key
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showDropdown]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "0.25rem",
        position: "relative",
      }}
    >
      {connected && publicKey ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", position: "relative" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            via {walletType === "walletconnect" ? "WalletConnect" : "Freighter"}
          </span>
          <button
            ref={triggerRef}
            onClick={() => setShowDropdown(!showDropdown)}
            disabled={txLoading}
            aria-haspopup="menu"
            aria-expanded={showDropdown}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              background: "transparent",
              border: "1px solid var(--border-input)",
              color: "var(--text)",
              padding: "0.3rem 0.7rem",
              borderRadius: "0.25rem",
              cursor: "pointer",
              fontSize: "0.85rem",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <span
              className="badge badge-green"
              title={publicKey}
              style={{ cursor: "default", padding: "0 0.3rem" }}
            >
              {short(publicKey)}
            </span>
            <span style={{ fontSize: "0.75rem" }}>▼</span>
          </button>

          {showDropdown && (
            <div
              ref={dropdownRef}
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 0.5rem)",
                right: 0,
                background: "var(--dropdown-bg)",
                border: "1px solid var(--border-input)",
                borderRadius: "0.5rem",
                padding: "0.5rem",
                display: "flex",
                flexDirection: "column",
                gap: "0",
                minWidth: "180px",
                zIndex: 10,
                boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
              }}
            >
              <button
                role="menuitem"
                onClick={() => {
                  handleCopyAddress();
                  setShowDropdown(false);
                }}
                style={{
                  justifyContent: "flex-start",
                  gap: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  background: "transparent",
                  border: "none",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  borderRadius: "0.25rem",
                  transition: "background-color 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {copyFeedback ? (
                  <>
                    <span>✓</span>
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <span>📋</span>
                    <span>Copy Address</span>
                  </>
                )}
              </button>

              <button
                role="menuitem"
                onClick={handleSwitchAccount}
                style={{
                  justifyContent: "flex-start",
                  gap: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  background: "transparent",
                  border: "none",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  borderRadius: "0.25rem",
                  transition: "background-color 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <span>🔄</span>
                <span>Switch Account</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  disconnect();
                  setShowDropdown(false);
                }}
                style={{
                  justifyContent: "flex-start",
                  gap: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  background: "transparent",
                  border: "none",
                  color: "var(--error-text)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  borderRadius: "0.25rem",
                  transition: "background-color 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--error-bg)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <span>🚪</span>
                <span>Disconnect</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <button
            onClick={() => setShowPicker((v) => !v)}
            disabled={connecting}
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>

          {showPicker && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 0.5rem)",
                right: 0,
                background: "var(--dropdown-bg)",
                border: "1px solid var(--border-input)",
                borderRadius: "0.5rem",
                padding: "0.5rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
                minWidth: "180px",
                zIndex: 10,
              }}
            >
              <button
                onClick={() => handleSelect("freighter")}
                style={{
                  justifyContent: "flex-start",
                  gap: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                🪐 Freighter
              </button>
              <button
                onClick={() => handleSelect("walletconnect")}
                style={{
                  justifyContent: "flex-start",
                  gap: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                🔗 WalletConnect
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <span style={{ fontSize: "0.75rem", color: "var(--error-text)" }}>
          {(() => {
            const msg =
              error instanceof Error
                ? error.message
                : typeof error === "string" && error
                  ? error
                  : "Wallet connection failed. Please try again.";
            return msg.toLowerCase().includes("freighter not found") ? (
              <>
                Freighter not installed.{" "}
                <a
                  href="https://freighter.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "var(--accent-light)",
                    textDecoration: "underline",
                  }}
                >
                  Install it here
                </a>
              </>
            ) : (
              msg
            );
          })()}
        </span>
      )}
    </div>
  );
}
