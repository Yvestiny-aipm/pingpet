import type {
  CodexCause,
  CodexConfidence,
  CodexConnectionDimension,
  CodexDerivedState,
  CodexItemDimension,
  CodexLifecycleState,
  CodexNormalizedEventType,
  CodexObservationEvent,
  CodexObservationSource,
  CodexProcessDimension,
  CodexStateConflict,
  CodexStateEvidence,
  CodexStateMigration
} from '@shared/types'
import { CODEX_LIFECYCLE_TERMINALS } from '@shared/types'

/**
 * Codex 状态检测器（阶段 2）。
 *
 * 只把 CodexObservationEvent 收成多维派生状态和迁移证据。
 * Monitor 可以只读影子观察；不得改 classify，不得驱动桌宠。
 * 不做任务语义完成判断，不自动重试，不解包 App Server JSON-RPC。
 */

export interface CodexStateApplyResult {
  applied: boolean
  reason: 'migrated' | 'duplicate' | 'unchanged' | 'conflict_ignored'
  state: CodexDerivedState
  migration?: CodexStateMigration
}

export interface CodexProcessHint {
  status: CodexProcessDimension
  observedAt: number
  exitCode?: number
  signal?: string
}

const OFFICIAL_RUNNING: CodexNormalizedEventType[] = [
  'turn.started',
  'item.started',
  'item.updated'
]
const LOCAL_RUNNING: CodexNormalizedEventType[] = [
  'event_msg.task_started',
  'event_msg.item_started',
  'event_msg.item_updated'
]
const LIFECYCLE_TERMINALS = new Set<CodexLifecycleState>(CODEX_LIFECYCLE_TERMINALS)

/** 上层明确给出的 incomplete 触发器。Monitor 超时本轮不自动计算，只接受显式传入。 */
export type CodexIncompleteTrigger =
  | 'observation_ended_without_turn_terminal'
  | 'process_abnormal_exit'
  | 'output_truncated'
  | 'observation_timeout'

const USER_CANCEL_MARKERS = [
  'user_cancelled',
  'user_canceled',
  'cancelled by user',
  'canceled by user',
  'stopped by user',
  'user abort',
  'user_abort',
  '用户取消',
  '用户已取消',
  '用户按了',
  '用户中断'
]

export function emptyCodexDerivedState(observedAt = 0): CodexDerivedState {
  return {
    lifecycle: 'unknown',
    cause: 'unknown',
    process: 'not_observed',
    connection: 'unknown',
    session: 'not_loaded',
    turn: 'not_started',
    item: 'none',
    outputIntegrity: 'unknown',
    taskSemantics: 'not_verified',
    retryability: 'unknown',
    confidence: 'low',
    evidence: [],
    conflicts: [],
    observedAt
  }
}

function cloneState(state: CodexDerivedState): CodexDerivedState {
  return {
    ...state,
    evidence: [...state.evidence],
    conflicts: [...state.conflicts]
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function eventConfidence(event: CodexObservationEvent): CodexConfidence {
  if (isOfficialEvent(event)) return 'high'
  if (isLocalSessionEvent(event) && event.recognized) return 'medium'
  return 'low'
}

function sourceRank(event: CodexObservationEvent): number {
  if (isOfficialEvent(event)) return 3
  if (isLocalSessionEvent(event) && event.recognized) return 2
  return 1
}

/** 官方点号事件：必须同时核对 source、rawType、evidenceOrigin，不能只看 eventType。 */
export function isOfficialEvent(event: CodexObservationEvent): boolean {
  if (event.source !== 'exec_json') return false
  if (event.evidenceOrigin !== 'codex_exec_json') return false
  if (!event.recognized) return false
  const official = new Set<CodexNormalizedEventType>([
    'thread.started',
    'turn.started',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'item.started',
    'item.updated',
    'item.completed',
    'error'
  ])
  if (!official.has(event.eventType)) return false
  if (event.rawType && event.rawType !== event.eventType) return false
  return true
}

/** 本地 session JSONL：必须是 session 来源，不得把 event_msg.* 当成官方点号事件。 */
export function isLocalSessionEvent(event: CodexObservationEvent): boolean {
  return event.source === 'session_jsonl' && event.evidenceOrigin === 'codex_session_jsonl'
}

function isOfficialType(event: CodexObservationEvent, type: CodexNormalizedEventType): boolean {
  return isOfficialEvent(event) && event.eventType === type
}

function isLocalType(event: CodexObservationEvent, type: CodexNormalizedEventType): boolean {
  return isLocalSessionEvent(event) && event.eventType === type
}

function itemStatusOf(event: CodexObservationEvent): string | undefined {
  return event.itemStatus?.toLowerCase()
}

function itemKindOf(event: CodexObservationEvent): string | undefined {
  const raw = event.itemKind?.trim().toLowerCase()
  return raw ? raw.replace(/[\s-]+/g, '_') : undefined
}

function isFailedItemStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'error'
}

function isDeclinedItemStatus(status: string | undefined): boolean {
  return status === 'declined' || status === 'rejected'
}

function isSuccessItemStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'succeeded' || status === 'success'
}

