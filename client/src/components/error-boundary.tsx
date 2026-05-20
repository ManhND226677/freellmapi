import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[UI] Unhandled route error:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-destructive/30 bg-card p-5">
          <h2 className="text-sm font-medium text-destructive">Page failed to render</h2>
          <p className="mt-2 text-xs text-muted-foreground">{this.state.error.message}</p>
        </div>
      )
    }

    return this.props.children
  }
}
