import type { CodexConnectionDimension, PetState } from '@shared/types'
import type { CodexCandidateKind } from './codexCandidate'

/**
 * Codex 多 session 静默姿态仲裁。
 *
 * 每个 session 各自保留最新 candidate；桌宠只展示汇总后的一个全局姿态。
 * 不接气泡、声音、shouldNotify。completed_signal ≠ 成功。
 */

export type CodexVisualDriver =
  | 'working'
  | 'completed_with_partial_failure'
  | 'neutral_terminal'
  | 'stale_or_unknown'
  | 'not_wired'

export interface CodexSessionVisualSlot {
  key: string
  fileAlias?: string
  sessionId?: string
  /** 原始事件提供才有；缺失不得猜造 */
  turnId?: string
  candidate: CodexCandidateKind
  connection: CodexConnectionDimension
  observedAt: number
  /** 该 turn 的部分失败气泡还没展示。不改变 candidate 事实。 */
  bubblePending?: boolean
  /** 该 turn 的部分失败提醒已展示。不是任务成功。 */
  attentionAcknowledged?: boolean
  lastPresentedCandidate?: CodexCandidateKind
}

export interface CodexGlobalPose {
  petState: PetState | null
  reason: string
}

export function isPendingPartialFailureAttention(slot: CodexSessionVisualSlot): boolean {
  return slot.candidate === 'completed_with_partial_failure' && slot.attentionAcknowledged !== true
}

export function sessionVisualDriver(slot: CodexSessionVisualSlot): CodexVisualDriver {
  if (isPendingPartialFailureAttention(slot)) return 'completed_with_partial_failure'
  if (slot.connection === 'stale' || slot.candidate === 'unknown') return 'stale_or_unknown'
  if (slot.candidate === 'working') return 'working'
  if (slot.candidate === 'completed_with_partial_failure' && slot.attentionAcknowledged) {
    return 'neutral_terminal'
  }
  if (slot.candidate === 'completed_signal' || slot.candidate === 'cancelled') return 'neutral_terminal'
  return 'not_wired'
}

/**
 * 把多个 Codex session 的最新 candidate 收成一个桌宠姿态。
 * stale/unknown/failed/incomplete/waiting 不产生强视觉状态。
 */
export function reduceCodexSessionsToGlobalPose(
  sessions: readonly CodexSessionVisualSlot[]
): CodexGlobalPose {
  let working = 0
  let partial = 0
  let neutral = 0
  for (const slot of sessions) {
    const driver = sessionVisualDriver(slot)
    if (driver === 'working') working += 1
    else if (driver === 'completed_with_partial_failure') partial += 1
    else if (driver === 'neutral_terminal') neutral += 1
  }
  if (working > 0) {
    return { petState: 'thinking', reason: 'arbitrate_working' }
  }
  if (partial > 0) {
    return { petState: 'attention', reason: 'arbitrate_partial_failure' }
  }
  if (neutral > 0) {
    return { petState: 'idle', reason: 'arbitrate_neutral_idle' }
  }
  return { petState: null, reason: 'arbitrate_keep_pose' }
}

export function isIncomingStaleOrUnknown(
  candidate: CodexCandidateKind,
  connection: CodexConnectionDimension
): boolean {
  return connection === 'stale' || candidate === 'unknown'
}

export function shouldReplaceSessionSlot(
  previous: CodexSessionVisualSlot | undefined,
  nextObservedAt: number
): 'apply' | 'older_observation_ignored' {
  if (previous && nextObservedAt < previous.observedAt) return 'older_observation_ignored'
  return 'apply'
}
