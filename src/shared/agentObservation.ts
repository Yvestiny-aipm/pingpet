import type { AgentSource } from './types'

/**
 * 通用 Agent 观察类型（阶段 1）。
 *
 * 只描述「看到了什么 / 能声明什么」，不描述桌宠该做什么。
 * 不依赖 Codex 专用事件名，不写入旧 AgentMonitorEvent。
 *
 * 四层必须分开；本文件只定义前两层：
 * 1. 原始观察事件 AgentObservation
 * 2. 通用派生状态 AgentDerivedState
 * 3. 旧 Monitor 兼容事件（本阶段不实现）
 * 4. 用户可见状态（本阶段不实现）
 */

/** 生产 Adapter 应使用 AgentSource；测试和未来 Agent 可用其它稳定 id。不得用文件路径当 id。 */
export type GenericAgentId = AgentSource | (string & {})

export type AgentAdapterId = string

/**
 * 观察通道。这是通道种类，不是文件系统路径。
 * 禁止把某家 Agent 的本地目录写进这个枚举。
 */
export type AgentObservationChannel =
  | 'official_stream'
  | 'session_file'
  | 'transcript_file'
  | 'roster'
  | 'text_log'
  | 'process'
  | 'file_activity'

export type AgentRecognition = 'recognized' | 'unknown' | 'unsupported' | 'malformed' | 'partial'

/**
 * 对结构化迁移是否成立的置信度。
 * 不是「任务已经成功完成」的置信度。high 不得当成 succeeded。
 */
export type AgentConfidence = 'high' | 'medium' | 'low'

export type AgentEvidenceKind = 'structured' | 'text_keyword' | 'file_activity' | 'process_hint' | 'observer'

/**
 * 通用生命周期。刻意不包含 succeeded。
 * completed_signal 只表示协议/回合结束，不是任务成功。
 * waiting_* 只有明确证据才能 observed；不得当缺省值。
 * failed 只表示工作单元级失败，不是所有错误的兜底。
 */
export type AgentLifecycle =
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'completed_signal'
  | 'cancelled'
  | 'failed'
  | 'incomplete'
  | 'unknown'

export const AGENT_LIFECYCLES: readonly AgentLifecycle[] = [
  'running',
  'waiting_input',
  'waiting_approval',
  'completed_signal',
  'cancelled',
  'failed',
  'incomplete',
  'unknown'
]

/** 通用层禁止的任务成功生命周期。Codex 专用类型仍可自留 succeeded，互不改写。 */
export type AgentForbiddenLifecycle = 'succeeded'

export const AGENT_LIFECYCLE_TERMINALS: readonly AgentLifecycle[] = [
  'completed_signal',
  'cancelled',
  'failed',
  'incomplete'
]

/**
 * 通用 cause。只收跨 Agent 能说清的值。
 * 额度 / 鉴权 / 网络 / 等待 等预留 cause 不得在通用层赋值。
 */
export type AgentCause =
  | 'tool_failed'
  | 'turn_failed'
  | 'user_cancelled'
  | 'process_exit'
  | 'output_truncated'
  | 'monitor_disconnected'
  | 'unknown'

export type AgentConnection = 'connected' | 'stale' | 'disconnected' | 'unknown'
export type AgentProcess = 'not_observed' | 'alive' | 'exited' | 'unknown'
export type AgentSession = 'not_loaded' | 'idle' | 'active' | 'system_error' | 'unknown'
export type AgentTurn =
  | 'not_started'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'unknown'
export type AgentItem =
  | 'none'
  | 'running'
  | 'succeeded'
  | 'partial_failure'
  | 'failed'
  | 'declined'
  | 'unknown'
export type AgentOutputIntegrity = 'complete' | 'partial' | 'none' | 'unknown'
export type AgentTaskSemantics =
  | 'completed'
  | 'partially_completed'
  | 'blocked'
  | 'cancelled'
  | 'not_verified'
  | 'unknown'
/**
 * never 只表示产品禁止自动重试，不是「已经成功所以不必重试」。
 * completed_signal / taskSemantics=not_verified 时用 unknown。
 */
export type AgentRetryability = 'never' | 'safe_retry' | 'backoff' | 'user_action' | 'reauth' | 'unknown'

export const AGENT_STATE_DIMENSIONS = [
  'lifecycle',
  'cause',
  'connection',
  'process',
  'session',
  'turn',
  'item',
  'outputIntegrity',
  'taskSemantics',
  'retryability'
] as const

export type AgentStateDimension = (typeof AGENT_STATE_DIMENSIONS)[number]

/**
 * 维度存在性。三者不能互相冒充。
 * - observed：有明确值
 * - unknown：该维度可观察，但当前证据不足
 * - unsupported：见 DimensionCapabilityKind，由能力表按 agent+adapter/channel+dimension 声明
 */
export type Dimension<T> =
  | { presence: 'observed'; value: T }
  | { presence: 'unknown' }
  | { presence: 'unsupported' }

export type DimensionPresence = Dimension<unknown>['presence']

