import type { CodexConfidence, CodexDerivedState, CodexLifecycleState, CodexStateEvidence } from '@shared/types'
import { CODEX_LIFECYCLE_TERMINALS } from '@shared/types'

/**
 * 阶段 5：Codex 候选用户状态（影子映射）。
 *
 * 只从 CodexDerivedState 算出对照用的候选值。
 * 本函数不直接驱动通知、桌宠、气泡、声音或自动重试。
 * 静默姿态由 codexVisiblePresentation 单独门控，不得把 candidate 伪装成旧 done。
 * completed_signal ≠ success；检测器不会产生 succeeded，这里也不得发明 succeeded。
 */

export type CodexCandidateKind =
  | 'working'
  | 'waiting'
  | 'completed_signal'
  | 'completed_with_partial_failure'
  | 'cancelled'
  | 'incomplete'
  | 'failed'
  | 'unknown'

export type CodexCandidateLegacyEquivalent = 'working' | 'done' | 'needs_attention' | 'failed' | 'unknown'

export type CodexCandidatePetState = 'working' | 'waiting' | 'cautious' | 'celebrating' | 'sad' | 'unknown'

export type CodexCandidateNotification =
  | 'none'
  | 'candidate_attention'
  | 'candidate_completion'
  | 'candidate_failure'
  | 'candidate_unknown'

export type CodexCandidateRetryRecommendation = 'none' | 'not_now' | 'user_decision' | 'unknown'

export interface CodexCandidateState {
  candidate: CodexCandidateKind
  legacyEquivalent: CodexCandidateLegacyEquivalent
  candidatePetState: CodexCandidatePetState
  notificationCandidate: CodexCandidateNotification
  /** 影子映射永远 false。正式通知未接入。 */
  shouldNotify: false
  requiresUserAction: boolean
  retryRecommendation: CodexCandidateRetryRecommendation
  reasonCodes: string[]
  confidence: CodexConfidence
}

/** 覆盖顺序。先匹配到的规则生效。observation_stale 不是独立 candidate，只把非终态收成 unknown。 */
export const CODEX_CANDIDATE_PRIORITY = [
  'failed',
  'cancelled',
  'incomplete',
  'observation_stale',
  'waiting',
  'completed_with_partial_failure',
  'completed_signal',
  'running_with_partial_failure',
  'working',
  'unknown'
] as const

const LIFECYCLE_TERMINALS = new Set<CodexLifecycleState>(CODEX_LIFECYCLE_TERMINALS)

const ITEM_FAILURE_ITEMS = new Set(['failed', 'partial_failure', 'declined'])

function evidenceShowsItemFailure(evidence: readonly CodexStateEvidence[]): boolean {
  return evidence.some((ev) => {
    const note = (ev.note ?? '').toLowerCase()
    return (
      note.includes('tool_failed') ||
      note.includes('status=failed') ||
      note.includes('status=declined') ||
      note.includes('status=error')
    )
  })
}

function hasItemFailureFact(state: CodexDerivedState): boolean {
  if (state.cause === 'tool_failed') return true
  if (ITEM_FAILURE_ITEMS.has(state.item)) return true
  if (state.outputIntegrity === 'partial' && evidenceShowsItemFailure(state.evidence)) return true
  return false
}

function isTurnLevelFailed(state: CodexDerivedState): boolean {
  if (state.lifecycle !== 'failed') return false
  if (state.cause === 'tool_failed') return false
  if (state.cause === 'process_exit') return false
  if (state.cause === 'monitor_disconnected') return false
  if (state.cause === 'output_truncated') return false
  return state.cause === 'turn_failed' || state.turn === 'failed'
}

function isWaitingLifecycle(state: CodexDerivedState): boolean {
  return state.lifecycle === 'waiting_input' || state.lifecycle === 'waiting_approval'
}

