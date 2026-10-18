import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CodexDerivedState, PetState } from '@shared/types'
import {
  reduceCodexSessionsToGlobalPose,
  sessionVisualDriver,
  type CodexSessionVisualSlot
} from './codexVisualArbitration'
import { emptyCodexDerivedState } from './codexState'
import {
  CodexSilentVisualGate,
  isCelebratingVisual,
  planCodexSilentVisual,
  shouldLegacyCodexDrivePetVisual
} from './codexVisiblePresentation'
import {
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser
} from './codexLegacyPresentation'

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

function staleRunning(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return derived({
    lifecycle: 'running',
    turn: 'in_progress',
    connection: 'stale',
    ...partial
  })
}

function slot(partial: Partial<CodexSessionVisualSlot> & Pick<CodexSessionVisualSlot, 'key' | 'candidate'>): CodexSessionVisualSlot {
  return {
    connection: 'connected',
    observedAt: NOW,
    ...partial
  }
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
  if (presentation.petState) expect(presentation.petState).not.toBe('happy')
}

describe('reduceCodexSessionsToGlobalPose', () => {
  it('任意 working 压过 completed_signal', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 'a', candidate: 'working' }),
      slot({ key: 'b', candidate: 'completed_signal' })
    ])
    expect(pose.petState).toBe('thinking')
    expect(pose.reason).toBe('arbitrate_working')
  })

  it('working 压过 completed_with_partial_failure', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 'a', candidate: 'working' }),
      slot({ key: 'b', candidate: 'completed_with_partial_failure' })
    ])
    expect(pose.petState).toBe('thinking')
  })

  it('全是中性终态 → idle，不是 happy', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 'a', candidate: 'completed_signal' }),
      slot({ key: 'b', candidate: 'cancelled' })
    ])
    expect(pose.petState).toBe('idle')
    expect(isCelebratingVisual(pose.petState)).toBe(false)
  })

  it('无 working、有部分失败 → attention', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 'a', candidate: 'completed_signal' }),
      slot({ key: 'b', candidate: 'completed_with_partial_failure' })
    ])
    expect(pose.petState).toBe('attention')
  })

  it('已确认的部分失败不再单独维持 attention', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({
        key: 'a',
        candidate: 'completed_with_partial_failure',
        attentionAcknowledged: true,
        bubblePending: false
      })
    ])
    expect(pose.petState).toBe('idle')
    expect(sessionVisualDriver(slot({
      key: 'a',
      candidate: 'completed_with_partial_failure',
      attentionAcknowledged: true
    }))).toBe('neutral_terminal')
  })

  it('未确认的部分失败即使 stale 仍维持 attention', () => {
    expect(
      sessionVisualDriver(
        slot({
          key: 'a',
          candidate: 'completed_with_partial_failure',
          connection: 'stale'
        })
      )
    ).toBe('completed_with_partial_failure')
  })

  it('stale/unknown 不进入强视觉', () => {
    expect(sessionVisualDriver(slot({ key: 's', candidate: 'working', connection: 'stale' }))).toBe(
      'stale_or_unknown'
    )
    expect(sessionVisualDriver(slot({ key: 'u', candidate: 'unknown' }))).toBe('stale_or_unknown')
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 's', candidate: 'working', connection: 'stale' }),
      slot({ key: 'b', candidate: 'completed_signal' })
    ])
    expect(pose.petState).toBe('idle')
  })

  it('failed/incomplete 不映射到 failed/sad', () => {
    const pose = reduceCodexSessionsToGlobalPose([
      slot({ key: 'a', candidate: 'failed' }),
      slot({ key: 'b', candidate: 'incomplete' })
    ])
    expect(pose.petState).toBeNull()
    expect(pose.reason).toBe('arbitrate_keep_pose')
  })
})

