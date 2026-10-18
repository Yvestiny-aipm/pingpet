import type { CodexDerivedState } from '@shared/types'
import { mapCodexDerivedToCandidate, type CodexCandidateKind, type CodexCandidateState } from './codexCandidate'
import { visualSessionKey } from './codexVisiblePresentation'
import { sessionVisualDriver, type CodexSessionVisualSlot } from './codexVisualArbitration'

/**
 * Codex candidate 第一阶段气泡：只提醒 completed_with_partial_failure。
 *
 * 不接成功/完成气泡、声音、shouldNotify、自动重试。
 * 不把 candidate 包装成旧 done。completed_signal ≠ 任务成功。
 */

export const CODEX_PARTIAL_FAILURE_BUBBLE_TEXT = '这一轮结束了，但有工具失败，请查看结果。'

const SUCCESS_HINTS = ['任务已完成', '任务完成', '完成了任务', '全部完成', '成功', 'celebrat']

export interface CodexBubbleInput {
  enabled: boolean
  candidate: CodexCandidateState
  derived: Pick<CodexDerivedState, 'connection' | 'turnId' | 'sessionId'>
  fileAlias?: string
  observedAt: number
  live?: boolean
  source?: string
}

export interface CodexBubblePresentation {
  showBubble: boolean
  text?: string
  sound: false
  shouldNotify: false
  dedupeKey: string | null
  /** 本轮实际展示（或即将展示）的 session key，供视觉层 acknowledge。 */
  presentedSessionKeys: string[]
  reason: string
}

export interface CodexBubblePlan {
  candidate: CodexCandidateState
  presentation: CodexBubblePresentation
}

interface BubbleSessionSlot extends CodexSessionVisualSlot {
  localBoundary: number
}

const SILENT: Pick<CodexBubblePresentation, 'sound' | 'shouldNotify'> = {
  sound: false,
  shouldNotify: false
}

function silent(
  partial: Omit<CodexBubblePresentation, 'sound' | 'shouldNotify' | 'presentedSessionKeys'> & {
    presentedSessionKeys?: string[]
  }
): CodexBubblePresentation {
  return { presentedSessionKeys: [], ...SILENT, ...partial }
}

export function sessionKeyFromBubbleDedupe(dedupeKey: string): string {
  return dedupeKey.split('|')[0] ?? dedupeKey
}

export function looksLikeCodexSuccessBubbleCopy(text: string): boolean {
  return SUCCESS_HINTS.some((hint) => text.includes(hint))
}

export function bubbleTurnToken(turnId: string | undefined, localBoundary: number): string {
  if (turnId && turnId.trim()) return `turn:${turnId}`
  return `bound:${localBoundary}`
}

export function bubbleDedupeKey(sessionKey: string, turnToken: string, candidate: CodexCandidateKind): string {
  return `${sessionKey}|${turnToken}|${candidate}`
}

export function mapCodexCandidateToBubble(input: CodexBubbleInput): CodexBubblePresentation {
  if (!input.enabled) {
    return silent({ showBubble: false, dedupeKey: null, reason: 'codex_candidate_bubble_disabled' })
  }
  if (input.source && input.source !== 'codex') {
    return silent({ showBubble: false, dedupeKey: null, reason: 'non_codex_ignored' })
  }
  if (input.live === false) {
    return silent({ showBubble: false, dedupeKey: null, reason: 'priming_not_bubbled' })
  }
  const key = visualSessionKey(input.fileAlias, input.derived.sessionId)
  if (!key) {
    return silent({ showBubble: false, dedupeKey: null, reason: 'missing_session_key' })
  }
  if (input.derived.connection === 'stale' || input.candidate.candidate === 'unknown') {
    return silent({
      showBubble: false,
      dedupeKey: null,
      reason: input.derived.connection === 'stale' ? 'observation_stale_no_bubble' : 'unknown_no_bubble'
    })
  }
  if (input.candidate.candidate !== 'completed_with_partial_failure') {
    return silent({
      showBubble: false,
      dedupeKey: null,
      reason: `candidate_${input.candidate.candidate}_no_bubble`
    })
  }
  const turnToken = bubbleTurnToken(input.derived.turnId, 0)
  return silent({
    showBubble: true,
    text: CODEX_PARTIAL_FAILURE_BUBBLE_TEXT,
    dedupeKey: bubbleDedupeKey(key, turnToken, 'completed_with_partial_failure'),
    presentedSessionKeys: [key],
    reason: 'candidate_completed_with_partial_failure_bubble'
  })
}

function isTerminalCandidate(candidate: CodexCandidateKind): boolean {
  return (
    candidate === 'completed_signal' ||
    candidate === 'completed_with_partial_failure' ||
    candidate === 'cancelled' ||
    candidate === 'failed' ||
    candidate === 'incomplete'
  )
}

function hasWorkingSession(sessions: Iterable<BubbleSessionSlot>): boolean {
  for (const slot of sessions) {
    if (sessionVisualDriver(slot) === 'working') return true
  }
  return false
}