function isErrorItemKind(kind: string | undefined): boolean {
  return kind === 'error'
}

function isAgentMessageKind(kind: string | undefined): boolean {
  return kind === 'agent_message' || kind === 'agentmessage'
}

function extractAbortReason(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const inner = asRecord(root?.payload) ?? root
  const innerError = asRecord(inner?.error)
  const rootError = asRecord(root?.error)
  return (
    asString(inner?.reason) ??
    asString(inner?.message) ??
    asString(innerError?.message) ??
    asString(innerError?.reason) ??
    asString(root?.reason) ??
    asString(root?.message) ??
    asString(rootError?.message) ??
    asString(rootError?.reason)
  )
}

function isExplicitUserCancel(reason: string | undefined): boolean {
  if (!reason) return false
  const lower = reason.toLowerCase()
  return USER_CANCEL_MARKERS.some((marker) => lower.includes(marker))
}

function materialKey(state: CodexDerivedState): string {
  return [
    state.lifecycle,
    state.cause,
    state.process,
    state.connection,
    state.session,
    state.turn,
    state.item,
    state.outputIntegrity,
    state.retryability,
    state.confidence
  ].join('|')
}

const EXPLICIT_ITEM_FAILURE = new Set<CodexItemDimension>(['failed', 'partial_failure', 'declined'])
const ITEM_DOWNGRADE = new Set<CodexItemDimension>(['unknown', 'none', 'running', 'succeeded'])

function mergeItemAfterFailure(previous: CodexItemDimension, next: CodexItemDimension): CodexItemDimension {
  if (next === 'failed' || next === 'declined') return next
  if (EXPLICIT_ITEM_FAILURE.has(previous) && ITEM_DOWNGRADE.has(next)) {
    // 本轮已有明确失败/拒绝：后续普通、unknown、agent_message 只能汇总为 partial_failure
    return 'partial_failure'
  }
  if (next === 'succeeded' && previous === 'unknown') {
    // error / 未知 item 缺少成功证据时，后续 agent_message 不得升格为 succeeded
    return 'unknown'
  }
  return next
}

/** 新 turn 才重置；unknown 不得覆盖本轮 tool_failed / 未证实错误。 */
function mergeCause(
  current: CodexCause,
  incoming: CodexCause | undefined,
  newTurn: boolean
): CodexCause {
  if (newTurn) return incoming ?? 'unknown'
  if (incoming === 'tool_failed') return 'tool_failed'
  if (incoming && incoming !== 'unknown') return incoming
  if (current === 'tool_failed') return 'tool_failed'
  return current
}

/** turn.completed 不得把失败轮次的 partial 改成 complete 或 unknown。 */
function mergeOutputIntegrity(
  current: CodexDerivedState['outputIntegrity'],
  incoming: CodexDerivedState['outputIntegrity'] | undefined,
  newTurn: boolean
): CodexDerivedState['outputIntegrity'] {
  if (newTurn) return incoming ?? 'unknown'
  if (current === 'partial' && (incoming === undefined || incoming === 'unknown' || incoming === 'complete')) {
    return 'partial'
  }
  return incoming ?? current
}

/** turn.completed 不能证明不必重试；未验证任务语义时保持 unknown。 */
function mergeRetryability(
  current: CodexDerivedState['retryability'],
  incoming: CodexDerivedState['retryability'] | undefined,
  newTurn: boolean
): CodexDerivedState['retryability'] {
  if (newTurn) return incoming && incoming !== 'never' ? incoming : 'unknown'
  if (!incoming || incoming === 'never') return current === 'never' ? 'unknown' : current
  return incoming
}

