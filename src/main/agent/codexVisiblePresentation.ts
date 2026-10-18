import { AGENT_THINKING_STATE_MS } from '@shared/defaults'
import type { CodexDerivedState, PetState } from '@shared/types'
import { mapCodexDerivedToCandidate, type CodexCandidateKind, type CodexCandidateState } from './codexCandidate'
import {
  isIncomingStaleOrUnknown,
  reduceCodexSessionsToGlobalPose,
  shouldReplaceSessionSlot,
  type CodexSessionVisualSlot
} from './codexVisualArbitration'

/**
 * Codex candidate → 静默桌宠姿态（第一阶段）。
 *
 * 不接气泡、声音、shouldNotify、自动重试。
 * 不从旧 AgentMonitorEvent.done 推导。completed_signal ≠ 任务成功。
 */

export interface CodexSilentVisualInput {
  enabled: boolean
  candidate: CodexCandidateState
  derived: Pick<
    CodexDerivedState,
    'lifecycle' | 'cause' | 'connection' | 'item' | 'outputIntegrity' | 'taskSemantics' | 'turn' | 'turnId' | 'sessionId'
  >
  fileAlias?: string
  observedAt: number
  /** false：priming / 历史观察，不得进入仲裁 */
  live?: boolean
  /** 必须是 codex；缺省视为 codex */
  source?: string
}

export interface CodexSilentVisualPresentation {
  petState: PetState | null
  applyPetState: boolean
  showBubble: false
  playSound: false
  shouldNotify: false
  reason: string
}

/** candidate cautious 对应现有桌宠 attention；没有 celebrating 姿态。 */
export const CODEX_CAUTIOUS_PET_STATE: Extract<PetState, 'attention'> = 'attention'

const FROZEN: Pick<CodexSilentVisualPresentation, 'showBubble' | 'playSound' | 'shouldNotify'> = {
  showBubble: false,
  playSound: false,
  shouldNotify: false
}

export function silentVisualDurationMs(_state: PetState): number {
  return AGENT_THINKING_STATE_MS
}

export function snapshotPartialFailureEvidence(
  derived: Pick<CodexDerivedState, 'cause' | 'item' | 'outputIntegrity' | 'taskSemantics'>
): {
  cause: CodexDerivedState['cause']
  item: CodexDerivedState['item']
  outputIntegrity: CodexDerivedState['outputIntegrity']
  taskSemantics: CodexDerivedState['taskSemantics']
} {
  return {
    cause: derived.cause,
    item: derived.item,
    outputIntegrity: derived.outputIntegrity,
    taskSemantics: derived.taskSemantics
  }
}

/** priming / emitCallbacks=false 的历史观察不得驱动桌宠。 */
export function shadowObservationCanDriveVisual(args: { emitCallbacks: boolean; primed?: boolean }): boolean {
  if (!args.emitCallbacks) return false
  if (args.primed === false) return false
  return true
}

function frozen(partial: Omit<CodexSilentVisualPresentation, 'showBubble' | 'playSound' | 'shouldNotify'>): CodexSilentVisualPresentation {
  return { ...FROZEN, ...partial }
}

export function mapCodexCandidateToSilentVisual(input: CodexSilentVisualInput): CodexSilentVisualPresentation {
  if (!input.enabled) {
    return frozen({ petState: null, applyPetState: false, reason: 'codex_candidate_visual_disabled' })
  }

  const { candidate, derived } = input
  if (derived.connection === 'stale' || candidate.candidate === 'unknown') {
    return frozen({
      petState: null,
      applyPetState: false,
      reason: derived.connection === 'stale' ? 'observation_stale_keep_pose' : 'unknown_keep_pose'
    })
  }

  if (candidate.candidate === 'failed' || candidate.candidate === 'incomplete') {
    return frozen({
      petState: null,
      applyPetState: false,
      reason: 'failed_or_incomplete_not_wired'
    })
  }

  if (candidate.candidate === 'waiting') {
    return frozen({ petState: null, applyPetState: false, reason: 'waiting_not_wired' })
  }

  if (candidate.candidate === 'working') {
    return frozen({ petState: 'thinking', applyPetState: true, reason: 'candidate_working' })
  }

  if (candidate.candidate === 'completed_signal') {
    return frozen({
      petState: 'idle',
      applyPetState: true,
      reason: 'candidate_completed_signal_neutral_idle'
    })
  }

  if (candidate.candidate === 'completed_with_partial_failure') {
    return frozen({
      petState: CODEX_CAUTIOUS_PET_STATE,
      applyPetState: true,
      reason: 'candidate_completed_with_partial_failure_cautious'
    })
  }

  if (candidate.candidate === 'cancelled') {
    return frozen({ petState: 'idle', applyPetState: true, reason: 'candidate_cancelled_idle' })
  }

  return frozen({ petState: null, applyPetState: false, reason: 'unmapped_keep_pose' })
}