/** session 级部分失败气泡。有 working 时入队，全部结束后弹一次；不伪造官方 turnId。 */
export class CodexPartialFailureBubbleGate {
  private readonly sessions = new Map<string, BubbleSessionSlot>()
  private readonly emitted = new Set<string>()
  private readonly pending = new Set<string>()

  clear(): void {
    this.sessions.clear()
    this.emitted.clear()
    this.pending.clear()
  }

  snapshotPending(): string[] {
    return [...this.pending]
  }

  apply(input: CodexBubbleInput): CodexBubblePresentation {
    const mapped = mapCodexCandidateToBubble({ ...input, live: input.live ?? true })
    if (!input.enabled) {
      this.clear()
      return mapped
    }
    if (input.source && input.source !== 'codex') return mapped
    if (input.live === false) return mapped
    const key = visualSessionKey(input.fileAlias, input.derived.sessionId)
    if (!key) return mapped

    const prev = this.sessions.get(key)
    if (prev && input.observedAt < prev.observedAt) {
      return silent({ showBubble: false, dedupeKey: mapped.dedupeKey, reason: 'older_observation_ignored' })
    }

    let localBoundary = prev?.localBoundary ?? 0
    if (prev && isTerminalCandidate(prev.candidate) && input.candidate.candidate === 'working') {
      localBoundary += 1
    }

    this.sessions.set(key, {
      key,
      fileAlias: input.fileAlias,
      sessionId: input.derived.sessionId,
      turnId: input.derived.turnId,
      candidate: input.candidate.candidate,
      connection: input.derived.connection,
      observedAt: input.observedAt,
      localBoundary
    })

    if (input.candidate.candidate !== 'completed_with_partial_failure') {
      this.dropPendingIfSuperseded(key)
      return this.releaseQueuedIfIdle(mapped)
    }

    const dedupeKey = bubbleDedupeKey(
      key,
      bubbleTurnToken(input.derived.turnId, localBoundary),
      'completed_with_partial_failure'
    )
    if (this.emitted.has(dedupeKey)) {
      this.pending.delete(dedupeKey)
      return silent({ showBubble: false, dedupeKey, reason: 'duplicate_bubble' })
    }
    if (hasWorkingSession(this.sessions.values())) {
      this.pending.add(dedupeKey)
      return silent({ showBubble: false, dedupeKey, reason: 'queued_until_no_working' })
    }
    this.pending.delete(dedupeKey)
    this.emitted.add(dedupeKey)
    return silent({
      showBubble: true,
      text: CODEX_PARTIAL_FAILURE_BUBBLE_TEXT,
      dedupeKey,
      presentedSessionKeys: [key],
      reason: 'candidate_completed_with_partial_failure_bubble'
    })
  }

  private dropPendingIfSuperseded(sessionKey: string): void {
    const slot = this.sessions.get(sessionKey)
    if (!slot || slot.candidate === 'completed_with_partial_failure') return
    for (const key of [...this.pending]) {
      if (key.startsWith(`${sessionKey}|`)) this.pending.delete(key)
    }
  }

  private releaseQueuedIfIdle(fallback: CodexBubblePresentation): CodexBubblePresentation {
    if (hasWorkingSession(this.sessions.values())) return fallback
    const ready: string[] = []
    for (const key of this.pending) {
      if (this.emitted.has(key)) {
        this.pending.delete(key)
        continue
      }
      const sessionKey = key.split('|')[0]
      const slot = this.sessions.get(sessionKey)
      if (!slot || slot.candidate !== 'completed_with_partial_failure') {
        this.pending.delete(key)
        continue
      }
      ready.push(key)
    }
    if (ready.length === 0) return fallback
    for (const key of ready) {
      this.emitted.add(key)
      this.pending.delete(key)
    }
    return silent({
      showBubble: true,
      text: CODEX_PARTIAL_FAILURE_BUBBLE_TEXT,
      dedupeKey: ready[0],
      presentedSessionKeys: ready.map(sessionKeyFromBubbleDedupe),
      reason: 'queued_partial_failure_released'
    })
  }
}

export function planCodexPartialFailureBubble(
  gate: CodexPartialFailureBubbleGate,
  input: {
    enabled: boolean
    derived: CodexDerivedState
    fileAlias?: string
    observedAt?: number
    live?: boolean
    source?: string
  }
): CodexBubblePlan {
  const candidate = mapCodexDerivedToCandidate(input.derived)
  if (!input.enabled) {
    gate.clear()
    return {
      candidate,
      presentation: silent({
        showBubble: false,
        dedupeKey: null,
        reason: 'codex_candidate_bubble_disabled'
      })
    }
  }
  return {
    candidate,
    presentation: gate.apply({
      enabled: true,
      candidate,
      derived: input.derived,
      fileAlias: input.fileAlias,
      observedAt: input.observedAt ?? input.derived.observedAt,
      live: input.live,
      source: input.source ?? 'codex'
    })
  }
}
