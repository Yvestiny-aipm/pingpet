import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CodexDerivedState, PetState } from '@shared/types'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import {
  CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED,
  isCelebratingPetState,
  isCodexLegacyProtocolComplete,
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser,
  silentCodexCompletionPetState
} from './codexLegacyPresentation'
import { emptyCodexDerivedState } from './codexState'
import {
  CODEX_CAUTIOUS_PET_STATE,
  CodexSilentVisualGate,
  isCelebratingVisual,
  mapCodexCandidateToSilentVisual,
  planCodexSilentVisual,
  sameVisualTurn,
  shadowObservationCanDriveVisual,
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

function assertSilent(presentation: {
  showBubble: boolean
  playSound: boolean
  shouldNotify: boolean
  petState: PetState | null
}): void {
  expect(presentation.showBubble).toBe(false)
  expect(presentation.playSound).toBe(false)
  expect(presentation.shouldNotify).toBe(false)
  expect(isCelebratingVisual(presentation.petState)).toBe(false)
  if (presentation.petState) {
    expect(isCelebratingPetState(presentation.petState)).toBe(false)
    expect(presentation.petState).not.toBe('happy')
  }
}

describe('功能开关默认关闭', () => {
  it('默认值为 false，关闭时 Codex candidate 不改变用户行为', () => {
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    const gate = new CodexSilentVisualGate()
    const planned = planCodexSilentVisual(gate, { enabled: false, derived: working(), fileAlias: 'file-a' })
    expect(planned.applied).toBe(false)
    expect(planned.presentation.applyPetState).toBe(false)
    expect(planned.presentation.petState).toBeNull()
    expect(planned.presentation.reason).toBe('codex_candidate_visual_disabled')
    assertSilent(planned.presentation)
    expect(shouldLegacyCodexDrivePetVisual(false, { source: 'codex', kind: 'working' })).toBe(true)
    expect(shouldLegacyCodexDrivePetVisual(false, { source: 'codex', kind: 'done' })).toBe(true)
  })
})

describe('Codex candidate → 静默桌宠姿态', () => {
  it('working → thinking，不弹气泡、不播放声音', () => {
    const presentation = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(working()),
      derived: working(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(presentation.applyPetState).toBe(true)
    expect(presentation.petState).toBe('thinking')
    assertSilent(presentation)
  })

  it('completed_signal → idle，不得 happy/celebrating', () => {
    const state = completedSignal()
    const presentation = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(state),
      derived: state,
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(presentation.applyPetState).toBe(true)
    expect(presentation.petState).toBe('idle')
    expect(presentation.petState).not.toBe('happy')
    expect(isCelebratingVisual(presentation.petState)).toBe(false)
    assertSilent(presentation)
  })

  it('completed_with_partial_failure → cautious(attention)，保留内部证据', () => {
    const state = partialFailure()
    const evidence = snapshotPartialFailureEvidence(state)
    expect(evidence).toEqual({
      cause: 'tool_failed',
      item: 'partial_failure',
      outputIntegrity: 'partial',
      taskSemantics: 'not_verified'
    })
    const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: state,
      fileAlias: 'file-a'
    })
    expect(planned.candidate.candidate).toBe('completed_with_partial_failure')
    expect(planned.applied).toBe(true)
    expect(planned.presentation.petState).toBe(CODEX_CAUTIOUS_PET_STATE)
    expect(planned.presentation.petState).toBe('attention')
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.presentation.playSound).toBe(false)
    expect(snapshotPartialFailureEvidence(state)).toEqual(evidence)
    assertSilent(planned.presentation)
  })

  it('unknown / stale 不抢占当前姿态', () => {
    const stale = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(staleRunning()),
      derived: staleRunning(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(stale.applyPetState).toBe(false)
    expect(stale.petState).toBeNull()
    expect(stale.reason).toBe('observation_stale_keep_pose')
    assertSilent(stale)

    const unknown = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(derived({ lifecycle: 'unknown' })),
      derived: derived({ lifecycle: 'unknown' }),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(unknown.applyPetState).toBe(false)
    expect(unknown.petState).toBeNull()
    expect(unknown.reason).toBe('unknown_keep_pose')
    assertSilent(unknown)
  })

  it('cancelled → idle，不弹气泡、不播放声音、不显示失败', () => {
    const presentation = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(cancelled()),
      derived: cancelled(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(presentation.applyPetState).toBe(true)
    expect(presentation.petState).toBe('idle')
    expect(presentation.petState).not.toBe('failed')
    assertSilent(presentation)
  })

  it('failed / incomplete 本轮不改变桌宠', () => {
    const fail = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(failedTurn()),
      derived: failedTurn(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(fail.applyPetState).toBe(false)
    expect(fail.petState).toBeNull()
    expect(fail.reason).toBe('failed_or_incomplete_not_wired')

    const inc = mapCodexCandidateToSilentVisual({
      enabled: true,
      candidate: mapCodexDerivedToCandidate(incomplete()),
      derived: incomplete(),
      fileAlias: 'file-a',
      observedAt: NOW
    })
    expect(inc.applyPetState).toBe(false)
    expect(inc.petState).toBeNull()
    expect(inc.reason).toBe('failed_or_incomplete_not_wired')
  })
})

describe('数据来源、隔离和去重', () => {
  let gate: CodexSilentVisualGate

  beforeEach(() => {
    gate = new CodexSilentVisualGate()
  })

  it('priming 不触发视觉动作', () => {
    expect(shadowObservationCanDriveVisual({ emitCallbacks: false })).toBe(false)
    expect(shadowObservationCanDriveVisual({ emitCallbacks: true, primed: false })).toBe(false)
    expect(shadowObservationCanDriveVisual({ emitCallbacks: true, primed: true })).toBe(true)
    const priming = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-hist' }),
      fileAlias: 'file-hist',
      live: false
    })
    expect(priming.applied).toBe(false)
    expect(priming.presentation.reason).toBe('priming_not_arbitrated')
    expect(gate.snapshotSessions()).toHaveLength(0)
    const planned = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working(),
      fileAlias: 'file-a'
    })
    expect(planned.applied).toBe(true)
    expect(shadowObservationCanDriveVisual({ emitCallbacks: false }) && planned.applied).toBe(false)
  })

  it('重复 candidate 不重复执行动作', () => {
    const first = planCodexSilentVisual(gate, { enabled: true, derived: working({ turnId: 't1' }), fileAlias: 'file-a' })
    const second = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ turnId: 't1', observedAt: NOW + 10 }),
      fileAlias: 'file-a'
    })
    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.presentation.reason).toBe('duplicate_visual')
    assertSilent(second.presentation)

    const done1 = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 't1', observedAt: NOW + 20 }),
      fileAlias: 'file-a'
    })
    const done2 = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 't1', observedAt: NOW + 30 }),
      fileAlias: 'file-a'
    })
    expect(done1.applied).toBe(true)
    expect(done2.applied).toBe(false)

    const pf1 = planCodexSilentVisual(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-pf', turnId: 't9', observedAt: NOW }),
      fileAlias: 'file-pf'
    })
    const pf2 = planCodexSilentVisual(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-pf', turnId: 't9', observedAt: NOW + 5 }),
      fileAlias: 'file-pf'
    })
    expect(pf1.applied).toBe(true)
    expect(pf2.applied).toBe(false)
  })

  it('多 session 隔离：状态分存，同时 working 只切一次 thinking', () => {
    const a = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-1', turnId: 't1' }),
      fileAlias: 'file-1'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-2', turnId: 't1' }),
      fileAlias: 'file-2'
    })
    expect(a.applied).toBe(true)
    expect(a.presentation.petState).toBe('thinking')
    expect(b.applied).toBe(false)
    expect(b.presentation.petState).toBe('thinking')
    expect(b.presentation.reason).toBe('duplicate_visual')
    expect(visualSessionKey('file-1', 'sess-1')).not.toBe(visualSessionKey('file-2', 'sess-2'))
    expect(gate.snapshotSessions()).toHaveLength(2)
  })

  it('跨 turn 隔离：新 turn 可再进入 thinking，旧 turn 不得覆盖新 turn', () => {
    const first = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ turnId: 'old', observedAt: NOW }),
      fileAlias: 'file-a'
    })
    const done = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 'old', observedAt: NOW + 10 }),
      fileAlias: 'file-a'
    })
    const nextTurn = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ turnId: 'new', observedAt: NOW + 20 }),
      fileAlias: 'file-a'
    })
    expect(first.applied).toBe(true)
    expect(done.applied).toBe(true)
    expect(nextTurn.applied).toBe(true)
    expect(nextTurn.presentation.petState).toBe('thinking')

    const staleOld = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 'old', observedAt: NOW + 5 }),
      fileAlias: 'file-a'
    })
    expect(staleOld.applied).toBe(false)
    expect(staleOld.presentation.reason).toBe('older_observation_ignored')
  })

  it('缺失 turnId 时不得自行生成', () => {
    const state = working()
    expect(state.turnId).toBeUndefined()
    const planned = planCodexSilentVisual(gate, { enabled: true, derived: state, fileAlias: 'file-a' })
    expect(planned.applied).toBe(true)
    expect(state.turnId).toBeUndefined()
    expect(sameVisualTurn(undefined, undefined)).toBe(true)
    expect('turnId' in state && state.turnId !== undefined).toBe(false)
  })

  it('stale 恢复不触发声音或气泡', () => {
    expect(
      planCodexSilentVisual(gate, { enabled: true, derived: working({ turnId: 't1' }), fileAlias: 'file-a' }).applied
    ).toBe(true)
    const keep = planCodexSilentVisual(gate, {
      enabled: true,
      derived: staleRunning({ turnId: 't1', observedAt: NOW + 10 }),
      fileAlias: 'file-a'
    })
    expect(keep.applied).toBe(false)
    assertSilent(keep.presentation)
    const recovered = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ turnId: 't1', observedAt: NOW + 20 }),
      fileAlias: 'file-a'
    })
    expect(recovered.applied).toBe(true)
    expect(recovered.presentation.petState).toBe('idle')
    assertSilent(recovered.presentation)
  })

  it('stale/unknown 不抢占已经切过的姿态', () => {
    expect(
      planCodexSilentVisual(gate, { enabled: true, derived: working({ turnId: 't1' }), fileAlias: 'file-a' }).applied
    ).toBe(true)
    const stale = planCodexSilentVisual(gate, {
      enabled: true,
      derived: staleRunning({ turnId: 't1', observedAt: NOW + 1 }),
      fileAlias: 'file-a'
    })
    expect(stale.applied).toBe(false)
    const unknown = planCodexSilentVisual(gate, {
      enabled: true,
      derived: derived({ lifecycle: 'unknown', turnId: 't1', observedAt: NOW + 2 }),
      fileAlias: 'file-a'
    })
    expect(unknown.applied).toBe(false)
  })

  it('旧 Monitor 与 candidate 同时产生事件时不得重复视觉切换', () => {
    expect(shouldLegacyCodexDrivePetVisual(true, { source: 'codex', kind: 'working' })).toBe(false)
    expect(shouldLegacyCodexDrivePetVisual(true, { source: 'codex', kind: 'done' })).toBe(false)
    const first = planCodexSilentVisual(gate, { enabled: true, derived: working({ turnId: 't1' }), fileAlias: 'file-a' })
    const repeat = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ turnId: 't1', observedAt: NOW + 1 }),
      fileAlias: 'file-a'
    })
    expect(first.applied).toBe(true)
    expect(repeat.applied).toBe(false)
    expect(first.presentation.petState).toBe('thinking')
  })

  it('shouldNotify 始终为 false', () => {
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
      const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
        enabled: true,
        derived: state,
        fileAlias: `file-${state.lifecycle}`
      })
      expect(planned.candidate.shouldNotify).toBe(false)
      expect(planned.presentation.shouldNotify).toBe(false)
      assertSilent(planned.presentation)
    }
  })
})

