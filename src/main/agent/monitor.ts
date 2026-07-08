import {
  AGENT_EVENT_FRESH_MS,
  AGENT_POLL_INTERVAL_MS,
  AGENT_SEEN_IDS_MAX,
  AGENT_SESSION_EXPIRE_MS
} from '@shared/defaults'
import type {
  AgentEnv,
  AgentEventKind,
  AgentMonitorEvent,
  AgentMonitorStatus,
  AgentSource
} from '@shared/types'
import { scanClaude } from './claude'
import { scanCodex } from './codex'

/**
 * monitor 对外配置：从当前设置读取，设置变化时整体重启。
 * v0.3.3：去掉总开关；每家一个开关 + 一个环境集合。
 * 某家开关开、但该家环境集合为空 = 该家不监控（等于关）。
 * 两家都不监控 = 完全不轮询（纯陪伴）。
 */
export interface MonitorConfig {
  codexEnabled: boolean
  claudeEnabled: boolean
  /** Codex 监控哪些环境（terminal/vscode/desktop）；空集=不监控 codex */
  codexEnvs: AgentEnv[]
  /** Claude Code 监控哪些环境；空集=不监控 claude */
  claudeEnvs: AgentEnv[]
}

/** monitor 依赖注入：时间源可注入以便测试；事件回调交给 main 派发副作用 */
export interface MonitorDeps {
  now(): number
  onEvent(event: AgentMonitorEvent): void
  /** 可选诊断日志（写文件用），不注入则不记 */
  log?(message: string): void
}