interface Intent {
  lifecycle?: CodexLifecycleState
  cause?: CodexCause
  session?: CodexDerivedState['session']
  turn?: CodexDerivedState['turn']
  item?: CodexItemDimension
  outputIntegrity?: CodexDerivedState['outputIntegrity']
  retryability?: CodexDerivedState['retryability']
  confidence?: CodexConfidence
  reason: string
}

function interpret(event: CodexObservationEvent): Intent | null {
  if (isOfficialType(event, 'thread.started') || isLocalType(event, 'session_meta')) {
    return { session: 'active', reason: `${event.eventType} → session active` }
  }

  if (isOfficialType(event, 'turn.started')) {
    return {
      lifecycle: 'running',
      cause: 'unknown',
      session: 'active',
      turn: 'in_progress',
      retryability: 'unknown',
      reason: 'official turn.started → running; reset current-turn item failure'
    }
  }
  if (isLocalType(event, 'event_msg.task_started')) {
    return {
      lifecycle: 'running',
      cause: 'unknown',
      session: 'active',
      turn: 'in_progress',
      retryability: 'unknown',
      reason:
        'local event_msg.task_started → running (session JSONL; not an official exec event); reset current-turn item failure'
    }
  }

  if (isOfficialType(event, 'item.started') || isOfficialType(event, 'item.updated')) {
    return {
      lifecycle: 'running',
      cause: 'unknown',
      session: 'active',
      turn: 'in_progress',
      item: 'running',
      reason: `official ${event.eventType} → running`
    }
  }
  if (isLocalType(event, 'event_msg.item_started') || isLocalType(event, 'event_msg.item_updated')) {
    return {
      lifecycle: 'running',
      cause: 'unknown',
      session: 'active',
      turn: 'in_progress',
      item: 'running',
      reason: `local ${event.eventType} → running (session JSONL)`
    }
  }

  if (isOfficialType(event, 'item.completed') || isLocalType(event, 'event_msg.item_completed')) {
    const status = itemStatusOf(event)
    const kind = itemKindOf(event)
    const official = isOfficialType(event, 'item.completed')
    const label = official ? 'official item.completed' : 'local event_msg.item_completed'
    if (isFailedItemStatus(status)) {
      return {
        lifecycle: 'running',
        cause: 'tool_failed',
        session: 'active',
        turn: 'in_progress',
        item: 'failed',
        outputIntegrity: 'partial',
        retryability: 'unknown',
        reason: `${label} status=${status} → running + tool_failed; not incomplete/turn failed`
      }
    }
    if (isDeclinedItemStatus(status)) {
      return {
        lifecycle: 'running',
        cause: 'tool_failed',
        session: 'active',
        turn: 'in_progress',
        item: 'declined',
        outputIntegrity: 'partial',
        retryability: 'unknown',
        reason: `${label} status=${status} → running + tool_failed; not incomplete/turn failed`
      }
    }
    if (isErrorItemKind(kind) && !status) {
      return {
        lifecycle: 'running',
        cause: 'unknown',
        session: 'active',
        turn: 'in_progress',
        item: 'unknown',
        outputIntegrity: 'partial',
        retryability: 'unknown',
        confidence: 'medium',
        reason:
          'item.completed with item.type=error but status missing; do not infer success; outputIntegrity=partial because the item ended without a verified outcome'
      }
    }
    if (isAgentMessageKind(kind)) {
      return {
        lifecycle: 'running',
        cause: 'unknown',
        session: 'active',
        turn: 'in_progress',
        item: 'succeeded',
        reason: `${label} item.type=agent_message → item completed; taskSemantics stays not_verified`
      }
    }
    if (!status) {
      return {
        lifecycle: 'running',
        cause: 'unknown',
        session: 'active',
        turn: 'in_progress',
        item: 'unknown',
        outputIntegrity: 'unknown',
        retryability: 'unknown',
        confidence: 'medium',
        reason: `${label} unknown item.type and status missing; do not infer success`
      }
    }
    if (isSuccessItemStatus(status)) {
      return {
        lifecycle: 'running',
        cause: 'unknown',
        session: 'active',
        turn: 'in_progress',
        item: 'succeeded',
        reason: `${label} status=${status} → running (item ended, turn still open)`
      }
    }
    return {
      lifecycle: 'running',
      cause: 'unknown',
      session: 'active',
      turn: 'in_progress',
      item: 'unknown',
      outputIntegrity: 'unknown',
      retryability: 'unknown',
      confidence: 'medium',
      reason: `${label} unrecognized status=${status}; do not infer success`
    }
  }

  if (isOfficialType(event, 'turn.completed')) {
    return {
      lifecycle: 'completed_signal',
      session: 'active',
      turn: 'completed',
      retryability: 'unknown',
      reason:
        'official turn.completed → completed_signal (not succeeded); turn completed, but task semantics and retryability are not verified; confidence is for the structured event, not task success'
    }
  }
  if (isLocalType(event, 'event_msg.task_complete')) {
    return {
      lifecycle: 'completed_signal',
      session: 'active',
      turn: 'completed',
      retryability: 'unknown',
      reason:
        'local event_msg.task_complete → completed_signal (not succeeded); turn completed, but task semantics and retryability are not verified; confidence is for the structured event, not task success'
    }
  }

  if (isOfficialType(event, 'turn.failed')) {
    return {
      lifecycle: 'failed',
      cause: 'turn_failed',
      session: 'active',
      turn: 'failed',
      outputIntegrity: 'unknown',
      retryability: 'unknown',
      reason: 'official turn.failed → failed'
    }
  }

  if (isOfficialType(event, 'turn.cancelled')) {
    const cancelReason = extractAbortReason(event.payload)
    if (isExplicitUserCancel(cancelReason)) {
      return {
        lifecycle: 'cancelled',
        cause: 'user_cancelled',
        session: 'active',
        turn: 'interrupted',
        outputIntegrity: 'partial',
        retryability: 'user_action',
        reason: `official turn.cancelled with explicit user cancel (${cancelReason}) → cancelled; retryability=user_action because the user stopped the turn and the detector must not auto-retry`
      }
    }
    return {
      lifecycle: 'cancelled',
      cause: 'unknown',
      session: 'active',
      turn: 'interrupted',
      outputIntegrity: 'partial',
      retryability: 'unknown',
      reason:
        'official turn.cancelled → cancelled (not failed); cause stays unknown unless payload explicitly indicates user cancel; retryability=unknown because protocol cancel is not verified as user cancel or safe auto-retry; taskSemantics stays not_verified'
    }
  }

  if (isOfficialType(event, 'error')) {
    return {
      lifecycle: 'unknown',
      cause: 'unknown',
      session: 'active',
      outputIntegrity: 'partial',
      retryability: 'unknown',
      reason: 'official error without turn terminal → unknown (not failed/succeeded)'
    }
  }

  if (isLocalType(event, 'event_msg.turn_aborted')) {
    const abortReason = extractAbortReason(event.payload)
    if (isExplicitUserCancel(abortReason)) {
      return {
        lifecycle: 'cancelled',
        cause: 'user_cancelled',
        session: 'active',
        turn: 'interrupted',
        retryability: 'user_action',
        reason: `local event_msg.turn_aborted with explicit user cancel (${abortReason}) → cancelled`
      }
    }
    return {
      lifecycle: 'unknown',
      cause: 'unknown',
      session: 'active',
      turn: 'interrupted',
      outputIntegrity: 'partial',
      retryability: 'unknown',
      reason: `local event_msg.turn_aborted reason=${abortReason ?? 'missing'} is not explicit user cancel → unknown`
    }
  }

  return null
}

