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
  AgentSource,
  CodexDerivedState,
  CodexStateMigration
} from '@shared/types'
import { AGENT_SOURCE_IDS } from '@shared/agents'
import {
  CodexSessionShadow,
  listCodexSessionFiles,
  type CodexSessionShadowOptions,
  type CodexShadowCallbackMeta
} from './codexShadow'
import type { CodexLegacyDiagnosticDraft } from './codexShadowLog'
import { AGENT_SCANNERS } from './scanners'

/** 单家 Agent 的监控配置 */
export interface AgentSourceConfig {
  enabled: boolean
  /** 监控哪些环境（terminal/vscode/desktop）；空集 = 该家不监控（等于关） */
  envs: AgentEnv[]
}

/**
 * monitor 对外配置：从当前设置读取，设置变化时整体重启。
 *
 * v0.3.3 去掉了总开关：每家一个开关 + 一个环境集合，某家开关开但环境集合为空 = 那家不监控。
 * 全部都不监控 = 完全不轮询（纯陪伴）。
 *
 * v0.6.2 由四组手写字段改成按来源索引，这样加一家 Agent 不用再动 monitor 一行。
 */
export type MonitorConfig = Record<AgentSource, AgentSourceConfig>

export interface AgentMonitorOptions {
  /** 影子观察测试/诊断选项。不改变 onEvent 语义。 */
  shadow?: CodexSessionShadowOptions
}

/** monitor 依赖注入：时间源可注入以便测试；事件回调交给 main 派发副作用 */
export interface MonitorDeps {
  now(): number
  onEvent(event: AgentMonitorEvent): void
  /** 可选诊断日志（写文件用），不注入则不记 */
  log?(message: string): void
  /**
   * Codex 影子状态只读出口。只供日志、测试和对照诊断。
   * 不得接到桌宠动作、气泡或声音；不得改写 onEvent 语义。
   */
  onCodexState?(
    state: CodexDerivedState,
    migration?: CodexStateMigration,
    meta?: CodexShadowCallbackMeta
  ): void
  /**
   * 旧路径事件的只读诊断副本。在决定是否调用 onEvent 之后、实际 onEvent 之前记录；
   * 被 freshness/env/dedup/prime 忽略时也可记录。失败不得影响 onEvent。
   */
  onLegacyDiagnostic?(draft: CodexLegacyDiagnosticDraft): void
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
  private readonly codexShadow: CodexSessionShadow
  private legacyDiagSeq = 0
  private readonly legacyDiagSeen = new Set<string>()

  constructor(config: MonitorConfig, deps: MonitorDeps, options: AgentMonitorOptions = {}) {
    this.config = config
    this.deps = deps
    this.codexShadow = new CodexSessionShadow(options.shadow)
  }

  /** 某家是否真的在监控：开关开 且 至少选了一个环境 */
  private isActive(source: AgentSource): boolean {
    const c = this.config[source]
    return c.enabled && c.envs.length > 0
  }

  /** 有没有任何一家在监控 */
  private anyActive(): boolean {
    return AGENT_SOURCE_IDS.some((source) => this.isActive(source))
  }

  start(): void {
    this.stop()
    // 全都不监控（关掉 / 环境全不选）= 纯陪伴，不起轮询
    if (!this.anyActive()) return
    // 首轮 prime：把已有旧事件标记为 seen，避免启动后弹一堆历史提醒
    this.primed = false
    this.codexShadow.clear()
    this.tick()
    this.timer = setInterval(() => this.tick(), AGENT_POLL_INTERVAL_MS)
  }

  /** 立刻扫描一轮。start() 已包含首轮；后续追加内容用这个，避免再次 start() 把影子游标清掉。 */
  scanNow(): void {
    if (!this.anyActive()) return
    this.tick()
  }

