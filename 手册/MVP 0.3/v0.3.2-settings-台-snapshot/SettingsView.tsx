import { useEffect, useState } from 'react'
import { PET_SCALE_MAX, PET_SCALE_MIN } from '@shared/defaults'
import type { AgentEventKind, AgentSource, Settings, Snapshot } from '@shared/types'
import { api } from '../api'
import PetSprite from './PetSprite'

const FREQUENCY_OPTIONS = [
  { value: 60, label: '大约每 1 分钟' },
  { value: 180, label: '大约每 3 分钟' },
  { value: 300, label: '大约每 5 分钟' },
  { value: 600, label: '大约每 10 分钟' }
] as const

const AGENT_KIND_LABEL: Record<AgentEventKind, string> = {
  working: '处理中',
  done: '输出结束·完成',
  needs_attention: '停下·需要你',
  failed: '停下·出错/中断'
}

const AGENT_SOURCE_LABEL: Record<AgentSource, string> = {
  codex: 'Codex',
  claude: 'Claude Code'
}

const SIMULATE_BUTTONS: Array<{ source: AgentSource; kind: AgentEventKind; label: string }> = [
  { source: 'codex', kind: 'working', label: '模拟 处理中（只切思考视觉·不弹气泡）' },
  { source: 'claude', kind: 'done', label: '模拟 输出结束·完成' },
  { source: 'claude', kind: 'needs_attention', label: '模拟 停下·需要你处理' },
  { source: 'claude', kind: 'failed', label: '模拟 停下·出错中断' }
]

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

type TabKey = 'pet' | 'bubble' | 'agent' | 'about'

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'pet', label: '桌宠', icon: '🐾' },
  { key: 'bubble', label: '气泡', icon: '💬' },
  { key: 'agent', label: 'Agent', icon: '🛰️' },
  { key: 'about', label: '关于', icon: 'ℹ️' }
]

