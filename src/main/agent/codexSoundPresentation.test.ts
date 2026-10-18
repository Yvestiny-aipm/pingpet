import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CodexDerivedState } from '@shared/types'
import {
  CodexPartialFailureBubbleGate,
  planCodexPartialFailureBubble
} from './codexBubblePresentation'
import {
  CODEX_ATTENTION_SOUND_AVAILABLE,
  CodexPartialFailureSoundGate,
  planCodexPartialFailureSound,
  wouldPlayCodexAttentionSound
} from './codexSoundPresentation'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import {
  CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED,
  isCodexLegacyProtocolComplete,
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser
} from './codexLegacyPresentation'
import { emptyCodexDerivedState } from './codexState'
import { reduceCodexSessionsToGlobalPose } from './codexVisualArbitration'
import {
  CodexSilentVisualGate,
  planCodexSilentVisual,
  shouldLegacyCodexDrivePetVisual
} from './codexVisiblePresentation'

const NOW = 1_700_000_000_000

function derived(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return {
    ...emptyCodexDerivedState(NOW),
    confidence: 'high',
    sessionId: partial.sessionId ?? 'sess-a',
    ...partial
  }
}

function working(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'running',
    turn: 'in_progress',
    item: 'running',
    connection: 'connected',
    ...partial
  })
}

function completedSignal(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'completed_signal',
    turn: 'completed',
    item: 'succeeded',
    taskSemantics: 'not_verified',
    connection: 'connected',
    ...partial
  })
}

function partialFailure(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'completed_signal',
    turn: 'completed',
    cause: 'tool_failed',
    item: 'partial_failure',
    outputIntegrity: 'partial',
    taskSemantics: 'not_verified',
    connection: 'connected',
    ...partial
  })
}

function cancelled(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'cancelled',
    cause: 'user_cancelled',
    turn: 'interrupted',
    connection: 'connected',
    ...partial
  })
}

function staleRunning(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'running',
    turn: 'in_progress',
    connection: 'stale',
    ...partial
  })
}

function failedTurn(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'failed',
    cause: 'turn_failed',
    turn: 'failed',
    connection: 'connected',
    ...partial
  })
}

function incomplete(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'incomplete',
    cause: 'process_exit',
    connection: 'connected',
    ...partial
  })
}

function planSound(
  gate: CodexPartialFailureSoundGate,
  state: CodexDerivedState,
  extra: {
    fileAlias?: string
    enabled?: boolean
    live?: boolean
    source?: string
    bubbleActuallyPresented?: boolean
    attentionAcknowledged?: boolean
    bubblePending?: boolean
    bubbleDedupeKey?: string | null
    localBoundary?: number
    resourceAvailable?: boolean
  } = {}
) {
  return planCodexPartialFailureSound(gate, {
    enabled: extra.enabled ?? true,
    derived: state,
    fileAlias: extra.fileAlias ?? 'file-a',
    live: extra.live,
    source: extra.source,
    bubbleActuallyPresented: extra.bubbleActuallyPresented ?? false,
    attentionAcknowledged: extra.attentionAcknowledged ?? false,
    bubblePending: extra.bubblePending,
    bubbleDedupeKey: extra.bubbleDedupeKey,
    localBoundary: extra.localBoundary,
    resourceAvailable: extra.resourceAvailable
  })
}

function presentPartialBubble(
  bubbles: CodexPartialFailureBubbleGate,
  state: CodexDerivedState,
  fileAlias: string
) {
  return planCodexPartialFailureBubble(bubbles, {
    enabled: true,
    derived: state,
    fileAlias
  })
}