  /** 只读影子快照，供测试和对照诊断。不改变用户可见行为。 */
  getCodexShadowSnapshots() {
    return this.codexShadow.snapshots()
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
      enabled: this.anyActive(),
      lastEvent: this.lastEvent,
      activeSessions: active,
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError
    }
  }

  /** 事件是否通过「按环境」过滤：看它所属 source 的环境集合是否包含它的 env */
  private passesEnvFilter(e: AgentMonitorEvent): boolean {
    return this.config[e.source].envs.includes(e.env)
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
      if (this.primed) this.emitLegacyDiagnostic(event, { dispatched: false, ignoredBy: ['dedup'] })
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
        this.emitLegacyDiagnostic(event, { dispatched: false, ignoredBy: ['no_working'] })
        return
      }
    }

    if (log && TERMINAL_KINDS.has(event.kind)) {
      log(`NOTIFY: ${event.source}/${event.env}/${event.kind} key=${event.sessionKey}`)
    }
    this.emitLegacyDiagnostic(event, { dispatched: true, ignoredBy: [] })
    this.lastEvent = event
    this.deps.onEvent(event)
  }

  /**
   * 方案 A：只把 source=codex 的旧事件交给 Codex 诊断回调。
   * 其他 Agent 的 onEvent 行为不变，也不写入 codex-legacy.jsonl。
   * 诊断写入失败不得影响 onEvent / lastEvent。prime 历史不写。
   */
  private emitLegacyDiagnostic(
    event: AgentMonitorEvent,
    info: { dispatched: boolean; ignoredBy: string[] }
  ): void {
    if (event.source !== 'codex') return
    if (!this.deps.onLegacyDiagnostic) return
    const observationId = `legacy:${event.id}`
    if (this.legacyDiagSeen.has(observationId)) return
    this.legacyDiagSeen.add(observationId)
    this.legacyDiagSeq += 1
    try {
      this.deps.onLegacyDiagnostic({
        observationId,
        seq: this.legacyDiagSeq,
        observedAt: this.deps.now(),
        eventTime: event.timestampMs,
        source: event.source,
        env: event.env,
        legacyKind: event.kind,
        rawPath: event.rawPath,
        sessionKey: event.sessionKey,
        dispatched: info.dispatched,
        ignoredBy: info.ignoredBy,
        productionVisible: info.dispatched && info.ignoredBy.length === 0
      })
    } catch {
      /* 诊断回调失败不得改变 onEvent 行为 */
    }
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
    const emitCodexShadow = this.primed

    try {
      const events: AgentMonitorEvent[] = []
      for (const source of AGENT_SOURCE_IDS) {
        if (this.isActive(source)) events.push(...AGENT_SCANNERS[source](now))
      }

      // 只处理最近 AGENT_EVENT_FRESH_MS 内、且通过「按环境过滤」的事件（老日志/未勾选的环境忽略）。
      // 时间戳缺失(=now)的会被保留，靠 seenIds 去重防重复。
      const annotated = events.map((raw) => {
        const event: AgentMonitorEvent = { ...raw, id: raw.id || eventId(raw) }
        const ignoredBy: string[] = []
        if (now - event.timestampMs > AGENT_EVENT_FRESH_MS) ignoredBy.push('freshness')
        if (!this.passesEnvFilter(event)) ignoredBy.push('env')
        return { event, ignoredBy }
      })
      if (this.primed) {
        for (const row of annotated) {
          if (row.ignoredBy.length) {
            this.emitLegacyDiagnostic(row.event, { dispatched: false, ignoredBy: row.ignoredBy })
          }
        }
      }
      const fresh = annotated.filter((row) => row.ignoredBy.length === 0).map((row) => row.event)
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
    }

    try {
      if (this.isActive('codex')) {
        this.codexShadow.observe(listCodexSessionFiles(now), now, {
          emitCallbacks: emitCodexShadow,
          onState: this.deps.onCodexState
        })
      }
    } catch (err) {
      this.deps.log?.(
        `codex shadow: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      // 首轮结束后解除 prime，之后的新事件才真正提醒
      this.primed = true
    }
  }
}
