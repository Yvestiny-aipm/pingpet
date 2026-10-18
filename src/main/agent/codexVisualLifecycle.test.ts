import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CodexDerivedState, PetState } from '@shared/types'
import {
  CODEX_PARTIAL_FAILURE_BUBBLE_TEXT,
  CodexPartialFailureBubbleGate,
  planCodexPartialFailureBubble
} from './codexBubblePresentation'
import {
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser
} from './codexLegacyPresentation'
import { emptyCodexDerivedState } from './codexState'
import { reduceCodexSessionsToGlobalPose } from './codexVisualArbitration'
import {
  CodexSilentVisualGate,
  isCelebratingVisual,
  planCodexSilentVisual,
  shouldLegacyCodexDrivePetVisual,
  snapshotPartialFailureEvidence,
  visualSessionKey
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

function staleUnknown(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'unknown',
    connection: 'stale',
    ...partial
  })
}

function assertSilentVisual(presentation: {
  showBubble: boolean
  playSound: boolean
  shouldNotify: boolean
  petState: PetState | null
}): void {
  expect(presentation.showBubble).toBe(false)
  expect(presentation.playSound).toBe(false)
  expect(presentation.shouldNotify).toBe(false)
  expect(isCelebratingVisual(presentation.petState)).toBe(false)
}

