import type { CodexDerivedState } from '@shared/types'
import { isCodexAttentionSoundResourceReady } from './codexAttentionSoundResource'
import {
  bubbleDedupeKey,
  bubbleTurnToken
} from './codexBubblePresentation'
import { mapCodexDerivedToCandidate, type CodexCandidateKind, type CodexCandidateState } from './codexCandidate'
import { visualSessionKey } from './codexVisiblePresentation'

/**
 * Codex candidate 第一阶段声音：只跟随「已真正发出」的部分失败气泡。
 *
 * 独立 attention/notice 音，不复用完成音 / 庆祝音 / 强错误警报 / playDing。
 * completed_signal ≠ 任务成功，不得出完成音。shouldNotify 永远 false。
 */

export type CodexSoundType = 'attention'

/** 以仓库内方案 A 资源是否可读为准。禁止把缺失当成可以回退 playDing。 */
export const CODEX_ATTENTION_SOUND_AVAILABLE = isCodexAttentionSoundResourceReady()

export interface CodexSoundInput {
  enabled: boolean
  candidate: CodexCandidateState
  derived: Pick<CodexDerivedState, 'connection' | 'turnId' | 'sessionId'>
  fileAlias?: string
  observedAt: number
  live?: boolean
  source?: string
  /** 气泡是否已经真正发送到渲染进程。未发送则不得出声。 */
  bubbleActuallyPresented: boolean
  /** acknowledgePresented 之后才允许进入声音判定。 */
  attentionAcknowledged: boolean
  /** 仍待展示的部分失败不得出声。 */
  bubblePending?: boolean
  /** 与气泡共用的去重键；声音再附加 presentation state。 */
  bubbleDedupeKey?: string | null
  /** 无官方 turnId 时沿用气泡层的本地 boundary，不得用时间戳伪造。 */
  localBoundary?: number
  /** 主进程已校验过的独立 attention 资源；缺省时再检查仓库文件。 */
  resourceAvailable?: boolean
}

export interface CodexSoundPresentation {
  playSound: boolean
  soundType?: CodexSoundType
  shouldNotify: false
  dedupeKey: string | null
  reason: string
}

export interface CodexSoundPlan {
  candidate: CodexCandidateState
  presentation: CodexSoundPresentation
}

const SILENT: Pick<CodexSoundPresentation, 'playSound' | 'shouldNotify'> = {
  playSound: false,
  shouldNotify: false
}

function silent(
  partial: Omit<CodexSoundPresentation, 'playSound' | 'shouldNotify'> & { playSound?: false }
): CodexSoundPresentation {
  return { ...SILENT, ...partial }
}

export function soundDedupeKey(
  sessionKey: string,
  turnToken: string,
  candidate: CodexCandidateKind
): string {
  return `${bubbleDedupeKey(sessionKey, turnToken, candidate)}|presented`
}

export function soundDedupeKeyFromBubble(bubbleKey: string): string {
  return `${bubbleKey}|presented`
}

export function resolveSoundDedupeKey(input: CodexSoundInput): string | null {
  if (input.bubbleDedupeKey && input.bubbleDedupeKey.trim()) {
    return soundDedupeKeyFromBubble(input.bubbleDedupeKey)
  }
  const sessionKey = visualSessionKey(input.fileAlias, input.derived.sessionId)
  if (!sessionKey) return null
  return soundDedupeKey(
    sessionKey,
    bubbleTurnToken(input.derived.turnId, input.localBoundary ?? 0),
    'completed_with_partial_failure'
  )
}

/** 只有真正要播独立 attention 音时为 true。资源失败不得算作会播放。 */
export function wouldPlayCodexAttentionSound(presentation: CodexSoundPresentation): boolean {
  return presentation.playSound === true && presentation.soundType === 'attention'
}

