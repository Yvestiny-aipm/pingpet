import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexDerivedState, CodexNormalizedEventType, CodexObservationEvent } from '@shared/types'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import {
  appendCodexCandidateDiagnostic,
  formatCodexCandidateDiagnostic,
  resetCodexDiagnosticDedupForTests
} from './codexShadowLog'
import { CodexStateDetector, emptyCodexDerivedState } from './codexState'

const NOW = 1_700_000_000_000
let seq = 0

function official(
  eventType: CodexNormalizedEventType,
  extra: Partial<CodexObservationEvent> = {}
): CodexObservationEvent {
  seq += 1
  return {
    source: 'exec_json',
    eventType,
    observedAt: NOW + seq,
    payload: extra.payload ?? { type: eventType },
    recognized: true,
    recognition: 'recognized',
    evidenceOrigin: 'codex_exec_json',
    dedupKey: extra.dedupKey ?? `exec:${eventType}:${seq}`,
    rawType: extra.rawType ?? eventType,
    ...extra
  }
}

function derived(partial: Partial<CodexDerivedState>): CodexDerivedState {
  return { ...emptyCodexDerivedState(NOW), confidence: 'high', ...partial }
}

afterEach(() => {
  resetCodexDiagnosticDedupForTests()
})

describe('候选用户状态映射', () => {
  it('running → candidate working', () => {
    const c = mapCodexDerivedToCandidate(derived({ lifecycle: 'running', turn: 'in_progress', item: 'running' }))
    expect(c.candidate).toBe('working')
    expect(c.legacyEquivalent).toBe('working')
    expect(c.candidatePetState).toBe('working')
    expect(c.notificationCandidate).toBe('none')
    expect(c.shouldNotify).toBe(false)
    expect(c.requiresUserAction).toBe(false)
    expect(c.retryRecommendation).toBe('none')
  })

  it('running + tool_failed → working_with_attention 语义，不是 failed', () => {
    const c = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'running', cause: 'tool_failed', item: 'failed', outputIntegrity: 'partial' })
    )
    expect(c.candidate).toBe('working')
    expect(c.candidate).not.toBe('failed')
    expect(c.legacyEquivalent).toBe('working')
    expect(c.candidatePetState).toBe('cautious')
    expect(c.notificationCandidate).toBe('none')
    expect(c.shouldNotify).toBe(false)
    expect(c.requiresUserAction).toBe(false)
    expect(c.retryRecommendation).toBe('unknown')
    expect(c.reasonCodes).toContain('running_with_item_failure')
    expect(c.reasonCodes).toContain('working_with_attention')
  })

  it('running + item=partial_failure → 不得 candidate failed', () => {
    const c = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'running', cause: 'tool_failed', item: 'partial_failure', outputIntegrity: 'partial' })
    )
    expect(c.candidate).toBe('working')
    expect(c.candidate).not.toBe('failed')
    expect(c.legacyEquivalent).not.toBe('failed')
    expect(c.notificationCandidate).toBe('none')
  })

  it('running + item=unknown + outputIntegrity=partial → running_with_unverified_item', () => {
    const c = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'running', item: 'unknown', outputIntegrity: 'partial', cause: 'unknown' })
    )
    expect(c.candidate).toBe('working')
    expect(c.candidatePetState).toBe('cautious')
    expect(c.reasonCodes).toContain('running_with_unverified_item')
    expect(c.notificationCandidate).toBe('none')
  })

  it('completed_signal 无失败 → completed_signal / done 候选，不是任务成功', () => {
    const c = mapCodexDerivedToCandidate(
      derived({
        lifecycle: 'completed_signal',
        turn: 'completed',
        item: 'succeeded',
        taskSemantics: 'not_verified'
      })
    )
    expect(c.candidate).toBe('completed_signal')
    expect(c.legacyEquivalent).toBe('done')
    expect(c.candidatePetState).toBe('celebrating')
    expect(c.notificationCandidate).toBe('candidate_completion')
    expect(c.shouldNotify).toBe(false)
    expect(c.requiresUserAction).toBe(false)
    expect(c.retryRecommendation).toBe('none')
    expect(c.reasonCodes).toContain('task_semantics_not_verified')
    expect(c.reasonCodes).toContain('legacy_done_is_not_task_success')
    expect(c.reasonCodes).toContain('not_succeeded')
    expect(c.candidate).not.toBe('failed')
  })

  it('completed_signal + partial_failure → completed_with_partial_failure / needs_attention', () => {
    const c = mapCodexDerivedToCandidate(
      derived({
        lifecycle: 'completed_signal',
        turn: 'completed',
        item: 'partial_failure',
        cause: 'tool_failed',
        outputIntegrity: 'partial',
        taskSemantics: 'not_verified'
      })
    )
    expect(c.candidate).toBe('completed_with_partial_failure')
    expect(c.legacyEquivalent).toBe('needs_attention')
    expect(c.candidatePetState).toBe('cautious')
    expect(c.notificationCandidate).toBe('candidate_attention')
    expect(c.requiresUserAction).toBe(true)
    expect(c.retryRecommendation).toBe('user_decision')
    expect(c.reasonCodes).toContain('turn_completed_with_item_failure')
    expect(c.reasonCodes).toContain('task_semantics_not_verified')
    expect(c.candidate).not.toBe('completed_signal')
    expect(c.candidate).not.toBe('failed')
  })

  it('cancelled + cause=user_cancelled → cancelled，可标明用户取消', () => {
    const c = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'cancelled', cause: 'user_cancelled', turn: 'interrupted', outputIntegrity: 'partial' })
    )
    expect(c.candidate).toBe('cancelled')
    expect(c.legacyEquivalent).toBe('needs_attention')
    expect(c.candidatePetState).toBe('cautious')
    expect(c.reasonCodes).toContain('user_cancelled')
    expect(c.candidate).not.toBe('failed')
    expect(c.shouldNotify).toBe(false)
  })

  it('cancelled + cause=unknown → cancelled，不得写 user_cancelled', () => {
    const c = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'cancelled', cause: 'unknown', turn: 'interrupted', outputIntegrity: 'partial' })
    )
    expect(c.candidate).toBe('cancelled')
    expect(c.reasonCodes).toContain('protocol_cancelled')
    expect(c.reasonCodes).not.toContain('user_cancelled')
    expect(c.candidate).not.toBe('failed')
  })

  it('incomplete + process_exit → incomplete，不得 cancelled/failed', () => {
    const c = mapCodexDerivedToCandidate(
      derived({
        lifecycle: 'incomplete',
        cause: 'process_exit',
        process: 'exited',
        outputIntegrity: 'partial',
        turn: 'unknown'
      })
    )
    expect(c.candidate).toBe('incomplete')
    expect(c.legacyEquivalent).toBe('needs_attention')
    expect(c.candidate).not.toBe('cancelled')
    expect(c.candidate).not.toBe('failed')
    expect(c.reasonCodes).toContain('process_exit')
    expect(c.requiresUserAction).toBe(true)
    expect(c.retryRecommendation).toBe('unknown')
  })

  it('connection=stale → candidate unknown，保留失败事实，不是 failed/cancelled', () => {
    const c = mapCodexDerivedToCandidate(
      derived({
        lifecycle: 'running',
        connection: 'stale',
        cause: 'tool_failed',
        item: 'partial_failure',
        outputIntegrity: 'partial',
        turn: 'in_progress'
      })
    )
    expect(c.candidate).toBe('unknown')
    expect(c.candidatePetState).toBe('unknown')
    expect(c.reasonCodes).toContain('observation_stale')
    expect(c.reasonCodes).toContain('tool_failed_fact_present_not_turn_failed')
    expect(c.candidate).not.toBe('failed')
    expect(c.candidate).not.toBe('cancelled')
    expect(c.candidate).not.toBe('working')
    expect(c.shouldNotify).toBe(false)
  })

  it('process_exit / 明确终态优先于 observation_stale', () => {
    const incomplete = mapCodexDerivedToCandidate(
      derived({
        lifecycle: 'incomplete',
        cause: 'process_exit',
        process: 'exited',
        connection: 'stale',
        outputIntegrity: 'partial',
        turn: 'unknown'
      })
    )
    expect(incomplete.candidate).toBe('incomplete')
    expect(incomplete.reasonCodes).toContain('process_exit')
    expect(incomplete.reasonCodes).not.toContain('observation_stale')

    const failed = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'failed', cause: 'turn_failed', turn: 'failed', connection: 'stale' })
    )
    expect(failed.candidate).toBe('failed')
    expect(failed.reasonCodes).not.toContain('observation_stale')

    const cancelled = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'cancelled', cause: 'user_cancelled', connection: 'stale' })
    )
    expect(cancelled.candidate).toBe('cancelled')
    expect(cancelled.reasonCodes).not.toContain('observation_stale')
  })

  it('unknown → unknown，不得猜成功', () => {
    const c = mapCodexDerivedToCandidate(derived({ lifecycle: 'unknown' }))
    expect(c.candidate).toBe('unknown')
    expect(c.legacyEquivalent).toBe('unknown')
    expect(c.candidatePetState).toBe('unknown')
    expect(c.notificationCandidate).toBe('candidate_unknown')
    expect(c.reasonCodes).toContain('do_not_infer_outcome')
    expect(c.candidate).not.toBe('completed_signal')
    expect(c.legacyEquivalent).not.toBe('done')
  })

  it('waiting_* → waiting，非终态，不得 failed', () => {
    const input = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'waiting_input', cause: 'waiting_for_input', turn: 'waiting' })
    )
    const approval = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'waiting_approval', cause: 'waiting_for_approval', turn: 'waiting' })
    )
    for (const c of [input, approval]) {
      expect(c.candidate).toBe('waiting')
      expect(c.legacyEquivalent).toBe('needs_attention')
      expect(c.candidatePetState).toBe('waiting')
      expect(c.notificationCandidate).toBe('candidate_attention')
      expect(c.requiresUserAction).toBe(true)
      expect(c.retryRecommendation).toBe('user_decision')
      expect(c.reasonCodes).toContain('non_terminal')
      expect(c.candidate).not.toBe('failed')
    }
  })

  it('明确 turn 级失败才是 candidate failed；item/process 失败不得进入', () => {
    const turnFail = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'failed', cause: 'turn_failed', turn: 'failed' })
    )
    expect(turnFail.candidate).toBe('failed')
    expect(turnFail.legacyEquivalent).toBe('failed')
    expect(turnFail.candidatePetState).toBe('sad')

    const disguised = mapCodexDerivedToCandidate(
      derived({ lifecycle: 'failed', cause: 'tool_failed', item: 'failed', turn: 'in_progress' })
    )
    expect(disguised.candidate).not.toBe('failed')
    expect(disguised.candidate).toBe('unknown')
  })

  it('精确工具失败序列映射 completed_with_partial_failure，shouldNotify=false', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemKind: 'error' }))
    d.apply(official('item.completed', { itemKind: 'agent_message' }))
    d.apply(official('item.started', { itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemKind: 'command_execution', itemStatus: 'failed' }))
    d.apply(official('item.completed', { itemKind: 'agent_message' }))
    d.apply(official('turn.completed'))
    const st = d.getState()
    expect(st.lifecycle).toBe('completed_signal')
    expect(st.cause).toBe('tool_failed')
    expect(st.item).toBe('partial_failure')
    expect(st.outputIntegrity).toBe('partial')
    expect(st.retryability).toBe('unknown')
    expect(st.taskSemantics).toBe('not_verified')
    const c = mapCodexDerivedToCandidate(st)
    expect(c.candidate).toBe('completed_with_partial_failure')
    expect(c.shouldNotify).toBe(false)
    expect(c.candidate).not.toBe('failed')
    expect(c.reasonCodes).toContain('not_succeeded')
    expect(c.reasonCodes.join(',')).not.toMatch(/(?<!not_)succeeded/)
  })

  it('新 turn 后上一轮 partial_failure 不污染当前 turn 候选', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemStatus: 'failed', itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemKind: 'agent_message' }))
    const prev = mapCodexDerivedToCandidate(d.getState())
    expect(prev.candidate).toBe('working')
    expect(prev.candidatePetState).toBe('cautious')

    d.apply(official('turn.completed'))
    const completed = mapCodexDerivedToCandidate(d.getState())
    expect(completed.candidate).toBe('completed_with_partial_failure')

    d.apply(official('turn.started'))
    const next = mapCodexDerivedToCandidate(d.getState())
    expect(next.candidate).toBe('working')
    expect(next.candidatePetState).toBe('working')
    expect(next.reasonCodes).not.toContain('running_with_item_failure')
    expect(d.getState().item).toBe('none')
    expect(d.getState().cause).not.toBe('tool_failed')
  })

  it('taskSemantics=not_verified 时不得输出真正 succeeded', () => {
    const states: CodexDerivedState[] = [
      derived({ lifecycle: 'running', taskSemantics: 'not_verified' }),
      derived({ lifecycle: 'completed_signal', taskSemantics: 'not_verified', item: 'succeeded' }),
      derived({ lifecycle: 'succeeded', taskSemantics: 'not_verified' })
    ]
    for (const state of states) {
      const c = mapCodexDerivedToCandidate(state)
      expect(c.candidate).not.toBe('failed')
      expect(['working', 'completed_signal', 'unknown']).toContain(c.candidate)
      expect(c.reasonCodes.some((code) => code === 'succeeded' || code.endsWith(':succeeded'))).toBe(false)
      if (state.lifecycle === 'completed_signal') {
        expect(c.reasonCodes).toContain('not_succeeded')
        expect(c.reasonCodes).toContain('task_semantics_not_verified')
      }
      if (state.lifecycle === 'succeeded') {
        expect(c.candidate).toBe('unknown')
        expect(c.reasonCodes).toContain('unexpected_succeeded_lifecycle_not_mapped')
      }
    }
  })
})

