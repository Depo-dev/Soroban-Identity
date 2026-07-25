import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { WalletProvider } from "./context/WalletContext";
import "./i18n";
import "./index.css";

// Initialize theme before React renders to prevent flicker
(function initializeTheme() {
  const THEME_STORAGE_KEY = 'theme-preference';
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as 'system' | 'light' | 'dark' | null;
  const html = document.documentElement;
  
  // Remove any existing theme classes
  html.classList.remove('light', 'dark');
  
  if (storedTheme === 'light') {
    html.classList.add('light');
  } else if (storedTheme === 'dark') {
    html.classList.add('dark');
  }
  // If theme is 'system' or null, we don't add any class - CSS media query handles it
  
  // Set data attribute for immediate access
  html.setAttribute('data-theme', storedTheme || 'system');
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WalletProvider>
        <App />
      </WalletProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