/** 观察失联：candidate=unknown。不得压过明确终态或未来 process_exit。 */
function isObservationStale(state: CodexDerivedState): boolean {
  if (state.connection !== 'stale') return false
  if (LIFECYCLE_TERMINALS.has(state.lifecycle)) return false
  if (state.cause === 'process_exit') return false
  return true
}

function withBase(
  partial: Omit<CodexCandidateState, 'shouldNotify' | 'confidence'>,
  confidence: CodexConfidence
): CodexCandidateState {
  return {
    ...partial,
    shouldNotify: false,
    confidence
  }
}

/**
 * 把多维派生状态收成影子候选用户状态。
 * 按 CODEX_CANDIDATE_PRIORITY 决策，不得只看单个字段。
 */
export function mapCodexDerivedToCandidate(state: CodexDerivedState): CodexCandidateState {
  const confidence = state.confidence

  if (isTurnLevelFailed(state)) {
    return withBase(
      {
        candidate: 'failed',
        legacyEquivalent: 'failed',
        candidatePetState: 'sad',
        notificationCandidate: 'candidate_failure',
        requiresUserAction: true,
        retryRecommendation: 'unknown',
        reasonCodes: ['turn_failed', 'candidate_not_user_visible', 'task_semantics_not_verified']
      },
      confidence
    )
  }

  if (state.lifecycle === 'cancelled') {
    const reasonCodes = ['protocol_cancelled', 'candidate_not_user_visible', 'task_semantics_not_verified']
    if (state.cause === 'user_cancelled') reasonCodes.unshift('user_cancelled')
    return withBase(
      {
        candidate: 'cancelled',
        legacyEquivalent: 'needs_attention',
        candidatePetState: 'cautious',
        notificationCandidate: 'candidate_attention',
        requiresUserAction: true,
        retryRecommendation: 'user_decision',
        reasonCodes
      },
      confidence
    )
  }

  if (state.lifecycle === 'incomplete') {
    const reasonCodes = ['incomplete', 'candidate_not_user_visible', 'task_semantics_not_verified']
    if (state.cause === 'process_exit') reasonCodes.unshift('process_exit')
    if (state.cause === 'output_truncated') reasonCodes.unshift('output_truncated')
    if (state.cause === 'monitor_disconnected') reasonCodes.unshift('observation_timeout')
    if (state.cause === 'unknown') reasonCodes.unshift('observation_ended_without_turn_terminal')
    return withBase(
      {
        candidate: 'incomplete',
        legacyEquivalent: 'needs_attention',
        candidatePetState: 'cautious',
        notificationCandidate: 'candidate_attention',
        requiresUserAction: true,
        retryRecommendation: 'unknown',
        reasonCodes
      },
      confidence
    )
  }

  if (isObservationStale(state)) {
    const reasonCodes = [
      'observation_stale',
      'do_not_infer_outcome',
      'candidate_not_user_visible',
      'task_semantics_not_verified'
    ]
    if (hasItemFailureFact(state)) reasonCodes.push('tool_failed_fact_present_not_turn_failed')
    return withBase(
      {
        candidate: 'unknown',
        legacyEquivalent: 'unknown',
        candidatePetState: 'unknown',
        notificationCandidate: 'candidate_unknown',
        requiresUserAction: false,
        retryRecommendation: 'unknown',
        reasonCodes
      },
      confidence
    )
  }

  if (isWaitingLifecycle(state)) {
    return withBase(
      {
        candidate: 'waiting',
        legacyEquivalent: 'needs_attention',
        candidatePetState: 'waiting',
        notificationCandidate: 'candidate_attention',
        requiresUserAction: true,
        retryRecommendation: 'user_decision',
        reasonCodes: ['waiting_for_user', 'non_terminal', 'candidate_not_user_visible']
      },
      confidence
    )
  }

  if (state.lifecycle === 'completed_signal' && hasItemFailureFact(state)) {
    return withBase(
      {
        candidate: 'completed_with_partial_failure',
        legacyEquivalent: 'needs_attention',
        candidatePetState: 'cautious',
        notificationCandidate: 'candidate_attention',
        requiresUserAction: true,
        retryRecommendation: 'user_decision',
        reasonCodes: [
          'turn_completed_with_item_failure',
          'task_semantics_not_verified',
          'candidate_not_user_visible',
          'not_succeeded'
        ]
      },
      confidence
    )
  }

  if (state.lifecycle === 'completed_signal') {
    return withBase(
      {
        candidate: 'completed_signal',
        legacyEquivalent: 'done',
        candidatePetState: 'celebrating',
        notificationCandidate: 'candidate_completion',
        requiresUserAction: false,
        retryRecommendation: 'none',
        reasonCodes: [
          'turn_completed_signal',
          'task_semantics_not_verified',
          'legacy_done_is_not_task_success',
          'candidate_not_user_visible',
          'not_succeeded'
        ]
      },
      confidence
    )
  }

  if (state.lifecycle === 'running' && hasItemFailureFact(state)) {
    return withBase(
      {
        candidate: 'working',
        legacyEquivalent: 'working',
        candidatePetState: 'cautious',
        notificationCandidate: 'none',
        requiresUserAction: false,
        retryRecommendation: 'unknown',
        reasonCodes: [
          'running_with_item_failure',
          'working_with_attention',
          'task_semantics_not_verified',
          'candidate_not_user_visible'
        ]
      },
      confidence
    )
  }

  if (state.lifecycle === 'running' && state.item === 'unknown' && state.outputIntegrity === 'partial') {
    return withBase(
      {
        candidate: 'working',
        legacyEquivalent: 'working',
        candidatePetState: 'cautious',
        notificationCandidate: 'none',
        requiresUserAction: false,
        retryRecommendation: 'unknown',
        reasonCodes: ['running_with_unverified_item', 'task_semantics_not_verified', 'candidate_not_user_visible']
      },
      confidence
    )
  }

  if (state.lifecycle === 'running') {
    return withBase(
      {
        candidate: 'working',
        legacyEquivalent: 'working',
        candidatePetState: 'working',
        notificationCandidate: 'none',
        requiresUserAction: false,
        retryRecommendation: 'none',
        reasonCodes: ['agent_running', 'no_anomaly_evidence', 'candidate_not_user_visible']
      },
      confidence
    )
  }

  const reasonCodes = ['lifecycle_unknown', 'do_not_infer_outcome', 'candidate_not_user_visible']
  if (state.lifecycle === 'succeeded') reasonCodes.unshift('unexpected_succeeded_lifecycle_not_mapped')
  if (hasItemFailureFact(state)) reasonCodes.push('tool_failed_fact_present_not_turn_failed')
  if (state.taskSemantics === 'not_verified') reasonCodes.push('task_semantics_not_verified')

  return withBase(
    {
      candidate: 'unknown',
      legacyEquivalent: 'unknown',
      candidatePetState: 'unknown',
      notificationCandidate: 'candidate_unknown',
      requiresUserAction: false,
      retryRecommendation: 'unknown',
      reasonCodes
    },
    confidence
  )
}

export function summarizeDerivedForCandidate(state: CodexDerivedState): {
  lifecycle: CodexDerivedState['lifecycle']
  cause: CodexDerivedState['cause']
  process: CodexDerivedState['process']
  connection: CodexDerivedState['connection']
  session: CodexDerivedState['session']
  turn: CodexDerivedState['turn']
  item: CodexDerivedState['item']
  outputIntegrity: CodexDerivedState['outputIntegrity']
  taskSemantics: CodexDerivedState['taskSemantics']
  retryability: CodexDerivedState['retryability']
  confidence: CodexDerivedState['confidence']
} {
  return {
    lifecycle: state.lifecycle,
    cause: state.cause,
    process: state.process,
    connection: state.connection,
    session: state.session,
    turn: state.turn,
    item: state.item,
    outputIntegrity: state.outputIntegrity,
    taskSemantics: state.taskSemantics,
    retryability: state.retryability,
    confidence: state.confidence
  }
}
