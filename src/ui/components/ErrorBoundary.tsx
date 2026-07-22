import { Component, type ErrorInfo, type ReactNode } from "react";

import { cx } from "../cx";

import styles from "./ErrorBoundary.module.css";

interface Props {
  /** Names the boundary in the console log — which page crashed. */
  name: string;
  children: ReactNode;
  /**
   * "flight" pins the panel dark and adds the recording-continues line.
   * Use it only around the LIVE flight surface (App.tsx AppBody), where a
   * render throw must not read as "recording stopped". The idle Start
   * screen is ground UI. Defaults to "ground".
   */
  variant?: "ground" | "flight";
  /**
   * Changing this drops a shown fallback and re-renders the children —
   * an automatic retry when the route/section changes. Cheaper than a
   * `key` remount: healthy siblings are never torn down. See use sites.
   */
  resetKey?: unknown;
  /** Extra cleanup to run when the pilot taps Try again (optional). */
  onRetry?: () => void;
}

interface State {
  error: Error | null;
  // Mirror of the last resetKey we settled on, so getDerivedStateFromProps
  // can tell an actual route change from an ordinary re-render.
  resetKey: unknown;
}

/**
 * The app's single error boundary. Without one, a render throw in any page
 * unmounts the whole React tree to a white screen (PR #126 was one such
 * crash). Wrapped per page, a crash degrades to a contained, pilot-readable
 * panel with a retry, and every other page stays alive.
 *
 * Plain DOM, no Ionic: the same component wraps the flight surface, which
 * is Ionic-free by lint (src/ui/flight/**). Recording lives in the headless
 * engine (WAL-persisted, running regardless of React), so a boundary around
 * the flight surface is strictly safer than the unmount it replaces — the
 * flight fallback says so.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.name}]`,
      error,
      info.componentStack,
    );
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const flight = this.props.variant === "flight";
    return (
      <div className={cx(styles.panel, flight && styles.flight)} role="alert">
        <div className={styles.card}>
          <p className={styles.message}>Something went wrong.</p>
          {flight && (
            <p className={styles.note}>
              Recording continues in the background.
            </p>
          )}
          <button className={styles.retry} onClick={this.retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