export default function SettingsView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [scaleDraft, setScaleDraft] = useState<number | null>(null)
  // v0.3：皮肤包导入的进行中 / 错误提示
  const [packBusy, setPackBusy] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  // v0.3.2：左侧导航当前选中的分组
  const [tab, setTab] = useState<TabKey>('pet')

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
    return <div className="settings" />
  }

  const { settings, pets, appVersion, agent, isPackaged } = snapshot

  const patch = (partial: Partial<Settings>): void => {
    void api.updateSettings(partial).then(setSnapshot)
  }

  const commitScale = (value = scaleDraft): void => {
    if (value === null) return
    setScaleDraft(null)
    if (value !== settings.petScale) patch({ petScale: value })
  }

  const displayScale = scaleDraft ?? settings.petScale

  // v0.3：导入皮肤包文件夹
  const handleImportPack = (): void => {
    setPackError(null)
    setPackBusy(true)
    void api
      .importPetPack()
      .then((res) => {
        if (res.ok) setSnapshot(res.snapshot)
        else if (!res.canceled) setPackError(res.error || '导入失败')
      })
      .catch((e) => setPackError(String(e)))
      .finally(() => setPackBusy(false))
  }

  // v0.3：删除一个已导入皮肤包
  const handleDeletePack = (petId: string, name: string): void => {
    if (!window.confirm(`确定删除皮肤包「${name}」吗？此操作不可撤销。`)) return
    setPackError(null)
    void api
      .deleteImportedPetPack(petId)
      .then(setSnapshot)
      .catch((e) => setPackError(String(e)))
  }

  const selectedPet = pets.find((p) => p.id === settings.selectedPetId) ?? pets[0]

  return (
    <div className="settings">
      {/* 左侧导航 */}
      <nav className="settings-nav">
        <div className="settings-brand">
          <span className="settings-brand-dot" />
          桌宠设置
        </div>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`settings-nav-item${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="settings-nav-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
        <div className="settings-nav-foot">v{appVersion}</div>
      </nav>

      {/* 右侧内容面板 */}
      <div className="settings-panel">
        {tab === 'pet' && (
          <>
            <header className="panel-head">
              <h2>桌宠</h2>
              <p>选择一只桌宠，或导入你自己的皮肤包。</p>
            </header>

            <div className="pet-grid">
              {pets.map((pet) => (
                <div
                  key={pet.id}
                  role="button"
                  tabIndex={0}
                  className={`pet-card${pet.id === settings.selectedPetId ? ' is-selected' : ''}`}
                  style={{ '--accent': pet.accentColor } as React.CSSProperties}
                  onClick={() => void api.selectPet(pet.id).then(setSnapshot)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void api.selectPet(pet.id).then(setSnapshot)
                    }
                  }}
                >
                  <span
                    className={`pet-card-source pet-card-source--${pet.source}`}
                  >
                    {pet.source === 'imported' ? '已导入' : '官方'}
                  </span>
                  <span className="pet-card-preview">
                    <PetSprite pet={pet} state="idle" />
                  </span>
                  <span className="pet-card-name">{pet.name}</span>
                  <span className="pet-card-desc">{pet.description}</span>
                  {pet.source === 'imported' && (
                    <button
                      type="button"
                      className="pet-card-delete"
                      title="删除这个皮肤包"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeletePack(pet.id, pet.name)
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="pet-pack-actions">
              <button type="button" onClick={handleImportPack} disabled={packBusy}>
                {packBusy ? '导入中…' : '＋ 导入皮肤包文件夹'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void api.revealPetPacksFolder()}
              >
                打开导入目录
              </button>
            </div>
            {packError && <p className="pet-pack-error">导入失败：{packError}</p>}

            <div className="field-card">
              <div className="field-row">
                <span className="field-label">大小</span>
                <input
                  type="range"
                  min={PET_SCALE_MIN}
                  max={PET_SCALE_MAX}
                  step={0.05}
                  value={displayScale}
                  onChange={(e) => setScaleDraft(Number(e.target.value))}
                  onPointerUp={(e) => commitScale(Number(e.currentTarget.value))}
                  onPointerCancel={() => setScaleDraft(null)}
                  onBlur={(e) => commitScale(Number(e.currentTarget.value))}
                  onKeyUp={(e) => {
                    if (
                      ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)
                    ) {
                      commitScale(Number(e.currentTarget.value))
                    }
                  }}
                />
                <span className="row-value">{Math.round(displayScale * 100)}%</span>
              </div>
            </div>
          </>
        )}

        {tab === 'bubble' && (
          <>
            <header className="panel-head">
              <h2>陪伴气泡</h2>
              <p>桌宠偶尔冒出的小气泡，安静作陪。</p>
            </header>
            <div className="field-card">
              <label className="field-row">
                <span className="field-label">偶尔冒出小气泡</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.bubblesEnabled}
                  onChange={(e) => patch({ bubblesEnabled: e.target.checked })}
                />
              </label>
              <label className="field-row">
                <span className="field-label">频率</span>
                <select
                  value={settings.bubbleFrequencySeconds}
                  disabled={!settings.bubblesEnabled}
                  onChange={(e) => patch({ bubbleFrequencySeconds: Number(e.target.value) })}
                >
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                  {!FREQUENCY_OPTIONS.some((opt) => opt.value === settings.bubbleFrequencySeconds) && (
                    <option value={settings.bubbleFrequencySeconds}>
                      大约每 {Math.round(settings.bubbleFrequencySeconds / 60)} 分钟
                    </option>
                  )}
                </select>
              </label>
            </div>
          </>
        )}

        {tab === 'agent' && (
          <>
            <header className="panel-head">
              <h2>Agent 监控</h2>
              <p>盯着 Codex / Claude Code，任务停下来时提醒你。</p>
            </header>
            <div className="field-card">
              <label className="field-row">
                <span className="field-label">盯着 Codex / Claude Code</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.agentMonitoringEnabled}
                  onChange={(e) => patch({ agentMonitoringEnabled: e.target.checked })}
                />
              </label>
              {settings.agentMonitoringEnabled && (
                <>
                  <label className="field-row">
                    <span className="field-label">监控 Codex</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={settings.codexMonitoringEnabled}
                      onChange={(e) => patch({ codexMonitoringEnabled: e.target.checked })}
                    />
                  </label>
                  <label className="field-row">
                    <span className="field-label">监控 Claude Code</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={settings.claudeMonitoringEnabled}
                      onChange={(e) => patch({ claudeMonitoringEnabled: e.target.checked })}
                    />
                  </label>
                  <label className="field-row">
                    <span className="field-label">完成提示音</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={settings.agentCompletionSoundEnabled}
                      onChange={(e) => patch({ agentCompletionSoundEnabled: e.target.checked })}
                    />
                  </label>
                </>
              )}
            </div>

            {settings.agentMonitoringEnabled && (
              <>
                <p className="hint-text">
                  只有 Agent「停下来」时才弹气泡：输出结束（完成）、需要你处理（授权 / 回答问题 /
                  帮忙验证）、出错或被中断。正在干活时小桌宠只安静地做思考表情，不打扰你。
                </p>

                <div className="agent-diag">
                  <div className="agent-diag-row">
                    <span>最近检查</span>
                    <span>{formatTime(agent.lastCheckedAt)}</span>
                  </div>
                  <div className="agent-diag-row">
                    <span>最近事件</span>
                    <span>
                      {agent.lastEvent
                        ? `${AGENT_SOURCE_LABEL[agent.lastEvent.source]} · ${AGENT_KIND_LABEL[agent.lastEvent.kind]}`
                        : '—'}
                    </span>
                  </div>
                  <div className="agent-diag-row">
                    <span>活跃会话</span>
                    <span>{agent.activeSessions.length}</span>
                  </div>
                </div>

                <p className="hint-text hint-text--muted">
                  Agent 监控只读取本机 Codex / Claude Code 会话状态文件，不上传代码或日志。
                </p>

                {!isPackaged && (
                  <div className="agent-sim">
                    <div className="agent-sim-title">开发模拟</div>
                    <div className="agent-sim-buttons">
                      {SIMULATE_BUTTONS.map((b) => (
                        <button
                          key={`${b.source}-${b.kind}`}
                          type="button"
                          onClick={() => api.agentSimulate(b.source, b.kind)}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'about' && (
          <>
            <header className="panel-head">
              <h2>关于</h2>
              <p>DesktopPetMVP v{appVersion}</p>
            </header>

            <div className="about-hero">
              <div className="about-hero-pet">
                {selectedPet && <PetSprite pet={selectedPet} state="happy" />}
              </div>
              <p>一个安静住在桌面上的小伙伴。</p>
              <p className="hint-text--muted">所有设置自动保存在本机，不联网。</p>
            </div>

            <div className="field-card">
              <div className="field-row field-row--buttons">
                <button type="button" className="ghost" onClick={() => void api.resetPetPosition()}>
                  重置位置
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void (settings.petVisible ? api.hidePet() : api.showPet())}
                >
                  {settings.petVisible ? '隐藏桌宠' : '显示桌宠'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