/**
 * 能力表对某一维度的静态声明。不是运行时观察结果。
 *
 * not_observed_by_adapter：这个 Adapter/channel 现在不观察它；
 * 同一 Agent 的其它 Adapter 仍可能观察（例如 Codex session shadow 不看进程，
 * 未来 process hint Adapter 可以看）。
 *
 * unsupported_by_agent：这个 Agent 没有该维度（例如没有 turn 概念）。
 * 不得用「本次没看到」写成 unsupported_by_agent。
 */
export type DimensionCapabilityKind =
  | 'supported'
  | 'unknown_only'
  | 'not_observed_by_adapter'
  | 'unsupported_by_agent'

export type FeatureSupport = 'supported' | 'partial' | 'unsupported'

export interface AgentAdapterIdentity {
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  channel: AgentObservationChannel
  /** 协议或 Adapter 版本标签，不是文件路径 */
  adapterVersion: string
  protocolLabel?: string
  experimental: boolean
}

/**
 * Adapter 能力。按 agentId + adapterId/channel + dimension 隔离。
 * 不得把「当前 channel 不观察」写成「该 Agent 永远不支持」。
 */
export interface AgentAdapterCapability {
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  channel: AgentObservationChannel
  channels: readonly AgentObservationChannel[]
  dimensions: Record<AgentStateDimension, DimensionCapabilityKind>
  structuredLifecycleEvents: FeatureSupport
  userCancelEvidence: FeatureSupport
  processEvidence: DimensionCapabilityKind
  eventTime: 'supported' | 'unsupported'
  stableDedupKey: 'supported' | 'unsupported'
}

/** 脱敏后的字段存在性。不得带 prompt / 命令 / token / 路径 / 正文。 */
export interface AgentPayloadDigest {
  fieldNames: readonly string[]
  rawType?: string
  redacted: true
}

export type IdentityRefSource = 'payload' | 'filename' | 'timestamp' | 'sessionKey' | 'invented'

export interface AgentObservation {
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  channel: AgentObservationChannel
  /** Adapter 自己的事件名，不是 Codex 专用枚举 */
  eventName: string
  recognition: AgentRecognition
  payloadDigest: AgentPayloadDigest
  sessionRef?: string
  threadRef?: string
  turnRef?: string
  itemRef?: string
  /** Agent 自己的时间。缺则省略，不得用 observedAt 填入 */
  eventTime?: number
  observedAt: number
  evidenceOrigin: string
  confidence: AgentConfidence
  dedupKey: string
  evidenceKind?: AgentEvidenceKind
}

export interface AgentStateEvidence {
  id: string
  eventDedupKey: string
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  channel: AgentObservationChannel
  evidenceOrigin: string
  eventName: string
  observedAt: number
  evidenceKind: AgentEvidenceKind
  note?: string
}

export interface AgentStateConflict {
  observedAt: number
  keptLifecycle: AgentLifecycle
  ignoredEventName: string
  ignoredChannel: AgentObservationChannel
  reason: string
}

/** 多维派生状态。不得压成单个 kind，也不得带 legacyEquivalent / 展示字段。 */
export interface AgentDerivedState {
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  lifecycle: Dimension<AgentLifecycle>
  cause: Dimension<AgentCause>
  connection: Dimension<AgentConnection>
  process: Dimension<AgentProcess>
  session: Dimension<AgentSession>
  turn: Dimension<AgentTurn>
  item: Dimension<AgentItem>
  outputIntegrity: Dimension<AgentOutputIntegrity>
  taskSemantics: Dimension<AgentTaskSemantics>
  retryability: Dimension<AgentRetryability>
  confidence: AgentConfidence
  evidence: AgentStateEvidence[]
  conflicts: AgentStateConflict[]
  observedAt: number
  sessionRef?: string
  threadRef?: string
  turnRef?: string
  itemRef?: string
  /**
   * Agent 专用只读扩展。通用聚合器不得把它提升为核心事实。
   * Codex 用它保留 detector 的 process=not_observed 等专用值。
   */
  extension?: Readonly<Record<string, unknown>>
}

/**
 * 只有原始 payload 明确给出的标识才能留下。
 * 文件名、时间戳、sessionKey、自造字符串一律拒绝，返回 undefined。
 */
export function acceptIdentityRef(raw: unknown, source: IdentityRefSource): string | undefined {
  if (source !== 'payload') return undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed ? trimmed : undefined
}

/** 从已解析对象里只记录允许出现的键名，不复制值。 */
export function digestAllowedFields(payload: unknown, allowedKeys: readonly string[]): AgentPayloadDigest {
  const fieldNames: string[] = []
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) fieldNames.push(key)
    }
  }
  return { fieldNames, redacted: true }
}

export function capabilityKey(
  agentId: GenericAgentId,
  adapterId: AgentAdapterId,
  channel: AgentObservationChannel,
  dimension: AgentStateDimension
): string {
  return `${agentId}\u0000${adapterId}\u0000${channel}\u0000${dimension}`
}

/** completed_signal 永远不是任务成功。阶段 1 通用层没有 succeeded。 */
export function lifecycleMeansTaskSuccess(_lifecycle: AgentLifecycle): false {
  return false
}

export function isForbiddenLifecycle(value: string): value is AgentForbiddenLifecycle {
  return value === 'succeeded'
}
