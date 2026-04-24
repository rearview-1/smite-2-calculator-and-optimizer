import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App render failure', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{
        minHeight: '100vh',
        background: '#090910',
        color: '#f3f3f5',
        padding: 24,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      }}>
        <div style={{
          maxWidth: 880,
          margin: '0 auto',
          border: '1px solid #2c2c38',
          padding: 16,
          background: '#11111a',
        }}>
          <div style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12, color: '#d94b4b' }}>
            Render error
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {this.state.error.message || 'Unknown UI error'}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: '#d94b4b',
              color: '#fff',
              border: 0,
              padding: '8px 12px',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