/** 简易稳定字符串哈希（djb2），用于事件去重 id，不追求密码学强度 */
function hashString(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

function eventId(e: AgentMonitorEvent): string {
  return `${e.source}:${e.rawPath ?? ''}:${e.timestampMs}:${e.kind}:${hashString(e.message)}`
}

const TERMINAL_KINDS: ReadonlySet<AgentEventKind> = new Set<AgentEventKind>([
  'done',
  'needs_attention',
  'failed'
])

export class AgentMonitor {
  private config: MonitorConfig
  private readonly deps: MonitorDeps

  private timer: ReturnType<typeof setInterval> | null = null
  private primed = false
  /** 已处理过的事件 id（去重）。用 Set + 插入序数组维护上限 */
  private readonly seenIds = new Set<string>()
  private readonly seenOrder: string[] = []
  /** 每个 session 最近一次出现 working 的时间；终态提醒需先见过 working */
  private readonly workingSeenAt = new Map<string, number>()
  /** 活跃会话：sessionKey -> {source, lastSeenAt} */
  private readonly activeSessions = new Map<string, { source: AgentSource; lastSeenAt: number }>()

  private lastCheckedAt: number | null = null
  private lastEvent: AgentMonitorEvent | null = null
  private lastError: string | null = null

  constructor(config: MonitorConfig, deps: MonitorDeps) {
    this.config = config
    this.deps = deps
  }

  /** codex 是否真的在监控：开关开 且 至少选了一个环境 */
  private codexActive(): boolean {
    return this.config.codexEnabled && this.config.codexEnvs.length > 0
  }

  /** claude 是否真的在监控：开关开 且 至少选了一个环境 */
  private claudeActive(): boolean {
    return this.config.claudeEnabled && this.config.claudeEnvs.length > 0
  }

  start(): void {
    this.stop()
    // 两家都不监控（关掉 / 环境全不选）= 纯陪伴，不起轮询
    if (!this.codexActive() && !this.claudeActive()) return
    // 首轮 prime：把已有旧事件标记为 seen，避免启动后弹一堆历史提醒
    this.primed = false
    this.tick()
    this.timer = setInterval(() => this.tick(), AGENT_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 设置变化时用新配置重启（例如关掉某个来源） */
  updateConfig(config: MonitorConfig): void {
    this.config = config
    this.start()
  }

  getStatus(): AgentMonitorStatus {
    const now = this.deps.now()
    const active = [...this.activeSessions.entries()]
      .filter(([, v]) => now - v.lastSeenAt <= AGENT_SESSION_EXPIRE_MS)
      .map(([sessionKey, v]) => ({ source: v.source, sessionKey, lastSeenAt: v.lastSeenAt }))
    return {
      enabled: this.codexActive() || this.claudeActive(),
      lastEvent: this.lastEvent,
      activeSessions: active,
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError
    }
  }

  /** 事件是否通过「按环境」过滤：看它所属 source 的环境集合是否包含它的 env */
  private passesEnvFilter(e: AgentMonitorEvent): boolean {
    const envs = e.source === 'codex' ? this.config.codexEnvs : this.config.claudeEnvs
    return envs.includes(e.env)
  }

  /**
   * 把一条事件送入统一处理链路。真实扫描和 dev 模拟都走这里。
   * @param fromScan true=来自轮询扫描（受 prime 影响）；false=来自 dev 模拟（总是派发）
   */
  ingest(raw: AgentMonitorEvent, fromScan: boolean): void {
    const event: AgentMonitorEvent = { ...raw, id: raw.id || eventId(raw) }
    const log = this.deps.log

    // 去重：处理过就跳过（无论是否弹过气泡，只认"已处理"）
    if (this.seenIds.has(event.id)) {
      if (log && TERMINAL_KINDS.has(event.kind)) {
        log(`SKIP seen: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`)
      }
      return
    }

    // 更新 working 记录 & 活跃会话
    if (event.kind === 'working') {
      this.workingSeenAt.set(event.sessionKey, event.timestampMs)
    }
    this.activeSessions.set(event.sessionKey, {
      source: event.source,
      lastSeenAt: event.timestampMs
    })

    this.markSeen(event.id)

    // prime 阶段（首轮扫描）：只登记 seen，不派发，避免历史刷屏
    if (fromScan && !this.primed) {
      if (log && TERMINAL_KINDS.has(event.kind)) {
        log(`SKIP prime: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`)
      }
      return
    }

    // 终态提醒规则：done/needs_attention/failed 只在该 session 近期出现过 working 才提醒。
    // dev 模拟(fromScan=false)不受此限，方便单独验证。
    if (fromScan && TERMINAL_KINDS.has(event.kind)) {
      const workingAt = this.workingSeenAt.get(event.sessionKey)
      if (workingAt === undefined) {
        if (log) log(`SKIP no-working: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`)
        return
      }
    }

    if (log && TERMINAL_KINDS.has(event.kind)) {
      log(`NOTIFY: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`)
    }
    this.lastEvent = event
    this.deps.onEvent(event)
  }

  private markSeen(id: string): void {
    this.seenIds.add(id)
    this.seenOrder.push(id)
    while (this.seenOrder.length > AGENT_SEEN_IDS_MAX) {
      const oldest = this.seenOrder.shift()
      if (oldest !== undefined) this.seenIds.delete(oldest)
    }
  }

  private tick(): void {
    const now = this.deps.now()
    this.lastCheckedAt = now
    this.lastError = null

    try {
      const events: AgentMonitorEvent[] = []
      if (this.codexActive()) events.push(...scanCodex(now))
      if (this.claudeActive()) events.push(...scanClaude(now))

      // 只处理最近 AGENT_EVENT_FRESH_MS 内、且通过「按环境过滤」的事件（老日志/未勾选的环境忽略）。
      // 时间戳缺失(=now)的会被保留，靠 seenIds 去重防重复。
      const fresh = events.filter(
        (e) => now - e.timestampMs <= AGENT_EVENT_FRESH_MS && this.passesEnvFilter(e)
      )
      // 诊断：本轮扫到的终态事件，被 FRESH / env 过滤前后的情况
      const log = this.deps.log
      if (log) {
        const terms = events.filter((e) => TERMINAL_KINDS.has(e.kind))
        if (terms.length > 0) {
          const staleN = terms.filter((e) => now - e.timestampMs > AGENT_EVENT_FRESH_MS).length
          const envCutN = terms.filter((e) => !this.passesEnvFilter(e)).length
          log(
            `tick: 终态${terms.length}条 [${terms.map((e) => `${e.env}/${e.kind}/${Math.round((now - e.timestampMs) / 1000)}s`).join(',')}] 过期${staleN} env过滤${envCutN}`
          )
        }
      }
      // 按时间正序处理，保证同一 session 的 working 先于终态被登记
      fresh.sort((a, b) => a.timestampMs - b.timestampMs)

      for (const e of fresh) this.ingest(e, true)
    } catch (err) {
      // 解析/IO 异常绝不冒泡，只记录到 status
      this.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      // 首轮结束后解除 prime，之后的新事件才真正提醒
      this.primed = true
    }
  }
}