export function isCodexLifecycleTerminal(lifecycle: CodexLifecycleState | undefined): boolean {
  return lifecycle !== undefined && LIFECYCLE_TERMINALS.has(lifecycle)
}

function isTerminalLifecycle(lifecycle: CodexLifecycleState | undefined): boolean {
  return isCodexLifecycleTerminal(lifecycle)
}

/** 官方 turn.started 或本地 task_started 都是新 turn 边界；即使没有 turnId 也按事件重置。 */
function isNewTurnBoundary(event: CodexObservationEvent): boolean {
  return isOfficialType(event, 'turn.started') || isLocalType(event, 'event_msg.task_started')
}

function canFinalizeIncomplete(state: CodexDerivedState): boolean {
  if (isTerminalLifecycle(state.lifecycle)) return false
  if (state.turn === 'completed' || state.turn === 'failed' || state.turn === 'interrupted') return false
  return state.turn === 'in_progress' || state.lifecycle === 'running'
}

/**
 * 观察失联只改 connection。明确终态或未来 process_exit 都优先，不得用 stale 覆盖。
 * 是否曾有活动 turn / 是否过了产品阈值，由影子观察层判断；这里只挡不安全的覆盖。
 */
export function canMarkObservationStale(state: CodexDerivedState): boolean {
  if (isTerminalLifecycle(state.lifecycle)) return false
  if (state.cause === 'process_exit') return false
  if (state.turn === 'completed' || state.turn === 'failed') return false
  if (state.connection === 'stale') return false
  return true
}