describe('多 session 静默姿态仲裁', () => {
  let gate: CodexSilentVisualGate

  beforeEach(() => {
    gate = new CodexSilentVisualGate()
  })

  it('默认开关关闭，且关闭时不仲裁', () => {
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    const planned = planCodexSilentVisual(gate, {
      enabled: false,
      derived: working({ sessionId: 'sess-1' }),
      fileAlias: 'file-1'
    })
    expect(planned.applied).toBe(false)
    expect(planned.presentation.reason).toBe('codex_candidate_visual_disabled')
    expect(gate.snapshotSessions()).toHaveLength(0)
  })

  it('Session A working，Session B completed_signal → 全局 thinking', () => {
    const a = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW }),
      fileAlias: 'file-a'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 10 }),
      fileAlias: 'file-b'
    })
    expect(a.applied).toBe(true)
    expect(a.presentation.petState).toBe('thinking')
    expect(b.applied).toBe(false)
    expect(b.presentation.petState).toBe('thinking')
    expect(b.presentation.petState).not.toBe('idle')
    assertSilent(a.presentation)
    assertSilent(b.presentation)
  })

  it('Session A completed_signal，Session B working → 全局 thinking', () => {
    const a = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta', observedAt: NOW }),
      fileAlias: 'file-a'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 10 }),
      fileAlias: 'file-b'
    })
    expect(a.presentation.petState).toBe('idle')
    expect(b.applied).toBe(true)
    expect(b.presentation.petState).toBe('thinking')
  })

  it('Session A working，Session B completed_with_partial_failure → 全局 thinking', () => {
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(b.applied).toBe(false)
    expect(b.presentation.petState).toBe('thinking')
    expect(b.presentation.petState).not.toBe('attention')
  })

  it('两个 session 都 completed_signal → 全局 idle', () => {
    const a = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(a.applied).toBe(true)
    expect(a.presentation.petState).toBe('idle')
    expect(b.applied).toBe(false)
    expect(b.presentation.petState).toBe('idle')
    expect(isCelebratingVisual(a.presentation.petState)).toBe(false)
  })

  it('一个部分失败、另一个已结束 → 全局 attention', () => {
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const b = planCodexSilentVisual(gate, {
      enabled: true,
      derived: partialFailure({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(b.applied).toBe(true)
    expect(b.presentation.petState).toBe('attention')
    assertSilent(b.presentation)
  })

  it('一个 session stale，另一个 working → 全局 thinking', () => {
    const workingPlan = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const stale = planCodexSilentVisual(gate, {
      enabled: true,
      derived: staleRunning({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(workingPlan.presentation.petState).toBe('thinking')
    expect(stale.applied).toBe(false)
    expect(stale.presentation.petState).toBeNull()
    expect(gate.snapshotSessions()).toHaveLength(2)
  })

  it('一个 session stale，另一个 completed_signal → stale 不抢占', () => {
    const done = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'ta' }),
      fileAlias: 'file-a'
    })
    const stale = planCodexSilentVisual(gate, {
      enabled: true,
      derived: staleRunning({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 5 }),
      fileAlias: 'file-b'
    })
    expect(done.presentation.petState).toBe('idle')
    expect(stale.applied).toBe(false)
    expect(stale.presentation.petState).not.toBe('failed')
    expect(stale.presentation.petState).not.toBe('happy')
    assertSilent(stale.presentation)
  })

  it('一个 session 的旧 turn completed_signal 不能覆盖另一个 session 的新 turn working', () => {
    const live = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-new', turnId: 'new', observedAt: NOW + 50 }),
      fileAlias: 'file-new'
    })
    const old = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-old', turnId: 'old', observedAt: NOW + 10 }),
      fileAlias: 'file-old'
    })
    expect(live.presentation.petState).toBe('thinking')
    expect(old.applied).toBe(false)
    expect(old.presentation.petState).toBe('thinking')
  })

  it('同一 session 新 turn working 可再进入 thinking，旧终态不再主导', () => {
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-a', turnId: 'old', observedAt: NOW }),
      fileAlias: 'file-a'
    })
    const next = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 'new', observedAt: NOW + 20 }),
      fileAlias: 'file-a'
    })
    expect(next.applied).toBe(true)
    expect(next.presentation.petState).toBe('thinking')
    expect(gate.snapshotSessions()).toHaveLength(1)
    expect(gate.snapshotSessions()[0]?.turnId).toBe('new')
    expect(gate.snapshotSessions()[0]?.candidate).toBe('working')
  })

  it('priming 历史 session 不参与仲裁', () => {
    const priming = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-hist', turnId: 'th' }),
      fileAlias: 'file-hist',
      live: false
    })
    expect(priming.applied).toBe(false)
    expect(priming.presentation.reason).toBe('priming_not_arbitrated')
    expect(gate.snapshotSessions()).toEqual([])
    const live = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-live', turnId: 'tl', observedAt: NOW + 1 }),
      fileAlias: 'file-live'
    })
    expect(live.applied).toBe(true)
    expect(live.presentation.petState).toBe('idle')
  })

  it('重复 candidate 不重复切姿态', () => {
    const first = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 't1' }),
      fileAlias: 'file-a'
    })
    const second = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a', turnId: 't1', observedAt: NOW + 3 }),
      fileAlias: 'file-a'
    })
    const otherWorking = planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-b', turnId: 't2', observedAt: NOW + 4 }),
      fileAlias: 'file-b'
    })
    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(otherWorking.applied).toBe(false)
    expect(otherWorking.presentation.petState).toBe('thinking')
  })

  it('Codex 多 session 不影响 Claude/Cursor/Grok', () => {
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: working({ sessionId: 'sess-a' }),
      fileAlias: 'file-a'
    })
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', observedAt: NOW + 1 }),
      fileAlias: 'file-b'
    })
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'working' })).toBe(true)
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
    const rejected = planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-x', observedAt: NOW + 2 }),
      fileAlias: 'file-x',
      source: 'claude'
    })
    expect(rejected.applied).toBe(false)
    expect(rejected.presentation.reason).toBe('non_codex_ignored')
  })

  it('不弹气泡、不播放声音、shouldNotify=false', () => {
    const events = [
      planCodexSilentVisual(gate, {
        enabled: true,
        derived: working({ sessionId: 'sess-a', turnId: 't1' }),
        fileAlias: 'file-a'
      }),
      planCodexSilentVisual(gate, {
        enabled: true,
        derived: partialFailure({ sessionId: 'sess-b', turnId: 't2', observedAt: NOW + 1 }),
        fileAlias: 'file-b'
      }),
      planCodexSilentVisual(gate, {
        enabled: true,
        derived: completedSignal({ sessionId: 'sess-c', turnId: 't3', observedAt: NOW + 2 }),
        fileAlias: 'file-c'
      })
    ]
    for (const planned of events) {
      expect(planned.candidate.shouldNotify).toBe(false)
      assertSilent(planned.presentation)
    }
  })

  it('缺失 turnId 不得猜造，session 状态不得串线', () => {
    const a = working({ sessionId: 'sess-a' })
    expect(a.turnId).toBeUndefined()
    planCodexSilentVisual(gate, { enabled: true, derived: a, fileAlias: 'file-a' })
    planCodexSilentVisual(gate, {
      enabled: true,
      derived: completedSignal({ sessionId: 'sess-b', turnId: 'tb', observedAt: NOW + 1 }),
      fileAlias: 'file-b'
    })
    const slots = gate.snapshotSessions()
    const slotA = slots.find((s) => s.fileAlias === 'file-a')
    const slotB = slots.find((s) => s.fileAlias === 'file-b')
    expect(slotA?.turnId).toBeUndefined()
    expect(slotA?.candidate).toBe('working')
    expect(slotB?.candidate).toBe('completed_signal')
    expect(slotA?.sessionId).toBe('sess-a')
    expect(slotB?.sessionId).toBe('sess-b')
  })
})
