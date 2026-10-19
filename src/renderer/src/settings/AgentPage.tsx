import { useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Asterisk,
  Bot,
  ChevronDown,
  Clock3,
  Code2,
  MousePointer2,
  Radio,
  ShieldCheck,
  Terminal
} from 'lucide-react'
import { AGENT_SOURCE_LIST } from '@shared/agents'
import {
  CODEX_CANDIDATE_SETTING_ITEMS,
  CODEX_CANDIDATE_SETTINGS_CARD_HINT,
  CODEX_CANDIDATE_SETTINGS_CARD_TITLE,
  type CodexCandidateUiSettingKey
} from '@shared/codexCandidateSettings'
import { AGENT_ENVS } from '@shared/types'
import type {
  AgentEnv,
  AgentEventKind,
  AgentSource,
  MonitoringEnvsKey,
  Settings,
  Snapshot
} from '@shared/types'
import {
  Badge,
  Button,
  Callout,
  Card,
  PageHead,
  Row,
  SectionHead,
  Switch
} from './ui'

const ENV_LABEL: Record<AgentEnv, string> = {
  terminal: '终端',
  vscode: 'VS Code',
  desktop: '客户端'
}

const KIND_LABEL: Record<AgentEventKind, string> = {
  working: '处理中',
  done: '完成',
  needs_attention: '需要你',
  failed: '出错 / 中断'
}

const KIND_TONE: Record<AgentEventKind, 'sage' | 'accent' | 'amber' | 'danger'> = {
  working: 'accent',
  done: 'sage',
  needs_attention: 'amber',
  failed: 'danger'
}

const SOURCE_ICON: Record<AgentSource, JSX.Element> = {
  codex: <Code2 size={17} />,
  claude: <Asterisk size={18} />,
  cursor: <MousePointer2 size={16} />,
  grok: <Bot size={17} />
}

const SOURCE_MARK: Record<AgentSource, string> = {
  codex: 'codex',
  claude: 'claude',
  cursor: 'cursor',
  grok: 'grok'
}

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export interface AgentPageProps {
  snapshot: Snapshot
  onPatch: (partial: Partial<Settings>) => void
  onToggleEnv: (key: MonitoringEnvsKey, current: AgentEnv[], env: AgentEnv) => void
  onSimulate: (source: AgentSource, kind: AgentEventKind) => void
}