describe('用户行为隔离', () => {
  it('Codex 不影响其他 Agent', () => {
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'working' })).toBe(true)
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
  })

  it('旧 Codex done 不恢复成功气泡、完成音或庆祝', () => {
    expect(CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED).toBe(false)
    const done = { source: 'codex' as const, kind: 'done' as const }
    expect(isCodexLegacyProtocolComplete(done)).toBe(true)
    expect(shouldPresentAgentTerminalToUser(done)).toBe(false)
    expect(shouldPlayAgentCompletionSound([done])).toBe(false)
    expect(silentCodexCompletionPetState()).toBe('idle')
    expect(isCelebratingPetState(silentCodexCompletionPetState())).toBe(false)
    const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: completedSignal(),
      fileAlias: 'file-a'
    })
    expect(planned.presentation.petState).toBe('idle')
    expect(planned.presentation.petState).not.toBe('happy')
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.presentation.playSound).toBe(false)
    expect(planned.candidate.legacyEquivalent).toBe('done')
    expect(planned.candidate.candidate).toBe('completed_signal')
  })

  it('waiting 本轮不接入桌宠', () => {
    const state = derived({ lifecycle: 'waiting_input', connection: 'connected' })
    const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: state,
      fileAlias: 'file-a'
    })
    expect(planned.candidate.candidate).toBe('waiting')
    expect(planned.applied).toBe(false)
    expect(planned.presentation.reason).toBe('waiting_not_wired')
  })

  it('没有 session 标识时不得猜造并执行姿态', () => {
    const state = working({ sessionId: undefined })
    const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: state
    })
    expect(planned.applied).toBe(false)
    expect(planned.presentation.reason).toBe('missing_session_key')
    expect(state.sessionId).toBeUndefined()
  })
})
