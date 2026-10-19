import { Component, type ErrorInfo, type ReactNode } from 'react'
import SettingsApp from '../settings/SettingsApp'

class SettingsErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[settings ui]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="pp-crash">
          <h1>设置台渲染失败</h1>
          <p>{this.state.error}</p>
          <button type="button" onClick={() => window.location.reload()}>
            重新打开
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function SettingsView(): JSX.Element {
  return (
    <SettingsErrorBoundary>
      <SettingsApp />
    </SettingsErrorBoundary>
  )
}
