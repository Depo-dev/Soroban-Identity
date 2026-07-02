import React, { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * A single scalar key (e.g. the current `pathname` from the router).
   * When the value changes between renders while the boundary is in an error
   * state, the error is automatically cleared so the new route can render
   * normally.
   *
   * @example
   * // In a route-aware parent:
   * const location = useLocation();
   * <ErrorBoundary resetKey={location.pathname}>…</ErrorBoundary>
   */
  resetKey?: unknown;
  /**
   * When any value in this array changes between renders, the error boundary
   * clears its error state automatically. Pass a key that changes on navigation
   * (e.g. the current tab or route) so the fallback UI is dismissed when the
   * user moves away from the erroring view.
   */
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  componentDidUpdate(prevProps: Props) {
    if (!this.state.hasError) return;

    // Scalar resetKey: clear error when the key changes (e.g. route pathname).
    if (prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
      return;
    }

    // Array resetKeys: clear error when any element changes.
    const prevKeys = prevProps.resetKeys ?? [];
    const nextKeys = this.props.resetKeys ?? [];

    const changed =
      prevKeys.length !== nextKeys.length ||
      prevKeys.some((key, i) => key !== nextKeys[i]);

    if (changed) {
      this.setState({ hasError: false, error: null });
    }
  }

  resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            backgroundColor: "var(--bg-color, #f5f5f5)",
            color: "var(--text-color, #333)",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              backgroundColor: "var(--error-bg, #fee)",
              border: "1px solid var(--error-border, #fcc)",
              borderRadius: "0.5rem",
              padding: "2rem",
              maxWidth: "500px",
            }}
          >
            <h1 style={{ marginTop: 0, color: "var(--error-text, #c33)" }}>
              Oops! Something went wrong
            </h1>
            <p style={{ marginBottom: "1rem", fontSize: "0.95rem" }}>
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <button
              onClick={this.resetError}
              style={{
                padding: "0.6rem 1.2rem",
                backgroundColor: "var(--primary-color, #007bff)",
                color: "white",
                border: "none",
                borderRadius: "0.3rem",
                cursor: "pointer",
                fontSize: "1rem",
              }}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
