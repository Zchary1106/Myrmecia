import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps { children: ReactNode }
interface AppErrorBoundaryState { error: Error | null }

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[dashboard] render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section role="alert" className="flex h-full min-h-[320px] items-center justify-center p-6">
        <div className="app-panel w-full max-w-lg p-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-300">!</div>
          <h2 className="mt-4 text-lg font-semibold text-app-primary">This view could not be rendered</h2>
          <p className="mt-2 text-sm leading-6 text-app-secondary">The rest of the workspace is still available. Reload this view to try again.</p>
          <button type="button" onClick={() => window.location.reload()} className="app-focus mt-5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-accent-light">Reload view</button>
          <p className="mt-4 break-words text-[10px] text-app-muted">{this.state.error.message}</p>
        </div>
      </section>
    );
  }
}
