import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; label?: string }
interface State { error: Error | null; attempt: number }

/** Contains render errors to one subtree. Retry remounts the children (fresh component instances, fresh effects). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Gitty UI error', error, info.componentStack);
  }

  private retry = () => this.setState(state => ({ error: null, attempt: state.attempt + 1 }));

  render() {
    const { error, attempt } = this.state;
    if (error) {
      return <div className="error-boundary" role="alert">
        <strong>{this.props.label ?? 'Something went wrong'}</strong>
        <p>{error.message || 'An unexpected error occurred while rendering.'}</p>
        <button type="button" className="secondary-button" onClick={this.retry}>Retry</button>
      </div>;
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}