function incompleteCause(trigger: CodexIncompleteTrigger): CodexCause {
  if (trigger === 'process_abnormal_exit') return 'process_exit'
  if (trigger === 'output_truncated') return 'output_truncated'
  if (trigger === 'observation_timeout') return 'monitor_disconnected'
  return 'unknown'
}

export class CodexStateDetector {
  private state: CodexDerivedState
  private readonly migrations: CodexStateMigration[] = []
  private readonly seen = new Set<string>()
  private evidenceSeq = 0
  private lastTerminalRank = 0
  private lastTerminalLifecycle: CodexLifecycleState = 'unknown'
  /** 当前 turn 是否见过明确 item 失败/拒绝。仅官方 turn.started / 本地 task_started 清除。 */
  private hasExplicitItemFailure = false

  constructor(observedAt = 0) {
    this.state = emptyCodexDerivedState(observedAt)
  }

  getState(): CodexDerivedState {
    return cloneState(this.state)
  }

  getMigrations(): readonly CodexStateMigration[] {
    return this.migrations
  }

  apply(event: CodexObservationEvent): CodexStateApplyResult {
    if (this.seen.has(event.dedupKey)) {
      return { applied: false, reason: 'duplicate', state: this.getState() }
    }
    this.seen.add(event.dedupKey)

    const previous = cloneState(this.state)
    const evidence = this.toEvidence(event)
    let intent = interpret(event)
    const next = cloneState(this.state)
    next.observedAt = event.observedAt
    next.connection = 'connected'
    next.taskSemantics = 'not_verified'
    if (event.sessionId) next.sessionId = event.sessionId
    if (event.threadId) next.threadId = event.threadId
    if (event.turnId) next.turnId = event.turnId

    if (intent?.lifecycle === 'unknown' && isOfficialType(event, 'error') && isTerminalLifecycle(previous.lifecycle)) {
      intent = {
        ...intent,
        lifecycle: undefined,
        reason: `${intent.reason}; existing ${previous.lifecycle} preserved`
      }
    }

    if (!intent) {
      if (event.eventType === 'unknown' || event.eventType === 'unsupported' || event.eventType === 'malformed') {
        next.evidence = [evidence]
        return this.commit(previous, next, event, evidence, {
          reason: `${event.eventType} kept as unknown evidence; no lifecycle guess`,
          cause: previous.cause,
          confidence: 'low',
          source: event.source
        })
      }
      next.evidence = [evidence]
      if (materialKey(previous) === materialKey({ ...next, evidence: previous.evidence })) {
        this.state = next
        return { applied: false, reason: 'unchanged', state: this.getState() }
      }
      return this.commit(previous, next, event, evidence, {
        reason: `${event.eventType} recorded without lifecycle change`,
        cause: next.cause,
        confidence: eventConfidence(event),
        source: event.source
      })
    }

    const incomingLifecycle = intent.lifecycle
    const incomingRank = sourceRank(event)

    if (
      incomingLifecycle &&
      isTerminalLifecycle(incomingLifecycle) &&
      isTerminalLifecycle(this.lastTerminalLifecycle) &&
      incomingLifecycle !== this.lastTerminalLifecycle &&
      incomingRank < this.lastTerminalRank
    ) {
      const conflict: CodexStateConflict = {
        observedAt: event.observedAt,
        keptLifecycle: next.lifecycle,
        ignoredEventType: event.eventType,
        ignoredSource: event.source,
        reason: `ignored lower-confidence ${event.source}/${event.eventType}; kept ${this.lastTerminalLifecycle}`
      }
      next.conflicts = [...next.conflicts, conflict]
      next.evidence = [evidence]
      const migration = this.recordMigration(previous, next, {
        cause: next.cause,
        evidenceIds: [evidence.id],
        source: event.source,
        observedAt: event.observedAt,
        eventTime: event.eventTime ?? null,
        confidence: eventConfidence(event),
        reason: conflict.reason,
        eventDedupKey: event.dedupKey
      })
      this.state = next
      return { applied: true, reason: 'conflict_ignored', state: this.getState(), migration }
    }

    if (
      incomingLifecycle &&
      isTerminalLifecycle(incomingLifecycle) &&
      isTerminalLifecycle(this.lastTerminalLifecycle) &&
      incomingLifecycle !== this.lastTerminalLifecycle &&
      incomingRank === this.lastTerminalRank
    ) {
      next.lifecycle = 'unknown'
      next.cause = 'unknown'
      next.confidence = 'low'
      next.turn = 'unknown'
      next.conflicts = [
        ...next.conflicts,
        {
          observedAt: event.observedAt,
          keptLifecycle: 'unknown',
          ignoredEventType: event.eventType,
          ignoredSource: event.source,
          reason: `conflicting terminals ${this.lastTerminalLifecycle} vs ${incomingLifecycle} at equal rank → unknown`
        }
      ]
      next.evidence = [evidence]
      this.lastTerminalLifecycle = 'unknown'
      this.lastTerminalRank = incomingRank
      return this.commit(previous, next, event, evidence, {
        reason: `equal-rank terminal conflict → unknown`,
        cause: 'unknown',
        confidence: 'low',
        source: event.source
      })
    }

    const newTurn = isNewTurnBoundary(event)
    if (newTurn) {
      this.beginCurrentTurn(next, event)
    }

    if (intent.session) next.session = intent.session
    if (intent.turn) next.turn = intent.turn
    if (intent.item === 'failed' || intent.item === 'declined') {
      this.hasExplicitItemFailure = true
    }
    if (intent.item) {
      next.item = mergeItemAfterFailure(next.item, intent.item)
    }
    if (
      !newTurn &&
      this.hasExplicitItemFailure &&
      ITEM_DOWNGRADE.has(next.item)
    ) {
      next.item = 'partial_failure'
    }
    next.outputIntegrity = mergeOutputIntegrity(next.outputIntegrity, intent.outputIntegrity, newTurn)
    next.retryability = mergeRetryability(next.retryability, intent.retryability, newTurn)

    if (incomingLifecycle) {
      next.lifecycle = incomingLifecycle
      next.cause =
        incomingLifecycle === 'cancelled'
          ? (intent.cause ?? 'unknown')
          : mergeCause(next.cause, intent.cause, newTurn)
      next.confidence = intent.confidence ?? eventConfidence(event)
      if (isTerminalLifecycle(incomingLifecycle)) {
        this.lastTerminalLifecycle = incomingLifecycle
        this.lastTerminalRank = incomingRank
      }
      if (incomingLifecycle === 'running') {
        this.lastTerminalLifecycle = 'unknown'
        this.lastTerminalRank = 0
      }
    }

    next.evidence = [evidence]
    let reason = intent.reason
    if (!newTurn && next.cause === 'tool_failed' && intent.cause !== 'tool_failed') {
      reason += '; kept tool_failed from earlier item failure in this turn'
    }
    if (!newTurn && next.item === 'partial_failure' && intent.item && intent.item !== 'partial_failure') {
      reason += '; kept item=partial_failure after explicit item failure in this turn'
    }
    if (!newTurn && next.outputIntegrity === 'partial' && intent.outputIntegrity !== 'partial') {
      reason += '; kept outputIntegrity=partial because this turn already has an unverified or failed item'
    }
    return this.commit(previous, next, event, evidence, {
      reason,
      cause: next.cause,
      confidence: next.confidence,
      source: event.source
    })
  }

