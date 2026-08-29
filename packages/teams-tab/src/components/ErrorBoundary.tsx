import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

export interface ErrorBoundaryProps {
  /** Human-readable name of the tab/section being guarded, used in the recovery message. */
  label: string;
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors in a single tab so one broken tab never takes down
 * the whole app with a blank white screen. Always shows a labelled recovery
 * action.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.container} role="alert">
          <p className={styles.title}>{this.props.label} couldn't load</p>
          <p className={styles.body}>
            Something went wrong while rendering this tab. Your other tabs are unaffected.
          </p>
          <button type="button" className={styles.retry} onClick={this.handleRetry}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