export function isCelebratingVisual(state: PetState | null): boolean {
  return state === 'happy'
}

export function visualSessionKey(fileAlias?: string, sessionId?: string): string | null {
  if (fileAlias && fileAlias.trim()) return `file:${fileAlias}`
  if (sessionId && sessionId.trim()) return `sess:${sessionId}`
  return null
}

export function sameVisualTurn(previousTurnId: string | undefined, nextTurnId: string | undefined): boolean {
  if (previousTurnId && nextTurnId) return previousTurnId === nextTurnId
  return true
}

/** 开关打开时，Codex working/done 的姿态改由 candidate 驱动，避免与旧 Monitor 双切。 */
export function shouldLegacyCodexDrivePetVisual(
  enabled: boolean,
  event: { source: string; kind: string }
): boolean {
  if (!enabled) return true
  if (event.source !== 'codex') return true
  return event.kind !== 'working' && event.kind !== 'done'
}

export interface CodexSilentVisualApplyResult {
  applied: boolean
  presentation: CodexSilentVisualPresentation
}

/** 按 session 存最新 candidate，再仲裁成一个全局姿态。不猜造 turnId。 */
export class CodexSilentVisualGate {
  private readonly sessions = new Map<string, CodexSessionVisualSlot>()
  private lastGlobalPetState: PetState | null = null

  clear(): void {
    this.sessions.clear()
    this.lastGlobalPetState = null
  }

  snapshotSessions(): CodexSessionVisualSlot[] {
    return [...this.sessions.values()]
  }

  apply(input: CodexSilentVisualInput): CodexSilentVisualApplyResult {
    const local = mapCodexCandidateToSilentVisual(input)
    if (!input.enabled) {
      return { applied: false, presentation: local }
    }
    if (input.source && input.source !== 'codex') {
      return {
        applied: false,
        presentation: frozen({ petState: null, applyPetState: false, reason: 'non_codex_ignored' })
      }
    }
    if (input.live === false) {
      return {
        applied: false,
        presentation: frozen({ petState: null, applyPetState: false, reason: 'priming_not_arbitrated' })
      }
    }
    const key = visualSessionKey(input.fileAlias, input.derived.sessionId)
    if (!key) {
      return {
        applied: false,
        presentation: frozen({ petState: null, applyPetState: false, reason: 'missing_session_key' })
      }
    }
    const prev = this.sessions.get(key)
    if (shouldReplaceSessionSlot(prev, input.observedAt) === 'older_observation_ignored') {
      return {
        applied: false,
        presentation: { ...local, petState: null, applyPetState: false, reason: 'older_observation_ignored' }
      }
    }

    if (
      isIncomingStaleOrUnknown(input.candidate.candidate, input.derived.connection) &&
      prev?.candidate === 'completed_with_partial_failure'
    ) {
      this.sessions.set(key, {
        ...prev,
        connection: input.derived.connection,
        observedAt: input.observedAt
      })
      return {
        applied: false,
        presentation: {
          ...local,
          petState: null,
          applyPetState: false,
          reason:
            prev.attentionAcknowledged === true
              ? 'stale_keep_partial_failure_facts'
              : 'stale_keep_pending_partial_failure'
        }
      }
    }

    const newTurn = isNewVisualTurn(prev, input.candidate.candidate, input.derived.turnId)
    const keepSameTurnPartial =
      Boolean(prev) &&
      !newTurn &&
      prev!.candidate === 'completed_with_partial_failure' &&
      (input.candidate.candidate === 'completed_with_partial_failure' ||
        input.candidate.candidate === 'completed_signal' ||
        input.candidate.candidate === 'cancelled')
    const sameTurnAcknowledged = keepSameTurnPartial && prev!.attentionAcknowledged === true

    const slot: CodexSessionVisualSlot = {
      key,
      fileAlias: input.fileAlias,
      sessionId: input.derived.sessionId,
      turnId: input.derived.turnId,
      candidate: keepSameTurnPartial ? 'completed_with_partial_failure' : input.candidate.candidate,
      connection: input.derived.connection,
      observedAt: input.observedAt,
      bubblePending: keepSameTurnPartial
        ? prev!.attentionAcknowledged !== true
        : input.candidate.candidate === 'completed_with_partial_failure',
      attentionAcknowledged: sameTurnAcknowledged,
      lastPresentedCandidate: sameTurnAcknowledged ? prev!.lastPresentedCandidate : undefined
    }
    this.sessions.set(key, slot)

    if (isIncomingStaleOrUnknown(input.candidate.candidate, input.derived.connection)) {
      return {
        applied: false,
        presentation: {
          ...local,
          petState: null,
          applyPetState: false,
          reason: local.reason
        }
      }
    }

    if (!local.applyPetState) {
      return { applied: false, presentation: local }
    }

    const reduced = reduceCodexSessionsToGlobalPose(this.snapshotSessions())
    if (!reduced.petState) {
      return {
        applied: false,
        presentation: { ...local, petState: null, applyPetState: false, reason: reduced.reason }
      }
    }
    if (
      sameTurnAcknowledged &&
      reduced.petState === 'idle' &&
      this.lastGlobalPetState === 'attention'
    ) {
      return {
        applied: false,
        presentation: {
          ...local,
          petState: 'attention',
          applyPetState: false,
          reason: 'acknowledged_partial_no_idle_replay'
        }
      }
    }
    if (this.lastGlobalPetState === reduced.petState) {
      return {
        applied: false,
        presentation: {
          ...local,
          petState: reduced.petState,
          applyPetState: false,
          reason: 'duplicate_visual'
        }
      }
    }
    this.lastGlobalPetState = reduced.petState
    return {
      applied: true,
      presentation: {
        ...local,
        petState: reduced.petState,
        applyPetState: true,
        reason: reduced.reason
      }
    }
  }