  /**
   * 新 turn 重置当前 turn 的 item / cause / outputIntegrity / retryability。
   * 不重建整个 state；上一轮失败留在 migrations 的 previousState 与历史 evidenceIds。
   * 官方 turn.started 没有 turnId 时也按事件边界断开上一轮 turnId。
   */
  private beginCurrentTurn(next: CodexDerivedState, event: CodexObservationEvent): void {
    this.hasExplicitItemFailure = false
    next.item = 'none'
    next.cause = 'unknown'
    next.outputIntegrity = 'unknown'
    next.retryability = 'unknown'
    if (event.turnId) {
      next.turnId = event.turnId
    } else {
      delete next.turnId
    }
  }

  /**
   * 观察端失联。只改 connection，不覆盖最后已知 Codex 生命周期，更不能变成 failed。
   */
  markConnection(connection: Extract<CodexConnectionDimension, 'stale' | 'disconnected'>, observedAt: number): CodexStateApplyResult {
    const previous = cloneState(this.state)
    const next = cloneState(this.state)
    next.connection = connection
    next.observedAt = observedAt
    next.taskSemantics = 'not_verified'
    const evidence: CodexStateEvidence = {
      id: this.nextEvidenceId(),
      eventDedupKey: `observer:${connection}:${observedAt}`,
      source: previous.evidence[0]?.source ?? 'exec_json',
      evidenceOrigin: previous.evidence[0]?.evidenceOrigin ?? 'codex_exec_json',
      eventType: 'unknown',
      observedAt,
      note: `observer ${connection}; last lifecycle ${previous.lifecycle} preserved`
    }
    next.evidence = [evidence]
    return this.commit(previous, next, undefined, evidence, {
      reason: `observer ${connection}; lifecycle stays ${previous.lifecycle}`,
      cause: previous.cause,
      confidence: previous.confidence,
      source: 'observer'
    })
  }