describe('Codex 部分失败声音开关', () => {
  it('1. 开关默认关闭，关闭时不播放声音', () => {
    expect(DEFAULT_SETTINGS.codexCandidateSoundEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateBubbleEnabled).toBe(false)
    const planned = planSound(new CodexPartialFailureSoundGate(), partialFailure({ turnId: 't1' }), {
      enabled: false,
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.presentation.shouldNotify).toBe(false)
    expect(planned.presentation.reason).toBe('codex_candidate_sound_disabled')
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(false)
  })

  it('2. 开关打开、partial_failure 气泡真正发送后播放一次 attention 音', () => {
    expect(CODEX_ATTENTION_SOUND_AVAILABLE).toBe(true)
    const bubbles = new CodexPartialFailureBubbleGate()
    const sounds = new CodexPartialFailureSoundGate()
    const state = partialFailure({ turnId: 't1' })
    const bubble = presentPartialBubble(bubbles, state, 'file-a')
    expect(bubble.presentation.showBubble).toBe(true)
    expect(bubble.presentation.sound).toBe(false)
    const planned = planSound(sounds, state, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubblePending: false,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    expect(planned.candidate.candidate).toBe('completed_with_partial_failure')
    expect(planned.presentation.soundType).toBe('attention')
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(true)
    expect(planned.presentation.playSound).toBe(true)
    expect(planned.presentation.reason).toBe('candidate_completed_with_partial_failure_attention_sound')
    expect(planned.presentation.shouldNotify).toBe(false)
    expect(planned.presentation.dedupeKey).toBe(`${bubble.presentation.dedupeKey}|presented`)
  })

  it('20. 资源加载失败保持静音，不回退 playDing', () => {
    const planned = planSound(new CodexPartialFailureSoundGate(), partialFailure({ turnId: 't1' }), {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubblePending: false,
      resourceAvailable: false
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(false)
    expect(planned.presentation.soundType).toBe('attention')
    expect(planned.presentation.reason).toBe('attention_sound_resource_unavailable')
    expect(planned.presentation.shouldNotify).toBe(false)
  })
})

describe('气泡与声音绑定', () => {
  let sounds: CodexPartialFailureSoundGate
  let bubbles: CodexPartialFailureBubbleGate

  beforeEach(() => {
    sounds = new CodexPartialFailureSoundGate()
    bubbles = new CodexPartialFailureBubbleGate()
  })

  it('3. 气泡发送失败时不播放声音', () => {
    const bubble = presentPartialBubble(bubbles, partialFailure({ turnId: 't1' }), 'file-a')
    const planned = planSound(sounds, partialFailure({ turnId: 't1' }), {
      bubbleActuallyPresented: false,
      attentionAcknowledged: false,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(false)
    expect(planned.presentation.reason).toBe('bubble_not_presented')
  })

  it('4. 气泡被去重时不播放声音', () => {
    const first = presentPartialBubble(bubbles, partialFailure({ turnId: 't1', observedAt: NOW }), 'file-a')
    const dup = presentPartialBubble(
      bubbles,
      partialFailure({ turnId: 't1', observedAt: NOW + 3 }),
      'file-a'
    )
    expect(first.presentation.showBubble).toBe(true)
    expect(dup.presentation.showBubble).toBe(false)
    expect(dup.presentation.reason).toBe('duplicate_bubble')
    const planned = planSound(sounds, partialFailure({ turnId: 't1', observedAt: NOW + 3 }), {
      bubbleActuallyPresented: false,
      attentionAcknowledged: true,
      bubbleDedupeKey: dup.presentation.dedupeKey
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(false)
    expect(planned.presentation.reason).toBe('bubble_not_presented')
  })

  it('5. 窗口隐藏、气泡未发送时不播放声音', () => {
    const bubble = presentPartialBubble(bubbles, partialFailure({ turnId: 't1' }), 'file-a')
    const planned = planSound(sounds, partialFailure({ turnId: 't1' }), {
      bubbleActuallyPresented: false,
      attentionAcknowledged: false,
      bubblePending: true,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.presentation.reason).toBe('bubble_not_presented')
  })

  it('bubblePending 仍为 true 时不得播放声音', () => {
    const planned = planSound(sounds, partialFailure({ turnId: 't1' }), {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubblePending: true
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.presentation.reason).toBe('bubble_still_pending')
  })

  it('未 acknowledge 时不得播放声音', () => {
    const planned = planSound(sounds, partialFailure({ turnId: 't1' }), {
      bubbleActuallyPresented: true,
      attentionAcknowledged: false
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.presentation.reason).toBe('attention_not_acknowledged')
  })
})

describe('禁止播放声音的状态', () => {
  let sounds: CodexPartialFailureSoundGate

  beforeEach(() => {
    sounds = new CodexPartialFailureSoundGate()
  })

  it('6-10. working / completed_signal / unknown / stale / cancelled / failed / incomplete / waiting 不播放', () => {
    const cases: Array<[string, CodexDerivedState]> = [
      ['working', working()],
      ['completed_signal', completedSignal()],
      ['unknown', derived({ lifecycle: 'unknown' })],
      ['stale', staleRunning()],
      ['cancelled', cancelled()],
      ['failed', failedTurn()],
      ['incomplete', incomplete()],
      ['waiting', derived({ lifecycle: 'waiting_input', connection: 'connected' })]
    ]
    for (const [label, state] of cases) {
      const planned = planSound(sounds, state, {
        fileAlias: `file-${label}`,
        bubbleActuallyPresented: true,
        attentionAcknowledged: true
      })
      expect(planned.presentation.playSound, label).toBe(false)
      expect(wouldPlayCodexAttentionSound(planned.presentation), label).toBe(false)
      expect(planned.presentation.shouldNotify, label).toBe(false)
    }
  })

  it('tool_failed 但尚未形成 completed_with_partial_failure 时不播放', () => {
    const runningFail = working({
      cause: 'tool_failed',
      item: 'partial_failure',
      outputIntegrity: 'partial'
    })
    expect(mapCodexDerivedToCandidate(runningFail).candidate).not.toBe('completed_with_partial_failure')
    const planned = planSound(sounds, runningFail, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(planned.presentation)).toBe(false)
  })
})

describe('去重、新 turn 与多 session', () => {
  let sounds: CodexPartialFailureSoundGate
  let bubbles: CodexPartialFailureBubbleGate

  beforeEach(() => {
    sounds = new CodexPartialFailureSoundGate()
    bubbles = new CodexPartialFailureBubbleGate()
  })

  it('11. 同一 session/turn 不重复播放', () => {
    const state = partialFailure({ sessionId: 'sess-a', turnId: 't1' })
    const bubble = presentPartialBubble(bubbles, state, 'file-a')
    const first = planSound(sounds, state, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    const second = planSound(sounds, { ...state, observedAt: NOW + 4 }, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    expect(first.presentation.playSound).toBe(true)
    expect(wouldPlayCodexAttentionSound(first.presentation)).toBe(true)
    expect(second.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(second.presentation)).toBe(false)
    expect(second.presentation.reason).toBe('duplicate_sound')
    expect(first.presentation.dedupeKey).toBe(second.presentation.dedupeKey)
  })

  it('12. 新 turn 可以重新播放一次', () => {
    const oldState = partialFailure({ sessionId: 'sess-a', turnId: 'old', observedAt: NOW })
    const oldBubble = presentPartialBubble(bubbles, oldState, 'file-a')
    const oldSound = planSound(sounds, oldState, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: oldBubble.presentation.dedupeKey
    })
    planCodexPartialFailureBubble(bubbles, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'new', observedAt: NOW + 10 }),
      fileAlias: 'file-a'
    })
    const nextState = partialFailure({ sessionId: 'sess-a', turnId: 'new', observedAt: NOW + 20 })
    const nextBubble = presentPartialBubble(bubbles, nextState, 'file-a')
    const nextSound = planSound(sounds, nextState, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: nextBubble.presentation.dedupeKey
    })
    expect(oldSound.presentation.playSound).toBe(true)
    expect(nextSound.presentation.playSound).toBe(true)
    expect(wouldPlayCodexAttentionSound(oldSound.presentation)).toBe(true)
    expect(wouldPlayCodexAttentionSound(nextSound.presentation)).toBe(true)
    expect(oldSound.presentation.dedupeKey).not.toBe(nextSound.presentation.dedupeKey)
    expect(nextBubble.presentation.dedupeKey).toContain('turn:new')
  })

  it('13. 多 session 互相隔离', () => {
    const aState = partialFailure({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW })
    const bState = partialFailure({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 1 })
    const aBubble = presentPartialBubble(bubbles, aState, 'file-a')
    const bBubble = presentPartialBubble(bubbles, bState, 'file-b')
    const aSound = planSound(sounds, aState, {
      fileAlias: 'file-a',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: aBubble.presentation.dedupeKey
    })
    const bSound = planSound(sounds, bState, {
      fileAlias: 'file-b',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: bBubble.presentation.dedupeKey
    })
    expect(aSound.presentation.playSound).toBe(true)
    expect(bSound.presentation.playSound).toBe(true)
    expect(wouldPlayCodexAttentionSound(aSound.presentation)).toBe(true)
    expect(wouldPlayCodexAttentionSound(bSound.presentation)).toBe(true)
    expect(aSound.presentation.dedupeKey).not.toBe(bSound.presentation.dedupeKey)
  })

  it('14. B completed_signal 不触发声音', () => {
    const aState = partialFailure({ sessionId: 'sess-a', turnId: 'ta' })
    const aBubble = presentPartialBubble(bubbles, aState, 'file-a')
    planSound(sounds, aState, {
      fileAlias: 'file-a',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: aBubble.presentation.dedupeKey
    })
    const b = planSound(sounds, completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }), {
      fileAlias: 'file-b',
      bubbleActuallyPresented: false,
      attentionAcknowledged: false
    })
    expect(b.presentation.playSound).toBe(false)
    expect(wouldPlayCodexAttentionSound(b.presentation)).toBe(false)
    expect(b.candidate.candidate).toBe('completed_signal')
  })

  it('无官方 turnId 时不伪造 turn，只用本地 boundary', () => {
    const state = partialFailure()
    expect(state.turnId).toBeUndefined()
    const bubble = presentPartialBubble(bubbles, state, 'file-a')
    const planned = planSound(sounds, state, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubbleDedupeKey: bubble.presentation.dedupeKey,
      localBoundary: 0
    })
    expect(state.turnId).toBeUndefined()
    expect(planned.presentation.dedupeKey).toContain('bound:0')
    expect(planned.presentation.dedupeKey).not.toContain('turn:')
  })
})

describe('用户行为隔离与生命周期', () => {
  it('15. 旧 Codex done 不触发声音', () => {
    expect(CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED).toBe(false)
    const done = { source: 'codex' as const, kind: 'done' as const }
    expect(isCodexLegacyProtocolComplete(done)).toBe(true)
    expect(shouldPlayAgentCompletionSound([done])).toBe(false)
    expect(shouldPresentAgentTerminalToUser(done)).toBe(false)
    const planned = planSound(new CodexPartialFailureSoundGate(), completedSignal(), {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.candidate.legacyEquivalent).toBe('done')
    expect(planned.candidate.candidate).toBe('completed_signal')
  })

  it('16. 其他 Agent 声音行为不变', () => {
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
    const rejected = planSound(new CodexPartialFailureSoundGate(), partialFailure(), {
      source: 'claude',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(rejected.presentation.playSound).toBe(false)
    expect(rejected.presentation.reason).toBe('non_codex_ignored')
  })

  it('17. shouldNotify 始终为 false', () => {
    const states = [
      working(),
      completedSignal(),
      partialFailure(),
      cancelled(),
      staleRunning(),
      failedTurn(),
      incomplete(),
      derived({ lifecycle: 'unknown' })
    ]
    for (const state of states) {
      const planned = planSound(new CodexPartialFailureSoundGate(), state, {
        fileAlias: `file-${state.lifecycle}`,
        bubbleActuallyPresented: true,
        attentionAcknowledged: true
      })
      expect(planned.candidate.shouldNotify).toBe(false)
      expect(planned.presentation.shouldNotify).toBe(false)
    }
  })

  it('18. attention 展示后恢复 idle 的逻辑不被破坏', () => {
    const visual = new CodexSilentVisualGate()
    const bubbles = new CodexPartialFailureBubbleGate()
    const sounds = new CodexPartialFailureSoundGate()
    const aState = partialFailure({ sessionId: 'sess-a', turnId: 'ta' })
    const visualPlan = planCodexSilentVisual(visual, {
      enabled: true,
      derived: aState,
      fileAlias: 'file-a'
    })
    const bubble = presentPartialBubble(bubbles, aState, 'file-a')
    visual.acknowledgePresented(bubble.presentation.presentedSessionKeys)
    const sounded = planSound(sounds, aState, {
      bubbleActuallyPresented: true,
      attentionAcknowledged: true,
      bubblePending: false,
      bubbleDedupeKey: bubble.presentation.dedupeKey
    })
    expect(visualPlan.presentation.petState).toBe('attention')
    expect(sounded.presentation.playSound).toBe(true)
    expect(wouldPlayCodexAttentionSound(sounded.presentation)).toBe(true)
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('idle')
    const b = planCodexSilentVisual(visual, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 6 }),
      fileAlias: 'file-b'
    })
    const bSound = planSound(sounds, completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 6 }), {
      fileAlias: 'file-b',
      bubbleActuallyPresented: false,
      attentionAcknowledged: false
    })
    expect(b.presentation.petState).toBe('idle')
    expect(bSound.presentation.playSound).toBe(false)
    expect(visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')?.candidate).toBe(
      'completed_with_partial_failure'
    )
  })

  it('19. priming/history 不播放声音', () => {
    const planned = planSound(new CodexPartialFailureSoundGate(), partialFailure({ turnId: 't1' }), {
      live: false,
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.presentation.reason).toBe('priming_not_sounded')
  })

  it('A 未展示、B working 时 A 不出声，B working 也不出声', () => {
    const sounds = new CodexPartialFailureSoundGate()
    const a = planSound(sounds, partialFailure({ sessionId: 'sess-a', turnId: 'ta' }), {
      fileAlias: 'file-a',
      bubbleActuallyPresented: false,
      attentionAcknowledged: false,
      bubblePending: true
    })
    const b = planSound(sounds, working({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 2 }), {
      fileAlias: 'file-b',
      bubbleActuallyPresented: false,
      attentionAcknowledged: false
    })
    expect(a.presentation.playSound).toBe(false)
    expect(b.presentation.playSound).toBe(false)
  })

  it('独立 attention 音不复用 playDing，气泡 sound 保持 false', () => {
    const petView = readFileSync(join(process.cwd(), 'src/renderer/src/components/PetView.tsx'), 'utf8')
    expect(petView).toContain('function playDing()')
    expect(petView).toContain('function playCodexAttentionNotice')
    expect(petView).toContain('onPlayCodexAttentionSound')
    expect(petView).toMatch(/if \(payload\.sound\) playDing\(\)/)
    expect(petView).not.toMatch(/playDing\(\s*payload/)
    const bubble = presentPartialBubble(
      new CodexPartialFailureBubbleGate(),
      partialFailure({ turnId: 't1' }),
      'file-a'
    )
    expect(bubble.presentation.sound).toBe(false)
    expect(bubble.presentation.showBubble).toBe(true)
  })
})