describe('部分失败 attention 展示生命周期', () => {
  let visual: CodexSilentVisualGate
  let bubbles: CodexPartialFailureBubbleGate

  beforeEach(() => {
    visual = new CodexSilentVisualGate()
    bubbles = new CodexPartialFailureBubbleGate()
  })

  function showPartial(fileAlias: string, state: CodexDerivedState) {
    return {
      visual: planCodexSilentVisual(visual, { enabled: true, derived: state, fileAlias }),
      bubble: planCodexPartialFailureBubble(bubbles, { enabled: true, derived: state, fileAlias })
    }
  }

  it('1. partial_failure 首次产生 attention', () => {
    const state = partialFailure({ sessionId: 'sess-a', turnId: 't1' })
    const { visual: planned, bubble } = showPartial('file-a', state)
    expect(planned.candidate.candidate).toBe('completed_with_partial_failure')
    expect(planned.applied).toBe(true)
    expect(planned.presentation.petState).toBe('attention')
    expect(visual.snapshotSessions()[0]?.bubblePending).toBe(true)
    expect(visual.snapshotSessions()[0]?.attentionAcknowledged).not.toBe(true)
    expect(bubble.presentation.showBubble).toBe(true)
    expect(bubble.presentation.text).toBe(CODEX_PARTIAL_FAILURE_BUBBLE_TEXT)
  })

  it('2. 气泡展示成功后，单独 session 可以恢复 idle', () => {
    const state = partialFailure({ sessionId: 'sess-a', turnId: 't1' })
    const { visual: planned, bubble } = showPartial('file-a', state)
    expect(planned.presentation.petState).toBe('attention')
    visual.acknowledgePresented(bubble.presentation.presentedSessionKeys)
    const slot = visual.snapshotSessions()[0]
    expect(slot?.candidate).toBe('completed_with_partial_failure')
    expect(slot?.bubblePending).toBe(false)
    expect(slot?.attentionAcknowledged).toBe(true)
    expect(slot?.lastPresentedCandidate).toBe('completed_with_partial_failure')
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('idle')
  })

  it('3. 气泡展示前不能清除 attentionPending', () => {
    showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 't1' }))
    const other = planCodexSilentVisual(visual, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(other.presentation.petState).toBe('attention')
    expect(visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')?.attentionAcknowledged).not.toBe(
      true
    )
    expect(visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')?.bubblePending).toBe(true)
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('attention')
  })

  it('4. B completed_signal 不会清除 A 的未提醒 partial_failure', () => {
    const aState = partialFailure({ sessionId: 'sess-a', turnId: 'ta' })
    showPartial('file-a', aState)
    const bBubble = planCodexPartialFailureBubble(bubbles, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    const bVisual = planCodexSilentVisual(visual, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(bBubble.presentation.showBubble).toBe(false)
    expect(bVisual.presentation.petState).toBe('attention')
    const slotA = visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')
    expect(slotA?.candidate).toBe('completed_with_partial_failure')
    expect(slotA?.bubblePending).toBe(true)
    expect(slotA?.attentionAcknowledged).not.toBe(true)
  })

  it('5. B working 时全局为 thinking', () => {
    showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 'ta' }))
    visual.acknowledgePresented([visualSessionKey('file-a', 'sess-a')!])
    const b = planCodexSilentVisual(visual, {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(b.applied).toBe(true)
    expect(b.presentation.petState).toBe('thinking')
    expect(visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')?.candidate).toBe(
      'completed_with_partial_failure'
    )
  })

  it('6. A 新 turn 会清除上一轮的 attentionPending', () => {
    const first = partialFailure({ sessionId: 'sess-a', turnId: 'old', observedAt: NOW })
    showPartial('file-a', first)
    expect(visual.snapshotSessions()[0]?.bubblePending).toBe(true)
    const next = planCodexSilentVisual(visual, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'new', observedAt: NOW + 20 }),
      fileAlias: 'file-a'
    })
    expect(next.applied).toBe(true)
    expect(next.presentation.petState).toBe('thinking')
    const slot = visual.snapshotSessions()[0]
    expect(slot?.candidate).toBe('working')
    expect(slot?.turnId).toBe('new')
    expect(slot?.bubblePending).toBe(false)
    expect(slot?.attentionAcknowledged).not.toBe(true)
    expect(slot?.lastPresentedCandidate).toBeUndefined()
  })

  it('7. 内部 candidate/cause/item/outputIntegrity 仍保留', () => {
    const state = partialFailure({ sessionId: 'sess-a', turnId: 't1' })
    const evidence = snapshotPartialFailureEvidence(state)
    const { visual: planned, bubble } = showPartial('file-a', state)
    visual.acknowledgePresented(bubble.presentation.presentedSessionKeys)
    const replay = planCodexSilentVisual(visual, {
      enabled: true,
      derived: { ...state, observedAt: NOW + 8 },
      fileAlias: 'file-a'
    })
    const slot = visual.snapshotSessions()[0]
    expect(planned.candidate.candidate).toBe('completed_with_partial_failure')
    expect(replay.candidate.candidate).toBe('completed_with_partial_failure')
    expect(slot?.candidate).toBe('completed_with_partial_failure')
    expect(snapshotPartialFailureEvidence(state)).toEqual({
      cause: 'tool_failed',
      item: 'partial_failure',
      outputIntegrity: 'partial',
      taskSemantics: 'not_verified'
    })
    expect(evidence).toEqual(snapshotPartialFailureEvidence(state))
    expect(slot?.attentionAcknowledged).toBe(true)
  })

  it('8. 同一 session/turn 不重复弹气泡', () => {
    const first = showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 't1', observedAt: NOW }))
    const second = showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 't1', observedAt: NOW + 4 }))
    expect(first.bubble.presentation.showBubble).toBe(true)
    expect(second.bubble.presentation.showBubble).toBe(false)
    expect(second.bubble.presentation.reason).toBe('duplicate_bubble')
    expect(first.bubble.presentation.dedupeKey).toBe(second.bubble.presentation.dedupeKey)
  })

  it('9. 多 session 各自隔离', () => {
    const a = showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW }))
    const b = showPartial('file-b', partialFailure({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 1 }))
    expect(a.bubble.presentation.showBubble).toBe(true)
    expect(b.bubble.presentation.showBubble).toBe(true)
    expect(a.bubble.presentation.dedupeKey).not.toBe(b.bubble.presentation.dedupeKey)
    expect(a.bubble.presentation.presentedSessionKeys).toEqual(['file:file-a'])
    expect(b.bubble.presentation.presentedSessionKeys).toEqual(['file:file-b'])
    visual.acknowledgePresented(a.bubble.presentation.presentedSessionKeys)
    const slotA = visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')
    const slotB = visual.snapshotSessions().find((s) => s.fileAlias === 'file-b')
    expect(slotA?.attentionAcknowledged).toBe(true)
    expect(slotB?.attentionAcknowledged).not.toBe(true)
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('attention')
  })

  it('10. priming/history 不改变 attention', () => {
    showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 't1' }))
    const priming = planCodexSilentVisual(visual, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-hist', turnId: 'th', observedAt: NOW + 2 }),
      fileAlias: 'file-hist',
      live: false
    })
    const primingBubble = planCodexPartialFailureBubble(bubbles, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-hist', turnId: 'th', observedAt: NOW + 2 }),
      fileAlias: 'file-hist',
      live: false
    })
    expect(priming.applied).toBe(false)
    expect(priming.presentation.reason).toBe('priming_not_arbitrated')
    expect(primingBubble.presentation.showBubble).toBe(false)
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('attention')
    expect(visual.snapshotSessions()).toHaveLength(1)
  })

  it('11. stale/unknown 不清除未展示的 partial_failure', () => {
    showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 't1' }))
    const stale = planCodexSilentVisual(visual, {
      enabled: true,
      derived: staleUnknown({ sessionId: 'sess-a', turnId: 't1', observedAt: NOW + 3 }),
      fileAlias: 'file-a'
    })
    expect(stale.applied).toBe(false)
    expect(stale.presentation.reason).toBe('stale_keep_pending_partial_failure')
    const slot = visual.snapshotSessions()[0]
    expect(slot?.candidate).toBe('completed_with_partial_failure')
    expect(slot?.bubblePending).toBe(true)
    expect(slot?.attentionAcknowledged).not.toBe(true)
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('attention')
  })

  it('12-15. 不弹成功气泡、不播放声音、shouldNotify=false、其他 Agent 不变', () => {
    const a = showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 'ta' }))
    visual.acknowledgePresented(a.bubble.presentation.presentedSessionKeys)
    const b = planCodexSilentVisual(visual, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 6 }),
      fileAlias: 'file-b'
    })
    const bBubble = planCodexPartialFailureBubble(bubbles, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 6 }),
      fileAlias: 'file-b'
    })
    expect(b.applied).toBe(true)
    expect(b.presentation.petState).toBe('idle')
    expect(bBubble.presentation.showBubble).toBe(false)
    expect(a.bubble.presentation.sound).toBe(false)
    expect(b.presentation.playSound).toBe(false)
    expect(a.visual.candidate.shouldNotify).toBe(false)
    expect(b.candidate.shouldNotify).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateBubbleEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateSoundEnabled).toBe(false)
    assertSilentVisual(a.visual.presentation)
    assertSilentVisual(b.presentation)
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
  })

  it('已展示的 A 加上未展示的 C 时仍保持 attention', () => {
    const a = showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW }))
    visual.acknowledgePresented(a.bubble.presentation.presentedSessionKeys)
    showPartial('file-c', partialFailure({ sessionId: 'sess-c', turnId: 'tc', observedAt: NOW + 2 }))
    expect(reduceCodexSessionsToGlobalPose(visual.snapshotSessions()).petState).toBe('attention')
  })

  it('A 未展示、B working 时不得丢失 A 的待提醒', () => {
    showPartial('file-a', partialFailure({ sessionId: 'sess-a', turnId: 'ta' }))
    const b = planCodexSilentVisual(visual, {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 2 }),
      fileAlias: 'file-b'
    })
    expect(b.presentation.petState).toBe('thinking')
    const queued = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 'tb' }),
      fileAlias: 'file-b'
    })
    expect(queued.presentation.showBubble).toBe(false)
    const slotA = visual.snapshotSessions().find((s) => s.fileAlias === 'file-a')
    expect(slotA?.candidate).toBe('completed_with_partial_failure')
    expect(slotA?.bubblePending).toBe(true)
  })
})
