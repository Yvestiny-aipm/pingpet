import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { AGENT_ENVS } from '@shared/types'
import type { AgentEnv, AiTestResult, MonitoringEnvsKey, Settings, Snapshot } from '@shared/types'
import { api } from '../api'
import SettingsPrototype from '../prototype/SettingsPrototype'
import '../prototype/settings.css'
import { removeBackgroundFromDataUrl } from '../removeBackground'

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
        <div className="settings-proto-viewport" style={{ padding: 40, color: '#333', fontSize: 16 }}>
          设置台渲染失败：{this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}

export default function SettingsView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [scaleDraft, setScaleDraft] = useState<number | null>(null)
  const [packBusy, setPackBusy] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  const [aiTestBusy, setAiTestBusy] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<AiTestResult | null>(null)

  useEffect(() => {
    let disposed = false
    void api.getSnapshot().then((snap) => {
      if (!disposed) setSnapshot(snap)
    })
    const off = api.onSnapshot(setSnapshot)
    return () => {
      disposed = true
      off()
    }
  }, [])

  if (!snapshot) {
    return (
      <div className="settings-proto-viewport" style={{ display: 'grid', placeItems: 'center', color: '#555' }}>
        正在打开设置…
      </div>
    )
  }

  const { settings } = snapshot

  const patch = (partial: Partial<Settings>): void => {
    void api.updateSettings(partial).then(setSnapshot)
  }

  const toggleEnv = (key: MonitoringEnvsKey, current: AgentEnv[], env: AgentEnv): void => {
    const set = new Set(current)
    if (set.has(env)) set.delete(env)
    else set.add(env)
    const nextEnvs = AGENT_ENVS.filter((e) => set.has(e))
    patch({ [key]: nextEnvs } as Partial<Settings>)
  }

  const commitScale = (value = scaleDraft): void => {
    if (value === null) return
    setScaleDraft(null)
    if (value !== settings.petScale) patch({ petScale: value })
  }

  const displayScale = scaleDraft ?? settings.petScale

  const handleImportSkin = (): void => {
    setPackError(null)
    setPackBusy(true)
    void (async () => {
      try {
        const picked = await api.pickSkin()
        if (picked.kind === 'canceled') return
        if (picked.kind === 'error') {
          setPackError(picked.error || '导入失败')
          return
        }
        if (picked.kind === 'pack') {
          setSnapshot(picked.snapshot)
          return
        }
        if (picked.kind === 'petdex') {
          setSnapshot(picked.snapshot)
          return
        }
        let dataUrl = picked.dataUrl
        if (settings.autoRemoveBackground && picked.ext !== '.svg') {
          const cut = await removeBackgroundFromDataUrl(picked.dataUrl)
          if (cut) dataUrl = cut
        }
        const res = await api.savePetImage(dataUrl, picked.name)
        if (res.ok) setSnapshot(res.snapshot)
        else if (!res.canceled) setPackError(res.error || '导入失败')
      } catch (e) {
        setPackError(String(e))
      } finally {
        setPackBusy(false)
      }
    })()
  }

  const handleDeletePack = (petId: string, name: string): void => {
    if (!window.confirm(`确定删除皮肤包「${name}」吗？此操作不可撤销。`)) return
    setPackError(null)
    void api
      .deleteImportedPetPack(petId)
      .then(setSnapshot)
      .catch((e) => setPackError(String(e)))
  }

  type AiProviderChoice = 'anthropic' | 'siliconflow' | 'openai'
  const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
  const aiProviderChoice: AiProviderChoice =
    settings.aiProvider === 'anthropic'
      ? 'anthropic'
      : settings.aiOpenaiBaseUrl === SILICONFLOW_BASE_URL
        ? 'siliconflow'
        : 'openai'
  const applyAiProviderChoice = (choice: AiProviderChoice): void => {
    if (choice === 'anthropic') {
      patch({ aiProvider: 'anthropic' })
    } else if (choice === 'siliconflow') {
      patch({
        aiProvider: 'openai',
        aiOpenaiBaseUrl: SILICONFLOW_BASE_URL,
        aiOpenaiModel: settings.aiOpenaiModel || 'deepseek-ai/DeepSeek-V3.1'
      })
    } else {
      patch({
        aiProvider: 'openai',
        aiOpenaiBaseUrl:
          settings.aiOpenaiBaseUrl === SILICONFLOW_BASE_URL
            ? 'https://api.openai.com/v1'
            : settings.aiOpenaiBaseUrl
      })
    }
  }

  const handleTestAi = (): void => {
    setAiTestBusy(true)
    setAiTestResult(null)
    void api
      .testAiSummary()
      .then(setAiTestResult)
      .catch((e) => setAiTestResult({ ok: false, error: String(e) }))
      .finally(() => setAiTestBusy(false))
  }

  return (
    <SettingsErrorBoundary>
    <SettingsPrototype
      snapshot={snapshot}
      displayScale={displayScale}
      packBusy={packBusy}
      packError={packError}
      aiTestBusy={aiTestBusy}
      aiTestResult={aiTestResult}
      aiProviderChoice={aiProviderChoice}
      onPatch={patch}
      onSelectPet={(id) => void api.selectPet(id).then(setSnapshot)}
      onScaleDraft={setScaleDraft}
      onScaleCommit={commitScale}
      onImport={handleImportSkin}
      onReveal={() => void api.revealPetPacksFolder()}
      onDeletePack={handleDeletePack}
      onToggleEnv={toggleEnv}
      onTestAi={handleTestAi}
      onAiProviderChoice={applyAiProviderChoice}
      onResetPosition={() => void api.resetPetPosition()}
      onToggleVisible={() => void (settings.petVisible ? api.hidePet() : api.showPet())}
    />
    </SettingsErrorBoundary>
  )
}
