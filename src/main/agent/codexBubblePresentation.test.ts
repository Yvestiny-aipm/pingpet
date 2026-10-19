import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CodexDerivedState } from '@shared/types'
import {
  CODEX_PARTIAL_FAILURE_BUBBLE_TEXT,
  CodexPartialFailureBubbleGate,
  bubbleTurnToken,
  looksLikeCodexSuccessBubbleCopy,
  mapCodexCandidateToBubble,
  planCodexPartialFailureBubble
} from './codexBubblePresentation'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import {
  CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED,
  isCodexLegacyProtocolComplete,
  looksLikeTaskSuccessCopy,
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser,
  silentCodexCompletionPetState
} from './codexLegacyPresentation'
import { emptyCodexDerivedState } from './codexState'
import { shouldLegacyCodexDrivePetVisual } from './codexVisiblePresentation'

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

function assertNoNotify(presentation: { showBubble: boolean; sound: boolean; shouldNotify: boolean; text?: string }): void {
  expect(presentation.sound).toBe(false)
  expect(presentation.shouldNotify).toBe(false)
  if (presentation.text) {
    expect(looksLikeCodexSuccessBubbleCopy(presentation.text)).toBe(false)
    expect(looksLikeTaskSuccessCopy(presentation.text)).toBe(false)
  }
}

describe('Codex 部分失败气泡开关与文案', () => {
  it('默认关闭，关闭时不弹气泡', () => {
    expect(DEFAULT_SETTINGS.codexCandidateBubbleEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    const planned = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: false,
      derived: partialFailure(),
      fileAlias: 'file-a'
    })
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.presentation.reason).toBe('codex_candidate_bubble_disabled')
    assertNoNotify(planned.presentation)
  })

  it('开关打开时，completed_with_partial_failure 弹一条中性气泡', () => {
    const planned = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: partialFailure({ turnId: 't1' }),
      fileAlias: 'file-a'
    })
    expect(planned.candidate.candidate).toBe('completed_with_partial_failure')
    expect(planned.presentation.showBubble).toBe(true)
    expect(planned.presentation.text).toBe(CODEX_PARTIAL_FAILURE_BUBBLE_TEXT)
    expect(looksLikeCodexSuccessBubbleCopy(planned.presentation.text!)).toBe(false)
    expect(planned.presentation.text).not.toContain('任务完成')
    expect(planned.presentation.text).not.toContain('成功')
    expect(planned.presentation.text).not.toContain('全部完成')
    expect(planned.presentation.sound).toBe(false)
    expect(planned.presentation.shouldNotify).toBe(false)
    expect(planned.presentation.presentedSessionKeys).toEqual(['file:file-a'])
  })
})

describe('禁止弹气泡的状态', () => {
  it('working / completed_signal / unknown / stale / cancelled / failed / incomplete / waiting 不弹', () => {
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
      const planned = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
        enabled: true,
        derived: state,
        fileAlias: `file-${label}`
      })
      expect(planned.presentation.showBubble, label).toBe(false)
      expect(planned.presentation.sound, label).toBe(false)
      expect(planned.presentation.shouldNotify, label).toBe(false)
    }
  })
})

describe('去重、priming 与无 turnId', () => {
  let gate: CodexPartialFailureBubbleGate

  beforeEach(() => {
    gate = new CodexPartialFailureBubbleGate()
  })

  it('同一 session、同一 turn、同一 candidate 不重复弹', () => {
    const first = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ turnId: 't1', observedAt: NOW }),
      fileAlias: 'file-a'
    })
    const second = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ turnId: 't1', observedAt: NOW + 5 }),
      fileAlias: 'file-a'
    })
    expect(first.presentation.showBubble).toBe(true)
    expect(second.presentation.showBubble).toBe(false)
    expect(second.presentation.reason).toBe('duplicate_bubble')
    expect(first.presentation.dedupeKey).toBe(second.presentation.dedupeKey)
  })

  it('priming/history 不弹', () => {
    const planned = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ turnId: 't1' }),
      fileAlias: 'file-hist',
      live: false
    })
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.presentation.reason).toBe('priming_not_bubbled')
  })

  it('无 turnId 时不伪造官方 turnId，只用本地 boundary', () => {
    const state = partialFailure()
    expect(state.turnId).toBeUndefined()
    const planned = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: state,
      fileAlias: 'file-a'
    })
    expect(state.turnId).toBeUndefined()
    expect(planned.presentation.showBubble).toBe(true)
    expect(planned.presentation.dedupeKey).toContain('bound:0')
    expect(planned.presentation.dedupeKey).not.toContain('turn:')
    expect(bubbleTurnToken(undefined, 0)).toBe('bound:0')
    expect(bubbleTurnToken('real-turn', 0)).toBe('turn:real-turn')
  })

  it('stale 恢复不弹气泡', () => {
    planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: working({ turnId: 't1' }),
      fileAlias: 'file-a'
    })
    const stale = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: staleRunning({ turnId: 't1', observedAt: NOW + 1 }),
      fileAlias: 'file-a'
    })
    const recovered = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 't1', observedAt: NOW + 2 }),
      fileAlias: 'file-a'
    })
    expect(stale.presentation.showBubble).toBe(false)
    expect(recovered.presentation.showBubble).toBe(false)
    expect(recovered.candidate.candidate).toBe('completed_signal')
  })
})