export function mapCodexCandidateToSound(input: CodexSoundInput): CodexSoundPresentation {
  if (!input.enabled) {
    return silent({ dedupeKey: null, reason: 'codex_candidate_sound_disabled' })
  }
  if (input.source && input.source !== 'codex') {
    return silent({ dedupeKey: null, reason: 'non_codex_ignored' })
  }
  if (input.live === false) {
    return silent({ dedupeKey: null, reason: 'priming_not_sounded' })
  }
  if (!input.bubbleActuallyPresented) {
    return silent({ dedupeKey: resolveSoundDedupeKey(input), reason: 'bubble_not_presented' })
  }
  if (!input.attentionAcknowledged) {
    return silent({ dedupeKey: resolveSoundDedupeKey(input), reason: 'attention_not_acknowledged' })
  }
  if (input.bubblePending === true) {
    return silent({ dedupeKey: resolveSoundDedupeKey(input), reason: 'bubble_still_pending' })
  }
  if (input.derived.connection === 'stale' || input.candidate.candidate === 'unknown') {
    return silent({
      dedupeKey: resolveSoundDedupeKey(input),
      reason: input.derived.connection === 'stale' ? 'observation_stale_no_sound' : 'unknown_no_sound'
    })
  }
  if (input.candidate.candidate !== 'completed_with_partial_failure') {
    return silent({
      dedupeKey: resolveSoundDedupeKey(input),
      reason: `candidate_${input.candidate.candidate}_no_sound`
    })
  }

  const dedupeKey = resolveSoundDedupeKey(input)
  if (!dedupeKey) {
    return silent({ dedupeKey: null, reason: 'missing_session_key' })
  }
  const resourceOk =
    typeof input.resourceAvailable === 'boolean'
      ? input.resourceAvailable
      : isCodexAttentionSoundResourceReady()
  if (!resourceOk) {
    return {
      playSound: false,
      soundType: 'attention',
      shouldNotify: false,
      dedupeKey,
      reason: 'attention_sound_resource_unavailable'
    }
  }
  return {
    playSound: true,
    soundType: 'attention',
    shouldNotify: false,
    dedupeKey,
    reason: 'candidate_completed_with_partial_failure_attention_sound'
  }
}

/** session/turn 级部分失败声音。必须拿到气泡已实际展示的结果，不能只看 candidate。 */
export class CodexPartialFailureSoundGate {
  private readonly emitted = new Set<string>()

  clear(): void {
    this.emitted.clear()
  }

  snapshotEmitted(): string[] {
    return [...this.emitted]
  }

  apply(input: CodexSoundInput): CodexSoundPresentation {
    const mapped = mapCodexCandidateToSound({ ...input, live: input.live ?? true })
    if (!input.enabled) {
      this.clear()
      return mapped
    }
    if (!mapped.dedupeKey) return mapped
    if (this.emitted.has(mapped.dedupeKey)) {
      return silent({
        dedupeKey: mapped.dedupeKey,
        reason: 'duplicate_sound'
      })
    }
    if (mapped.playSound && mapped.soundType === 'attention') {
      this.emitted.add(mapped.dedupeKey)
    }
    return mapped
  }
}

export function planCodexPartialFailureSound(
  gate: CodexPartialFailureSoundGate,
  input: {
    enabled: boolean
    derived: CodexDerivedState
    fileAlias?: string
    observedAt?: number
    live?: boolean
    source?: string
    bubbleActuallyPresented: boolean
    attentionAcknowledged: boolean
    bubblePending?: boolean
    bubbleDedupeKey?: string | null
    localBoundary?: number
    candidate?: CodexCandidateState
    resourceAvailable?: boolean
  }
): CodexSoundPlan {
  const candidate = input.candidate ?? mapCodexDerivedToCandidate(input.derived)
  if (!input.enabled) {
    gate.clear()
    return {
      candidate,
      presentation: silent({
        dedupeKey: null,
        reason: 'codex_candidate_sound_disabled'
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
      source: input.source ?? 'codex',
      bubbleActuallyPresented: input.bubbleActuallyPresented,
      attentionAcknowledged: input.attentionAcknowledged,
      bubblePending: input.bubblePending,
      bubbleDedupeKey: input.bubbleDedupeKey,
      localBoundary: input.localBoundary,
      resourceAvailable: input.resourceAvailable
    })
  }
}