  /**
   * PingPet 产品策略：观察超时失联。
   * 不改 lifecycle/cause/item，不调用 applyProcess，不把失联写成 failed/cancelled/process_exit。
   */
  markObservationStale(observedAt: number): CodexStateApplyResult {
    const previous = cloneState(this.state)
    if (!canMarkObservationStale(previous)) {
      return { applied: false, reason: 'unchanged', state: this.getState() }
    }
    const next = cloneState(this.state)
    next.connection = 'stale'
    next.observedAt = observedAt
    next.taskSemantics = 'not_verified'
    const evidence: CodexStateEvidence = {
      id: this.nextEvidenceId(),
      eventDedupKey: 'observer:observation_stale',
      source: previous.evidence[0]?.source ?? 'session_jsonl',
      evidenceOrigin: previous.evidence[0]?.evidenceOrigin ?? 'codex_session_jsonl',
      eventType: 'unknown',
      observedAt,
      note: `observation_stale; last lifecycle ${previous.lifecycle} preserved; item=${previous.item} cause=${previous.cause}`
    }
    next.evidence = [evidence]
    return this.commit(previous, next, undefined, evidence, {
      reason: `observation_stale; connection=stale; last known agent facts preserved; lifecycle stays ${previous.lifecycle}`,
      cause: previous.cause,
      confidence: previous.confidence,
      source: 'observer',
      eventDedupKey: evidence.eventDedupKey
    })
  }

  /**
   * 只有整轮没有终态、且上层给出明确 incomplete 证据时才进入 incomplete。
   * 单个工具失败不得走这里。Monitor 超时本轮不自动算，只接受 observation_timeout。
   */
  finalizeIncomplete(observedAt: number, trigger: CodexIncompleteTrigger): CodexStateApplyResult {
    const previous = cloneState(this.state)
    if (!canFinalizeIncomplete(previous)) {
      return { applied: false, reason: 'unchanged', state: this.getState() }
    }
    const next = this.buildIncompleteState(previous, observedAt, trigger)
    const evidence: CodexStateEvidence = {
      id: this.nextEvidenceId(),
      eventDedupKey: `finalize:${trigger}:${observedAt}`,
      source: previous.evidence[0]?.source ?? 'exec_json',
      evidenceOrigin: previous.evidence[0]?.evidenceOrigin ?? 'codex_exec_json',
      eventType: 'unknown',
      observedAt,
      note: `finalize incomplete via ${trigger}`
    }
    next.evidence = [evidence]
    this.lastTerminalLifecycle = 'incomplete'
    this.lastTerminalRank = 1
    return this.commit(previous, next, undefined, evidence, {
      reason: `explicit ${trigger} → incomplete (turn was open, no turn terminal)`,
      cause: next.cause,
      confidence: 'medium',
      source: trigger === 'process_abnormal_exit' ? 'process' : 'observer'
    })
  }