describe('多 session 气泡规则', () => {
  let gate: CodexPartialFailureBubbleGate

  beforeEach(() => {
    gate = new CodexPartialFailureBubbleGate()
  })

  it('A partial_failure、B completed_signal：不产生成功气泡，部分失败语义不被覆盖', () => {
    const a = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const b = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(a.presentation.showBubble).toBe(true)
    expect(looksLikeCodexSuccessBubbleCopy(a.presentation.text!)).toBe(false)
    expect(b.presentation.showBubble).toBe(false)
    expect(b.candidate.candidate).toBe('completed_signal')
    expect(b.presentation.reason).not.toContain('success')
  })

  it('A working、B partial_failure：暂缓入队，working 结束后弹一次', () => {
    planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const queued = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(queued.presentation.showBubble).toBe(false)
    expect(queued.presentation.reason).toBe('queued_until_no_working')
    expect(gate.snapshotPending()).toHaveLength(1)

    const released = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW + 10 }),
      fileAlias: 'file-a'
    })
    expect(released.presentation.showBubble).toBe(true)
    expect(released.presentation.text).toBe(CODEX_PARTIAL_FAILURE_BUBBLE_TEXT)
    expect(released.presentation.reason).toBe('queued_partial_failure_released')
    expect(looksLikeCodexSuccessBubbleCopy(released.presentation.text!)).toBe(false)
    expect(released.presentation.sound).toBe(false)
    expect(gate.snapshotPending()).toHaveLength(0)

    const again = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW + 11 }),
      fileAlias: 'file-a'
    })
    expect(again.presentation.showBubble).toBe(false)
  })

  it('入队后该 session 被新 turn 替代则不再提醒', () => {
    planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-b', turnId: 'old', observedAt: NOW + 1 }),
      fileAlias: 'file-b'
    })
    expect(gate.snapshotPending()).toHaveLength(1)
    planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 'new', observedAt: NOW + 2 }),
      fileAlias: 'file-b'
    })
    expect(gate.snapshotPending()).toHaveLength(0)
    const done = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW + 3 }),
      fileAlias: 'file-a'
    })
    expect(done.presentation.showBubble).toBe(false)
  })

  it('旧 session 的更早观察不能覆盖新 session', () => {
    const fresh = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-new', turnId: 'tn', observedAt: NOW + 50 }),
      fileAlias: 'file-new'
    })
    const old = planCodexPartialFailureBubble(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-old', turnId: 'to', observedAt: NOW + 10 }),
      fileAlias: 'file-old'
    })
    expect(fresh.presentation.showBubble).toBe(true)
    expect(old.presentation.showBubble).toBe(false)
    expect(old.presentation.reason).not.toBe('candidate_completed_with_partial_failure_bubble')
  })
})

describe('用户行为隔离', () => {
  it('Codex 不影响 Claude/Cursor/Grok', () => {
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
    const rejected = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: partialFailure(),
      fileAlias: 'file-a',
      source: 'claude'
    })
    expect(rejected.presentation.showBubble).toBe(false)
    expect(rejected.presentation.reason).toBe('non_codex_ignored')
  })

  it('不播放声音，shouldNotify 仍为 false', () => {
    const mapped = mapCodexCandidateToBubble({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(partialFailure()),
      derived: partialFailure(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(mapped.sound).toBe(false)
    expect(mapped.shouldNotify).toBe(false)
  })

  it('旧 Codex done 只弹中性气泡，不恢复成功气泡', () => {
    expect(CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED).toBe(true)
    const done = { source: 'codex' as const, kind: 'done' as const }
    expect(isCodexLegacyProtocolComplete(done)).toBe(true)
    expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
    expect(silentCodexCompletionPetState()).toBe('idle')
    const planned = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: completedSignal(),
      fileAlias: 'file-a'
    })
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.candidate.legacyEquivalent).toBe('done')
    expect(planned.candidate.candidate).toBe('completed_signal')
  })
})
