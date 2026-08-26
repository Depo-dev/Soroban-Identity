import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SorobanRpc } from "@stellar/stellar-sdk";
import IdentityPanel from "./components/IdentityPanel";
import CredentialsPanel from "./components/CredentialsPanel";
import WalletButton from "./components/WalletButton";
import ErrorBoundary from "./components/ErrorBoundary";
import Toast from "./components/Toast";
import { ToastProvider } from "./context/ToastContext";
import { useWallet } from "./hooks/useWallet";
import { useCredentialExpiryCheck } from "./hooks/useCredentialExpiryCheck";
import { useTheme, cycleTheme, getThemeIcon, getThemeLabel } from "./hooks/useTheme";
import {
  DEFAULT_NETWORK,
  NETWORK_CONFIGS,
  NETWORK_OPTIONS,
  isMainnet,
  type NetworkName,
} from "./network";
import { checkConnection, IdentityClient, CredentialClient, ReputationClient } from "../../sdk/src/index";
import { setLocale } from "./i18n";
import type { Credential } from "../../sdk/src/types";

const SUPPORTED_LOCALES: { code: string; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "es", label: "ES" },
];

export enum Tab {
  Identity = "identity",
  Credentials = "credentials",
}

const TAB_ORDER: Tab[] = [Tab.Identity, Tab.Credentials];

