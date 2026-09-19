import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * WHY THIS EXISTS (2026-09-13).
 *
 * Until now this app had no error boundary anywhere. React's documented
 * behaviour when a render throws and nothing catches it is to unmount the
 * WHOLE tree — so one bad value in one cell of one row took the entire page
 * to a blank white screen, with the real error visible only in the browser
 * console, which nobody has open while they are sourcing cards.
 *
 * That is what "it crashes" means from the outside: no message, no row, no
 * way back except a reload, and nothing to tell anyone afterwards.
 *
 * This boundary changes two things and nothing else:
 *
 *   1. The failure is CONTAINED. Wrapped around each optional panel on the
 *      opportunity detail page, a panel that throws is replaced by a small
 *      notice and the rest of the card — the identity, the listing, the
 *      grade ladder, Previous/Next — keeps working, so a single bad card
 *      cannot stop a browsing loop.
 *
 *   2. The failure is REPORTABLE. The actual error message and the React
 *      component stack are printed on screen and can be copied in one
 *      click. A crash that can be quoted is a crash that can be fixed;
 *      a white screen is not.
 *
 * It deliberately does NOT retry automatically, swallow the error silently,
 * or invent a fallback value for whatever was missing. Showing a wrong
 * number in place of a crash would be worse than the crash.
 */

interface Props {
  /** What broke, in the user's words — e.g. "the photo check panel". */
  label: string;
  /** Changing this resets the boundary. Pass the opportunity id or the
   *  pathname so moving to the next card clears a stuck panel. */
  resetKey?: string | number;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still logged, so `wrangler tail`-style debugging and the browser
    // console keep the full picture.
    console.error(`[${this.props.label}]`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null, copied: false });
    }
  }

  private report(): string {
    const { error, componentStack } = this.state;
    return [
      `WHERE: ${this.props.label}`,
      `URL: ${typeof window !== "undefined" ? window.location.href : "(unknown)"}`,
      `WHEN: ${new Date().toISOString()}`,
      `ERROR: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      "",
      error?.stack ?? "(no stack)",
      "",
      "COMPONENT STACK:",
      componentStack ?? "(none)",
    ].join("\n");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-panel">
        <h3>Something in {this.props.label} failed to render.</h3>
        <p>
          The rest of the page is still working. Nothing was saved or changed by this — it is a display failure, not
          a data one.
        </p>
        <pre className="crash-detail">
          {error.name}: {error.message}
        </pre>
        <div className="deal-actions">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(this.report()).then(
                () => this.setState({ copied: true }),
                () => this.setState({ copied: false }),
              );
            }}
          >
            {this.state.copied ? "Copied" : "Copy the full error"}
          </button>
          <button type="button" onClick={() => this.setState({ error: null, componentStack: null, copied: false })}>
            Try again
          </button>
        </div>
        <details className="crash-stack">
          <summary>Full technical detail</summary>
          <pre>{this.report()}</pre>
        </details>
      </div>
    );
  }
}
