import { useEffect, useState } from 'react'
import { PET_SCALE_MAX, PET_SCALE_MIN } from '@shared/defaults'
import { AGENT_ENVS } from '@shared/types'
import type {
  AgentEnv,
  AgentEventKind,
  AgentSource,
  AiTestResult,
  Settings,
  Snapshot
} from '@shared/types'
import { api } from '../api'
import { removeBackgroundFromDataUrl } from '../removeBackground'
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

const AGENT_ENV_LABEL: Record<AgentEnv, string> = {
  terminal: '终端',
  vscode: 'VS Code',
  desktop: '客户端'
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

type TabKey = 'pet' | 'bubble' | 'agent' | 'ai' | 'about'

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'pet', label: '桌宠', icon: '🐾' },
  { key: 'bubble', label: '气泡', icon: '💬' },
  { key: 'agent', label: 'Agent', icon: '🛰️' },
  { key: 'ai', label: 'AI 总结', icon: '✨' },
  { key: 'about', label: '关于', icon: 'ℹ️' }
]

export default function SettingsView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [scaleDraft, setScaleDraft] = useState<number | null>(null)
  // v0.3：皮肤包导入的进行中 / 错误提示
  const [packBusy, setPackBusy] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  // v0.3.3：正在内联重命名的皮肤包 id + 输入草稿
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // v0.3.2：左侧导航当前选中的分组
  const [tab, setTab] = useState<TabKey>('pet')
  // v0.5：AI 总结「测试连接」的进行中 / 结果
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
    return <div className="settings" />
  }

  const { settings, pets, appVersion, agent, isPackaged } = snapshot

  const patch = (partial: Partial<Settings>): void => {
    void api.updateSettings(partial).then(setSnapshot)
  }

  // v0.3.3：勾选/取消某家 Agent 的一个监控环境，按 AGENT_ENVS 固定顺序回写
  const toggleEnv = (
    key: 'codexMonitoringEnvs' | 'claudeMonitoringEnvs',
    current: AgentEnv[],
    env: AgentEnv
  ): void => {
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

  // v0.3：导入皮肤包文件夹
  // v0.3.3：合并后的「导入皮肤」。一个对话框既能选图片、也能选皮肤包文件夹，
  // main 侧按类型分流：
  //   - pack ：皮肤包文件夹，已在 main 导入完成 → 直接刷新快照
  //   - image：单张图片 → 渲染进程（可选）抠纯色背景，再 savePetImage 落盘
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
          // v0.4：PetDex 宠物已导入并选中，直接刷新
          setSnapshot(picked.snapshot)
          return
        }
        // picked.kind === 'image'：两段式，抠图后再存
        let dataUrl = picked.dataUrl
        // 开了自动抠图、且不是 SVG 时，尝试去掉纯色背景；抠不动（非纯色）就用原图
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

  // v0.3：删除一个已导入皮肤包
  const handleDeletePack = (petId: string, name: string): void => {
    if (!window.confirm(`确定删除皮肤包「${name}」吗？此操作不可撤销。`)) return
    setPackError(null)
    void api
      .deleteImportedPetPack(petId)
      .then(setSnapshot)
      .catch((e) => setPackError(String(e)))
  }

  // v0.3.3：内联重命名——进入编辑态，卡片名字变输入框
  const startRename = (petId: string, oldName: string): void => {
    setPackError(null)
    setRenamingId(petId)
    setRenameDraft(oldName)
  }
  const cancelRename = (): void => {
    setRenamingId(null)
    setRenameDraft('')
  }
  const commitRename = (petId: string, oldName: string): void => {
    const name = renameDraft.trim()
    // 空 / 没变：直接退出编辑态，不打扰
    if (name.length < 1 || name === oldName) {
      cancelRename()
      return
    }
    if (name.length > 30) {
      setPackError('名字要 1-30 个字')
      return
    }
    setPackError(null)
    void api
      .renameImportedPetPack(petId, name)
      .then(setSnapshot)
      .catch((e) => setPackError(String(e)))
      .finally(cancelRename)
  }

  const selectedPet = pets.find((p) => p.id === settings.selectedPetId) ?? pets[0]

  // v0.5：模型服务下拉的三个选项。硅基流动本质是 OpenAI 兼容接口的一键预设
  // （Base URL 固定），存储层不新增 provider，靠 baseUrl 反推当前选中项。
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
        // 首次切过来给个能直接用的默认模型（可改）。
        // 实测 V3 旧端点（含 Pro 版）常年 429 拥堵，V3.1 畅通，默认用 V3.1
        aiOpenaiModel: settings.aiOpenaiModel || 'deepseek-ai/DeepSeek-V3.1'
      })
    } else {
      patch({
        aiProvider: 'openai',
        // 从硅基流动预设切回通用模式时，把 Base URL 复位成 OpenAI 官方
        aiOpenaiBaseUrl:
          settings.aiOpenaiBaseUrl === SILICONFLOW_BASE_URL
            ? 'https://api.openai.com/v1'
            : settings.aiOpenaiBaseUrl
      })
    }
  }

  // v0.5：AI 总结「测试连接」——主进程用当前设置发一次真实请求
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
    <div className="settings">
      {/* 左侧导航：悬浮图标方块（垂直居中）+ 左下角产品名 */}
      <nav className="settings-nav">
        <div className="settings-nav-tiles">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`settings-nav-item${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
              aria-label={t.label}
            >
              <span className="settings-nav-icon">{t.icon}</span>
              <span className="settings-nav-chip">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-brandname">
          PingPet
          <span className="settings-nav-foot">v{appVersion}</span>
        </div>
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
                  {renamingId === pet.id ? (
                    <input
                      className="pet-card-name-input"
                      value={renameDraft}
                      autoFocus
                      maxLength={30}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename(pet.id, pet.name)
                        else if (e.key === 'Escape') cancelRename()
                      }}
                      onBlur={() => commitRename(pet.id, pet.name)}
                    />
                  ) : (
                    <span className="pet-card-name">{pet.name}</span>
                  )}
                  <span className="pet-card-desc">{pet.description}</span>
                  {pet.source === 'imported' && renamingId !== pet.id && (
                    <span className="pet-card-actions">
                      <button
                        type="button"
                        className="pet-card-action"
                        title="给这个皮肤包改名"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(pet.id, pet.name)
                        }}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="pet-card-action pet-card-action--danger"
                        title="删除这个皮肤包"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeletePack(pet.id, pet.name)
                        }}
                      >
                        删除
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="pet-pack-actions">
              <button type="button" onClick={handleImportSkin} disabled={packBusy}>
                {packBusy ? '导入中…' : '＋ 导入皮肤'}
              </button>
            </div>
            <p className="pet-pack-hint">
              选一张 PNG / WebP / SVG 图片直接变成桌宠，或选一个含 manifest.json
              的皮肤包文件夹 —— 都用这一个按钮，自动识别。
              <button
                type="button"
                className="pet-pack-link"
                onClick={() => void api.revealPetPacksFolder()}
              >
                打开导入目录
              </button>
            </p>
            <label className="pet-pack-toggle">
              <input
                type="checkbox"
                className="switch"
                checked={settings.autoRemoveBackground}
                onChange={(e) => patch({ autoRemoveBackground: e.target.checked })}
              />
              <span>
                导入图片时自动去掉纯色背景
                <em>（黑底/白底等纯色底会被抠成透明；复杂背景会保持原样）</em>
              </span>
            </label>
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
              <p>Codex / Claude Code 忙完或需要你时，第一时间提醒你。</p>
            </header>
            <div className="field-card">
              <label className="field-row">
                <span className="field-label">监控 Codex</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.codexMonitoringEnabled}
                  onChange={(e) => patch({ codexMonitoringEnabled: e.target.checked })}
                />
              </label>
              {settings.codexMonitoringEnabled && (
                <div className="env-row">
                  <span className="env-row-label">监控环境</span>
                  <div className="env-chips">
                    {AGENT_ENVS.map((env) => (
                      <label key={env} className="env-chip">
                        <input
                          type="checkbox"
                          checked={settings.codexMonitoringEnvs.includes(env)}
                          onChange={() =>
                            toggleEnv('codexMonitoringEnvs', settings.codexMonitoringEnvs, env)
                          }
                        />
                        <span>{AGENT_ENV_LABEL[env]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <label className="field-row">
                <span className="field-label">监控 Claude Code</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.claudeMonitoringEnabled}
                  onChange={(e) => patch({ claudeMonitoringEnabled: e.target.checked })}
                />
              </label>
              {settings.claudeMonitoringEnabled && (
                <div className="env-row">
                  <span className="env-row-label">监控环境</span>
                  <div className="env-chips">
                    {AGENT_ENVS.map((env) => (
                      <label key={env} className="env-chip">
                        <input
                          type="checkbox"
                          checked={settings.claudeMonitoringEnvs.includes(env)}
                          onChange={() =>
                            toggleEnv('claudeMonitoringEnvs', settings.claudeMonitoringEnvs, env)
                          }
                        />
                        <span>{AGENT_ENV_LABEL[env]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <label className="field-row">
                <span className="field-label">完成提示音</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.agentCompletionSoundEnabled}
                  onChange={(e) => patch({ agentCompletionSoundEnabled: e.target.checked })}
                />
              </label>
            </div>

            <p className="hint-text">
              两个都关掉，它就是一只安静陪你的普通桌宠。开启后，只有 Agent「停下来」时才弹气泡：输出结束（完成）、需要你处理（授权
              / 回答问题 / 帮忙验证）、出错或被中断。正在干活时小桌宠只安静地做思考表情，不打扰你。
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
              监控覆盖终端、VS Code 与桌面客户端里的 Codex / Claude Code（纯网页端暂不支持）。只读取本机会话状态文件，不上传代码或日志。
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

        {tab === 'ai' && (
          <>
            <header className="panel-head">
              <h2>AI 总结</h2>
              <p>任务停下时，让大模型读会话末尾，用一句人话告诉你发生了什么。</p>
            </header>

            <div className="field-card">
              <label className="field-row">
                <span className="field-label">启用 AI 总结</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.aiSummaryEnabled}
                  onChange={(e) => {
                    setAiTestResult(null)
                    patch({ aiSummaryEnabled: e.target.checked })
                  }}
                />
              </label>

              {settings.aiSummaryEnabled && (
                <>
                  <label className="field-row">
                    <span className="field-label">模型服务</span>
                    <select
                      value={aiProviderChoice}
                      onChange={(e) => {
                        setAiTestResult(null)
                        applyAiProviderChoice(e.target.value as AiProviderChoice)
                      }}
                    >
                      <option value="siliconflow">硅基流动（SiliconFlow）</option>
                      <option value="anthropic">Anthropic（Claude）</option>
                      <option value="openai">OpenAI 兼容接口</option>
                    </select>
                  </label>

                  {settings.aiProvider === 'anthropic' ? (
                    <>
                      <label className="field-row">
                        <span className="field-label">API Key</span>
                        <input
                          key={`ak:${settings.aiAnthropicApiKey}`}
                          className="ai-input"
                          type="password"
                          placeholder="sk-ant-…"
                          defaultValue={settings.aiAnthropicApiKey}
                          onBlur={(e) => patch({ aiAnthropicApiKey: e.target.value })}
                        />
                      </label>
                      <label className="field-row">
                        <span className="field-label">模型</span>
                        <input
                          key={`am:${settings.aiAnthropicModel}`}
                          className="ai-input"
                          type="text"
                          placeholder="claude-opus-4-8"
                          defaultValue={settings.aiAnthropicModel}
                          onBlur={(e) => patch({ aiAnthropicModel: e.target.value })}
                        />
                      </label>
                      <p className="hint-text hint-text--muted ai-field-hint">
                        默认 claude-opus-4-8（效果最好）；追求更快更省可改成 claude-haiku-4-5。
                      </p>
                    </>
                  ) : (
                    <>
                      {aiProviderChoice === 'openai' && (
                        <label className="field-row">
                          <span className="field-label">Base URL</span>
                          <input
                            key={`ob:${settings.aiOpenaiBaseUrl}`}
                            className="ai-input"
                            type="text"
                            placeholder="https://api.openai.com/v1"
                            defaultValue={settings.aiOpenaiBaseUrl}
                            onBlur={(e) => patch({ aiOpenaiBaseUrl: e.target.value })}
                          />
                        </label>
                      )}
                      <label className="field-row">
                        <span className="field-label">API Key</span>
                        <input
                          key={`ok:${settings.aiOpenaiApiKey}`}
                          className="ai-input"
                          type="password"
                          placeholder="sk-…"
                          defaultValue={settings.aiOpenaiApiKey}
                          onBlur={(e) => patch({ aiOpenaiApiKey: e.target.value })}
                        />
                      </label>
                      <label className="field-row">
                        <span className="field-label">模型</span>
                        <input
                          key={`om:${settings.aiOpenaiModel}`}
                          className="ai-input"
                          type="text"
                          placeholder={
                            aiProviderChoice === 'siliconflow'
                              ? '例如 deepseek-ai/DeepSeek-V3.1'
                              : '例如 gpt-4o-mini / deepseek-chat'
                          }
                          defaultValue={settings.aiOpenaiModel}
                          onBlur={(e) => patch({ aiOpenaiModel: e.target.value })}
                        />
                      </label>
                      <p className="hint-text hint-text--muted ai-field-hint">
                        {aiProviderChoice === 'siliconflow'
                          ? 'Key 在 cloud.siliconflow.cn「API 密钥」页生成；模型 ID 按硅基流动模型广场的名字填（默认 DeepSeek-V3.1；报 429 拥堵可换 Qwen/Qwen2.5-72B-Instruct）。'
                          : '兼容任何 OpenAI 格式的服务：DeepSeek、月之暗面、Ollama（http://127.0.0.1:11434/v1）等。'}
                      </p>
                    </>
                  )}

                  <div className="field-row field-row--buttons">
                    <button
                      type="button"
                      className="ghost"
                      disabled={aiTestBusy}
                      onClick={handleTestAi}
                    >
                      {aiTestBusy ? '测试中…' : '测试连接'}
                    </button>
                    {aiTestResult && (
                      <span
                        className={`ai-test-result ${aiTestResult.ok ? 'ai-test-result--ok' : 'ai-test-result--err'}`}
                      >
                        {aiTestResult.ok
                          ? `✓ 连接成功！模型对内置样例的总结演示：「${aiTestResult.text}」`
                          : `✕ ${aiTestResult.error}`}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            <p className="hint-text">
              开启后，Agent 停下来的气泡会多一句 AI
              生成的具体说明（做了什么、在等你做什么）。总结失败或超时会自动回落到普通提醒文案，提醒永远不会缺席。
            </p>
            <p className="hint-text hint-text--muted">
              隐私说明：这是可选联网功能。开启时，仅在任务停下的那一刻，把该会话末尾的少量文本发给你
              <b>自己配置</b>的模型服务生成总结；API Key 只保存在本机。关闭时此功能完全不联网。
            </p>
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