export default function AgentPage(props: AgentPageProps): JSX.Element {
  const { snapshot, onPatch, onToggleEnv, onSimulate } = props
  const { settings, agent, isPackaged } = snapshot
  const [showAdvanced, setShowAdvanced] = useState(false)
  const openCount = AGENT_SOURCE_LIST.filter((meta) => settings[meta.enabledKey]).length
  const lastEvent = agent.lastEvent

  return (
    <div className="pp-page">
      <PageHead
        eyebrow="AGENT WATCH"
        title="Agent 监控"
        subtitle="它们干活时安静等待，停下来时再叫你。只读本机会话文件，不上传代码。"
      />

      <div className="pp-agent-summary">
        <div className="pp-agent-summary__main">
          <span className="pp-eyebrow">ENABLED SOURCES</span>
          <div className="pp-agent-summary__count">
            <strong>{openCount}</strong>
            <span>/ {AGENT_SOURCE_LIST.length} 家</span>
          </div>
          <p>
            {openCount === 0
              ? '全部关闭，现在是一只纯陪伴桌宠。'
              : '只有停下时才弹气泡；正在干活时只做思考表情。'}
          </p>
        </div>
        <div className="pp-agent-summary__stats">
          <div>
            <span>
              <Clock3 size={13} /> 最近检查
            </span>
            <strong>{formatTime(agent.lastCheckedAt)}</strong>
          </div>
          <div>
            <span>
              <Activity size={13} /> 活跃会话
            </span>
            <strong>{agent.activeSessions.length}</strong>
          </div>
          <div>
            <span>
              <Radio size={13} /> 最近事件
            </span>
            <strong>
              {lastEvent
                ? `${AGENT_SOURCE_LIST.find((meta) => meta.source === lastEvent.source)?.label ?? lastEvent.source} · ${KIND_LABEL[lastEvent.kind]}`
                : '—'}
            </strong>
          </div>
        </div>
      </div>

      {agent.error && (
        <Callout tone="danger" icon={<AlertTriangle size={16} />}>
          <strong>监控遇到问题</strong>
          <span>{agent.error}</span>
        </Callout>
      )}

      <div className="pp-source-grid">
        {AGENT_SOURCE_LIST.map((meta) => {
          const enabled = settings[meta.enabledKey]
          const selectedEnvs = settings[meta.envsKey]
          const sourceLast = lastEvent?.source === meta.source ? lastEvent : null
          return (
            <article
              key={meta.source}
              className={`pp-source-card pp-source-card--${SOURCE_MARK[meta.source]}${enabled ? ' is-on' : ''}`}
            >
              <header>
                <div className="pp-source-card__identity">
                  <span className="pp-source-card__icon">{SOURCE_ICON[meta.source]}</span>
                  <div>
                    <h3>{meta.label}</h3>
                    <p>{enabled ? '正在监听本机会话' : '未开启，不会读取任何会话'}</p>
                  </div>
                </div>
                <Switch
                  label={`监控 ${meta.label}`}
                  checked={enabled}
                  onChange={(value) => onPatch({ [meta.enabledKey]: value } as Partial<Settings>)}
                />
              </header>

              {enabled ? (
                <>
                  <div className="pp-source-card__status">
                    {sourceLast ? (
                      <Badge tone={KIND_TONE[sourceLast.kind]} dot>
                        {KIND_LABEL[sourceLast.kind]}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">等待事件</Badge>
                    )}
                    <span>
                      {selectedEnvs.length === 0
                        ? '没有勾选环境，实际不会监听'
                        : `监听 ${selectedEnvs.length} 个环境`}
                    </span>
                  </div>

                  <div className="pp-source-card__envs">
                    <span>监控环境</span>
                    <div className="pp-env-chips">
                      {AGENT_ENVS.map((env) => {
                        const usable = meta.envs.includes(env)
                        const on = usable && selectedEnvs.includes(env)
                        return (
                          <button
                            key={env}
                            type="button"
                            disabled={!usable}
                            aria-pressed={on}
                            title={usable ? undefined : meta.envLimitReason}
                            className={`pp-env-chip${on ? ' is-on' : ''}${usable ? '' : ' is-disabled'}`}
                            onClick={() => onToggleEnv(meta.envsKey, selectedEnvs, env)}
                          >
                            {on && <span className="pp-env-chip__dot" />}
                            {ENV_LABEL[env]}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {meta.envLimitReason && (
                    <p className="pp-source-card__note">{meta.envLimitReason}</p>
                  )}
                </>
              ) : (
                <div className="pp-source-card__off">
                  <Terminal size={14} />
                  <span>打开后开始监听 {meta.envs.map((env) => ENV_LABEL[env]).join(' / ')}</span>
                </div>
              )}
            </article>
          )
        })}
      </div>

      <Card padded={false} className="pp-settings-card">
        <Row
          title="完成提示音"
          desc="Agent 停下时轻轻响一声「叮咚」。默认关闭，Codex 轮次结束不触发完成音。"
          control={
            <Switch
              label="完成提示音"
              checked={settings.agentCompletionSoundEnabled}
              onChange={(value) => onPatch({ agentCompletionSoundEnabled: value })}
            />
          }
        />
      </Card>

      <Callout tone="neutral" icon={<ShieldCheck size={16} />}>
        <strong>只读，不打扰</strong>
        <span>
          只读取 Codex / Claude Code / Cursor / Grok Bot 的本地会话状态文件，
          不注入、不代理、不读取项目代码。正在干活时桌宠只做思考表情，绝不在中途弹气泡。
          纯网页端会话在云端，暂时监听不到。
        </span>
      </Callout>

      <section className="pp-section">
        <SectionHead title="最近一次提醒" hint="用来确认监控链路是否正常。" />
        <Card>
          {lastEvent ? (
            <div className="pp-last-event">
              <div className="pp-last-event__head">
                <Badge tone={KIND_TONE[lastEvent.kind]} dot>
                  {KIND_LABEL[lastEvent.kind]}
                </Badge>
                <strong>
                  {AGENT_SOURCE_LIST.find((meta) => meta.source === lastEvent.source)?.label ??
                    lastEvent.source}
                </strong>
                <span>{formatTime(lastEvent.timestampMs)}</span>
              </div>
              <p>{lastEvent.detail || lastEvent.message}</p>
              <div className="pp-last-event__meta">
                <span>环境：{ENV_LABEL[lastEvent.env]}</span>
                {lastEvent.reason && (
                  <span>
                    原因：
                    {lastEvent.reason === 'completed'
                      ? '正常结束'
                      : lastEvent.reason === 'needs_input'
                        ? '需要你处理'
                        : lastEvent.reason === 'error'
                          ? '出错'
                          : '被中断'}
                  </span>
                )}
              </div>
              <p className="pp-last-event__hint">
                「这一轮结束」只代表会话停下，不代表整个任务一定完成。
              </p>
            </div>
          ) : (
            <div className="pp-last-event pp-last-event--empty">
              <Radio size={16} />
              <p>还没有收到事件。打开上方的 Agent 开关后，这里会显示最近一次停机。</p>
            </div>
          )}
        </Card>
      </section>

      <section className="pp-section">
        <button
          type="button"
          className={`pp-disclosure${showAdvanced ? ' is-open' : ''}`}
          onClick={() => setShowAdvanced((value) => !value)}
          aria-expanded={showAdvanced}
        >
          <span>
            高级
            <em>Codex 实验性提示、开发调试</em>
          </span>
          <ChevronDown size={16} />
        </button>

        {showAdvanced && (
          <Card className="pp-advanced">
            <div className="pp-advanced__head">
              <div>
                <h3>
                  {CODEX_CANDIDATE_SETTINGS_CARD_TITLE}
                  <Badge tone="amber">实验</Badge>
                </h3>
                <p>{CODEX_CANDIDATE_SETTINGS_CARD_HINT}</p>
              </div>
            </div>
            {CODEX_CANDIDATE_SETTING_ITEMS.map((item) => (
              <Row
                key={item.key}
                title={item.title}
                desc={item.description}
                control={
                  <Switch
                    label={item.title}
                    checked={settings[item.key as CodexCandidateUiSettingKey]}
                    onChange={(value) =>
                      onPatch({ [item.key]: value } as unknown as Partial<Settings>)
                    }
                  />
                }
              />
            ))}

            {!isPackaged && (
              <div className="pp-dev-tools">
                <div className="pp-dev-tools__head">
                  <span>开发模拟</span>
                  <em>仅开发版可见，走真实事件处理链路</em>
                </div>
                <div className="pp-dev-tools__grid">
                  {AGENT_SOURCE_LIST.flatMap((meta) =>
                    (['working', 'done', 'needs_attention', 'failed'] as AgentEventKind[]).map(
                      (kind) => (
                        <Button
                          key={`${meta.source}-${kind}`}
                          size="sm"
                          variant="ghost"
                          onClick={() => onSimulate(meta.source, kind)}
                        >
                          {meta.label} · {KIND_LABEL[kind]}
                        </Button>
                      )
                    )
                  )}
                </div>
              </div>
            )}
          </Card>
        )}
      </section>
    </div>
  )
}