describe('候选诊断只写影子，不驱动桌宠', () => {
  it('candidatePetState 只能出现在诊断记录里', () => {
    const petActions: string[] = []
    const state = derived({
      lifecycle: 'completed_signal',
      turn: 'completed',
      sessionId: 'sess-secret',
      threadId: 'th-secret',
      turnId: 'turn-secret'
    })
    const rec = formatCodexCandidateDiagnostic(state, {
      previousState: emptyCodexDerivedState(),
      nextState: state,
      cause: 'unknown',
      evidenceIds: [],
      source: 'exec_json',
      observedAt: NOW,
      eventTime: null,
      confidence: 'high',
      reason: 'fixture'
    })
    expect(rec.candidatePetState).toBe('celebrating')
    expect(rec.shouldNotify).toBe(false)
    expect(rec.userVisible).toBe(false)
    expect(rec.productionVisible).toBe(false)
    expect(rec.observationSource).toBe('exec_json')
    expect(rec.sessionId).not.toBe('sess-secret')
    expect(JSON.stringify(rec)).not.toContain('sess-secret')
    expect(petActions).toEqual([])
  })

  it('重复 migration 不重复写 candidate 诊断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-candidate-dup-'))
    const path = join(dir, 'codex-candidate.jsonl')
    const state = derived({ lifecycle: 'running' })
    const meta = { observationId: 'shadow:dup-1', seq: 1 }
    appendCodexCandidateDiagnostic(state, undefined, path, meta)
    appendCodexCandidateDiagnostic(state, undefined, path, meta)
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('exec_json 与 session_jsonl source 保持区分', () => {
    const execRec = formatCodexCandidateDiagnostic(derived({ lifecycle: 'running' }), {
      previousState: emptyCodexDerivedState(),
      nextState: emptyCodexDerivedState(),
      cause: 'unknown',
      evidenceIds: [],
      source: 'exec_json',
      observedAt: NOW,
      eventTime: null,
      confidence: 'high',
      reason: 'official'
    })
    const sessRec = formatCodexCandidateDiagnostic(derived({ lifecycle: 'running' }), {
      previousState: emptyCodexDerivedState(),
      nextState: emptyCodexDerivedState(),
      cause: 'unknown',
      evidenceIds: [],
      source: 'session_jsonl',
      observedAt: NOW,
      eventTime: null,
      confidence: 'medium',
      reason: 'session'
    })
    expect(execRec.observationSource).toBe('exec_json')
    expect(sessRec.observationSource).toBe('session_jsonl')
    expect(execRec.source).toBe('exec_json')
    expect(sessRec.source).toBe('session_jsonl')
  })

  it('候选诊断写入失败不影响旧 onEvent / 桌宠动作', () => {
    const petActions: string[] = []
    const onEvent = (kind: string) => petActions.push(`pet:${kind}`)
    onEvent('working')
    expect(() =>
      appendCodexCandidateDiagnostic(derived({ lifecycle: 'running' }), undefined, '/dev/cannot-write-here/nope.jsonl', {
        observationId: 'shadow:boom'
      })
    ).not.toThrow()
    expect(petActions).toEqual(['pet:working'])
  })
})