  /**
   * 部分失败气泡已实际发出后调用。
   * 只改展示状态，不改 candidate / cause / item。
   * 本方法不立刻 sendPetState，避免 OnSetState 清掉刚弹出的气泡。
   */
  acknowledgePresented(sessionKeys: readonly string[]): CodexSilentVisualApplyResult {
    for (const key of sessionKeys) {
      const slot = this.sessions.get(key)
      if (!slot || slot.candidate !== 'completed_with_partial_failure') continue
      this.sessions.set(key, {
        ...slot,
        bubblePending: false,
        attentionAcknowledged: true,
        lastPresentedCandidate: 'completed_with_partial_failure'
      })
    }
    const reduced = reduceCodexSessionsToGlobalPose(this.snapshotSessions())
    return {
      applied: false,
      presentation: frozen({
        petState: reduced.petState,
        applyPetState: false,
        reason: 'partial_failure_acknowledged'
      })
    }
  }
}

function isTerminalVisualCandidate(candidate: CodexCandidateKind): boolean {
  return (
    candidate === 'completed_signal' ||
    candidate === 'completed_with_partial_failure' ||
    candidate === 'cancelled' ||
    candidate === 'failed' ||
    candidate === 'incomplete'
  )
}

function isNewVisualTurn(
  previous: CodexSessionVisualSlot | undefined,
  nextCandidate: CodexCandidateKind,
  nextTurnId: string | undefined
): boolean {
  if (!previous) return false
  if (previous.turnId && nextTurnId && previous.turnId !== nextTurnId) return true
  return isTerminalVisualCandidate(previous.candidate) && nextCandidate === 'working'
}

export interface CodexSilentVisualPlan extends CodexSilentVisualApplyResult {
  candidate: CodexCandidateState
}

/** 从 candidate/shadow 派生静默姿态；不把 candidate 包装成旧 done。 */
export function planCodexSilentVisual(
  gate: CodexSilentVisualGate,
  input: {
    enabled: boolean
    derived: CodexDerivedState
    fileAlias?: string
    observedAt?: number
    live?: boolean
    source?: string
  }
): CodexSilentVisualPlan {
  if (!input.enabled) {
    gate.clear()
    const candidate = mapCodexDerivedToCandidate(input.derived)
    return {
      applied: false,
      candidate,
      presentation: frozen({
        petState: null,
        applyPetState: false,
        reason: 'codex_candidate_visual_disabled'
      })
    }
  }
  const candidate = mapCodexDerivedToCandidate(input.derived)
  const result = gate.apply({
    enabled: true,
    candidate,
    derived: input.derived,
    fileAlias: input.fileAlias,
    observedAt: input.observedAt ?? input.derived.observedAt,
    live: input.live,
    source: input.source ?? 'codex'
  })
  return { ...result, candidate }
}