  /** 进程证据。正常退出不改生命周期；异常退出且 turn 仍打开时才可落到 incomplete。 */
  applyProcess(hint: CodexProcessHint): CodexStateApplyResult {
    const previous = cloneState(this.state)
    const abnormal =
      hint.status === 'exited' &&
      ((hint.exitCode !== undefined && hint.exitCode !== 0) || Boolean(hint.signal))
    if (abnormal && canFinalizeIncomplete(previous)) {
      return this.finalizeIncomplete(hint.observedAt, 'process_abnormal_exit')
    }
    const next = cloneState(this.state)
    next.process = hint.status
    next.observedAt = hint.observedAt
    next.taskSemantics = 'not_verified'
    const note = `process ${hint.status}` + (hint.exitCode !== undefined ? ` exit=${hint.exitCode}` : '')
    const evidence: CodexStateEvidence = {
      id: this.nextEvidenceId(),
      eventDedupKey: `process:${hint.status}:${hint.observedAt}`,
      source: previous.evidence[0]?.source ?? 'session_jsonl',
      evidenceOrigin: previous.evidence[0]?.evidenceOrigin ?? 'codex_session_jsonl',
      eventType: 'unknown',
      observedAt: hint.observedAt,
      note
    }
    next.evidence = [evidence]
    return this.commit(previous, next, undefined, evidence, {
      reason: `${note}; does not override lifecycle ${previous.lifecycle}`,
      cause: previous.cause,
      confidence: 'low',
      source: 'process'
    })
  }

  private buildIncompleteState(
    previous: CodexDerivedState,
    observedAt: number,
    trigger: CodexIncompleteTrigger
  ): CodexDerivedState {
    const next = cloneState(previous)
    next.lifecycle = 'incomplete'
    next.cause = incompleteCause(trigger)
    next.turn = 'unknown'
    next.outputIntegrity = 'partial'
    next.retryability = 'unknown'
    next.observedAt = observedAt
    next.taskSemantics = 'not_verified'
    next.confidence = 'medium'
    if (trigger === 'process_abnormal_exit') next.process = 'exited'
    return next
  }

  private toEvidence(event: CodexObservationEvent): CodexStateEvidence {
    return {
      id: this.nextEvidenceId(),
      eventDedupKey: event.dedupKey,
      source: event.source,
      rawType: event.rawType,
      evidenceOrigin: event.evidenceOrigin,
      eventType: event.eventType,
      observedAt: event.observedAt,
      note: event.parseNote
    }
  }

  private nextEvidenceId(): string {
    this.evidenceSeq += 1
    return `ev-${this.evidenceSeq}`
  }

  private recordMigration(
    previous: CodexDerivedState,
    next: CodexDerivedState,
    fields: Omit<CodexStateMigration, 'previousState' | 'nextState'>
  ): CodexStateMigration {
    const migration: CodexStateMigration = {
      previousState: previous,
      nextState: cloneState(next),
      ...fields
    }
    this.migrations.push(migration)
    return migration
  }

  private commit(
    previous: CodexDerivedState,
    next: CodexDerivedState,
    event: CodexObservationEvent | undefined,
    evidence: CodexStateEvidence,
    meta: {
      reason: string
      cause: CodexCause
      confidence: CodexConfidence
      source: CodexObservationSource | 'observer' | 'process'
      eventDedupKey?: string
    }
  ): CodexStateApplyResult {
    if (next.lifecycle === 'succeeded') {
      next.lifecycle = 'unknown'
      next.cause = 'unknown'
      meta.reason = `${meta.reason}; detector refused to emit succeeded`
    }
    if (previous.connection === 'stale' && next.connection === 'connected') {
      meta.reason = `${meta.reason}; observation_recovered`
    }
    this.state = next
    if (materialKey(previous) === materialKey(next) && previous.conflicts.length === next.conflicts.length) {
      return { applied: false, reason: 'unchanged', state: this.getState() }
    }
    const migration = this.recordMigration(previous, next, {
      cause: meta.cause,
      evidenceIds: [evidence.id],
      source: meta.source,
      observedAt: next.observedAt,
      eventTime: event?.eventTime ?? null,
      confidence: meta.confidence,
      reason: meta.reason,
      eventDedupKey: event?.dedupKey ?? meta.eventDedupKey
    })
    return { applied: true, reason: 'migrated', state: this.getState(), migration }
  }
}

export const CODEX_RUNNING_EVENT_TYPES = { official: OFFICIAL_RUNNING, local: LOCAL_RUNNING }
