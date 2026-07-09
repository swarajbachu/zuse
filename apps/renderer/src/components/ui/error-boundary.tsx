import { Component, type ReactNode } from "react";

type ErrorBoundaryProps = {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly resetKey?: string;
  readonly onError?: (error: Error, info: { componentStack?: string }) => void;
};

type ErrorBoundaryState = {
  readonly error: Error | null;
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(
    error: Error,
    info: { componentStack?: string },
  ): void {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error !== null) return this.props.fallback;
    return this.props.children;
  }
}