export default function App() {
  const [tab, setTab] = useState<Tab>(Tab.Identity);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [activeNetwork, setActiveNetwork] = useState<NetworkName>(DEFAULT_NETWORK);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const networkConfig = NETWORK_CONFIGS[activeNetwork];
  const wallet = useWallet(networkConfig);
  const [theme, setTheme, isDarkMode] = useTheme();
  const { t, i18n } = useTranslation();
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [uninitializedContracts, setUninitializedContracts] = useState<string[]>([]);

  // Check for verify query param on load
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const verifyParam = urlParams.get("verify");
    if (verifyParam) {
      setVerifyId(verifyParam);
      setTab(Tab.Credentials);
    }
  }, []);

  const onMainnet = isMainnet(activeNetwork);

  // Check RPC connection health on load
  useEffect(() => {
    const checkRpcHealth = async () => {
      const rpcUrl = Array.isArray(networkConfig.rpcUrl)
        ? networkConfig.rpcUrl[0]
        : networkConfig.rpcUrl;
      const server = new SorobanRpc.Server(rpcUrl);
      const healthy = await checkConnection(server);
      setIsConnected(healthy);
    };
    checkRpcHealth();
  }, [networkConfig.rpcUrl]);

  // Check contract initialization on load
  useEffect(() => {
    const checkInit = async () => {
      const identity = new IdentityClient(networkConfig);
      const credentials = new CredentialClient(networkConfig);
      const reputation = new ReputationClient(networkConfig);
      const [idOk, credOk, repOk] = await Promise.all([
        identity.isInitialized(),
        credentials.isInitialized(),
        reputation.isInitialized(),
      ]);
      const uninitialized: string[] = [];
      if (!idOk) uninitialized.push("Identity Registry");
      if (!credOk) uninitialized.push("Credential Manager");
      if (!repOk) uninitialized.push("Reputation");
      setUninitializedContracts(uninitialized);
    };
    checkInit();
  }, [networkConfig.rpcUrl]);

  // TODO: integrate SDK — replace with CredentialClient.getCredentialsBySubject() (see issue #226)
  const fetchCredentials = useCallback(
    async (_address: string): Promise<Credential[]> => {
      return [];
    },
    [],
  );

  const { notification, dismiss } = useCredentialExpiryCheck(
    wallet.publicKey,
    fetchCredentials,
  );

  const handleLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocale(e.target.value);
  };

  // WAI-ARIA tab pattern: Left/Right cycle, Home/End jump to the ends.
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TAB_ORDER.indexOf(tab);
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % TAB_ORDER.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = TAB_ORDER.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = TAB_ORDER[nextIndex];
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <ToastProvider>
      <Toast />
      <a className="skip-link" href="#main-content">
        {t("a11y.skipToContent")}
      </a>
      <div className="container">
      <header style={{ position: "relative" }}>
        <h1>{t("app.title")}</h1>
        <p>{t("app.subtitle")}</p>
        <div
          style={{
            position: "absolute",
            top: "1rem",
            right: 0,
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
          }}
        >
          {isConnected !== null && (
            <div
              role="status"
              aria-live="polite"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.4rem 0.8rem",
                borderRadius: "0.25rem",
                backgroundColor: isConnected
                  ? "var(--success-bg, #d4edda)"
                  : "var(--danger-bg, #f8d7da)",
                color: isConnected
                  ? "var(--success-text, #155724)"
                  : "var(--danger-text, #721c24)",
                fontSize: "0.85rem",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: isConnected ? "#28a745" : "#dc3545",
                }}
              />
              {isConnected ? t("app.networkOnline") : t("app.networkOffline")}
            </div>
          )}
          <select
            value={i18n.language}
            onChange={handleLocaleChange}
            aria-label={t("a11y.switchLanguage")}
            style={{ padding: "0.3rem 0.5rem", borderRadius: "0.25rem", fontSize: "0.85rem" }}
          >
            {SUPPORTED_LOCALES.map(({ code, label }) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <label className="network-switcher" htmlFor="network-select">
            <span>Network</span>
            <select
              id="network-select"
              value={activeNetwork}
              onChange={(e) => setActiveNetwork(e.target.value as NetworkName)}
            >
              {NETWORK_OPTIONS.map((network) => (
                <option key={network.name} value={network.name}>
                  {network.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="theme-toggle"
            onClick={() => setTheme(cycleTheme(theme))}
            aria-label={`Switch theme. Current: ${theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}`}
            title={`Theme: ${theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}`}
          >
            {getThemeIcon(theme, isDarkMode)} {getThemeLabel(theme, isDarkMode, t)}
          </button>
          <WalletButton wallet={wallet} />
        </div>
      </header>

      {uninitializedContracts.length > 0 && (
        <div
          role="alert"
          aria-label="Contract not initialized warning"
          style={{
            background: "var(--warning-bg, #fff3cd)",
            color: "var(--warning-text, #856404)",
            border: "1px solid var(--warning-border, #ffc107)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          <span aria-hidden="true">⚠</span> Contract not initialized: <strong>{uninitializedContracts.join(", ")}</strong>.
          Please run the deploy script and update your contract IDs.{" "}
          <a
            href="docs/architecture.md"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            Deployment guide
          </a>
        </div>
      )}

      {onMainnet && (
        <div
          role="alert"
          aria-label="Mainnet warning"
          style={{
            background: "var(--badge-red-bg)",
            color: "var(--badge-red-text)",
            border: "1px solid var(--badge-red-text)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">⚠</span> You are connected to Stellar <strong>mainnet</strong>. All actions submit real
          transactions and may incur on-chain fees.
        </div>
      )}

      {notification && !notification.dismissed && (
        <div
          role="alert"
          style={{
            background: "var(--warning-bg, #fff3cd)",
            color: "var(--warning-text, #856404)",
            border: "1px solid var(--warning-border, #ffc107)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "0.9rem",
          }}
        >
          <span>
            <span aria-hidden="true">⚠</span> {notification.count} credential
            {notification.count > 1 ? "s" : ""} expiring within 7 days
          </span>
          <button
            onClick={dismiss}
            aria-label={t("a11y.dismissNotification")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "1rem",
              color: "inherit",
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div
        className="tabs"
        role="tablist"
        aria-label={t("tabs.label")}
        onKeyDown={handleTabKeyDown}
      >
        {TAB_ORDER.map((name) => (
          <button
            key={name}
            id={`tab-${name}`}
            role="tab"
            type="button"
            className={`tab ${tab === name ? "active" : ""}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            // Roving tabindex: only the selected tab is in the tab order, and
            // the arrow keys move between tabs from there.
            tabIndex={tab === name ? 0 : -1}
            ref={(node) => {
              tabRefs.current[name] = node;
            }}
            onClick={() => setTab(name)}
          >
            {t(`tabs.${name}`)}
          </button>
        ))}
      </div>

      <main id="main-content" tabIndex={-1}>
        <ErrorBoundary>
          <div
            id={`panel-${Tab.Identity}`}
            role="tabpanel"
            aria-labelledby={`tab-${Tab.Identity}`}
            hidden={tab !== Tab.Identity}
          >
            {tab === Tab.Identity && <IdentityPanel />}
          </div>
          <div
            id={`panel-${Tab.Credentials}`}
            role="tabpanel"
            aria-labelledby={`tab-${Tab.Credentials}`}
            hidden={tab !== Tab.Credentials}
          >
            {tab === Tab.Credentials && <CredentialsPanel verifyId={verifyId} />}
          </div>
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
  );
}
