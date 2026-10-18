import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexNormalizedEventType, CodexObservationEvent, CodexObservationSource } from '@shared/types'
import { CODEX_LIFECYCLE_TERMINALS } from '@shared/types'
import { CodexObservationJournal, parseCodexObservation } from './codexObserve'
import { CodexStateDetector, isCodexLifecycleTerminal, isLocalSessionEvent, isOfficialEvent } from './codexState'

const NOW = 1_700_000_000_000

let seq = 0
function official(
  eventType: CodexNormalizedEventType,
  extra: Partial<CodexObservationEvent> = {}
): CodexObservationEvent {
  seq += 1
  const { source, evidenceOrigin, observedAt, payload, dedupKey, rawType, ...rest } = extra
  return {
    source: source ?? 'exec_json',
    eventType,
    observedAt: observedAt ?? NOW + seq,
    payload: payload ?? { type: eventType },
    recognized: true,
    recognition: 'recognized',
    evidenceOrigin: evidenceOrigin ?? 'codex_exec_json',
    dedupKey: dedupKey ?? `exec:${eventType}:${seq}`,
    rawType: rawType ?? eventType,
    ...rest
  }
}

function local(
  eventType: CodexNormalizedEventType,
  extra: Partial<CodexObservationEvent> = {}
): CodexObservationEvent {
  seq += 1
  const { source, evidenceOrigin, observedAt, payload, dedupKey, rawType, ...rest } = extra
  return {
    source: source ?? 'session_jsonl',
    eventType,
    observedAt: observedAt ?? NOW + seq,
    payload: payload ?? { type: rawType ?? eventType },
    recognized: true,
    recognition: 'recognized',
    evidenceOrigin: evidenceOrigin ?? 'codex_session_jsonl',
    dedupKey: dedupKey ?? `sess:${eventType}:${seq}`,
    rawType,
    ...rest
  }
}

describe('来源区分', () => {
  it('官方事件必须同时满足 source / rawType / evidenceOrigin', () => {
    const ok = official('turn.completed')
    expect(isOfficialEvent(ok)).toBe(true)
    expect(isOfficialEvent({ ...ok, source: 'session_jsonl' as CodexObservationSource })).toBe(false)
    expect(isOfficialEvent({ ...ok, evidenceOrigin: 'codex_session_jsonl' })).toBe(false)
    expect(isOfficialEvent({ ...ok, rawType: 'task_complete' })).toBe(false)
    expect(isOfficialEvent({ ...ok, eventType: 'event_msg.task_complete' })).toBe(false)
    expect(isOfficialEvent(official('turn.cancelled'))).toBe(true)
    expect(isOfficialEvent({ ...official('turn.cancelled'), source: 'session_jsonl' as CodexObservationSource })).toBe(
      false
    )
  })

  it('本地 event_msg 即使名字像官方事件也不算官方', () => {
    const ev = local('event_msg.item_completed', { rawType: 'item_completed', itemStatus: 'failed' })
    expect(isOfficialEvent(ev)).toBe(false)
    expect(isLocalSessionEvent(ev)).toBe(true)
  })
})

describe('基础生命周期', () => {
  it('官方 turn.started → running', () => {
    const d = new CodexStateDetector()
    const r = d.apply(official('turn.started', { threadId: 'th' }))
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.turn).toBe('in_progress')
    expect(r.state.confidence).toBe('high')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.migration?.reason).toContain('official turn.started')
  })

  it('本地 task_started → running，但保留本地来源和中等可信度', () => {
    const d = new CodexStateDetector()
    const r = d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.confidence).toBe('medium')
    expect(r.state.evidence[0]?.source).toBe('session_jsonl')
    expect(r.state.evidence[0]?.rawType).toBe('task_started')
    expect(r.migration?.reason).toContain('session JSONL')
    expect(r.migration?.reason).toContain('not an official exec event')
  })

  it('官方 turn.completed → completed_signal，不得 succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.turn).toBe('completed')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.state.taskSemantics).not.toBe('completed')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.migration?.reason).toContain('not succeeded')
    expect(r.migration?.reason).toContain('task semantics and retryability are not verified')
  })

  it('本地 task_complete → completed_signal，不得 succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    const r = d.apply(local('event_msg.task_complete', { rawType: 'task_complete', turnId: 't1' }))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.confidence).toBe('medium')
    expect(r.state.evidence[0]?.eventType).toBe('event_msg.task_complete')
  })

  it('官方 turn.failed → failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('turn.failed', { payload: { type: 'turn.failed', error: { message: 'boom' } } }))
    expect(r.state.lifecycle).toBe('failed')
    expect(r.state.cause).toBe('turn_failed')
    expect(r.state.turn).toBe('failed')
  })

  it('官方 turn.cancelled → cancelled，无明确用户原因时不得猜 user_cancelled', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('turn.cancelled'))
    expect(r.state.lifecycle).toBe('cancelled')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.turn).toBe('interrupted')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.cause).not.toBe('user_cancelled')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.outputIntegrity).not.toBe('complete')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.migration?.reason).toContain('official turn.cancelled')
    expect(r.migration?.reason).toContain('not failed')
  })

  it('官方 turn.cancelled 带明确用户取消原因 → cause=user_cancelled', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(
      official('turn.cancelled', {
        payload: { type: 'turn.cancelled', reason: 'cancelled by user' }
      })
    )
    expect(r.state.lifecycle).toBe('cancelled')
    expect(r.state.cause).toBe('user_cancelled')
    expect(r.state.retryability).toBe('user_action')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.state.lifecycle).not.toBe('failed')
  })

  it('官方 turn.cancelled 原因不明确时保持 cause=unknown', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(
      official('turn.cancelled', {
        payload: { type: 'turn.cancelled', reason: 'interrupted' }
      })
    )
    expect(r.state.lifecycle).toBe('cancelled')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.cause).not.toBe('user_cancelled')
    expect(r.state.retryability).toBe('unknown')
  })
})

describe('item 失败与 turn 失败分开', () => {
  it('item failed 后 lifecycle 保持 running，cause=tool_failed，item=failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const fail = d.apply(
      official('item.completed', { itemId: 'i1', itemStatus: 'failed', itemKind: 'command_execution' })
    )
    expect(fail.state.lifecycle).toBe('running')
    expect(fail.state.cause).toBe('tool_failed')
    expect(fail.state.item).toBe('failed')
    expect(fail.state.turn).toBe('in_progress')
    expect(fail.state.outputIntegrity).toBe('partial')
    expect(fail.state.lifecycle).not.toBe('incomplete')
    expect(fail.state.lifecycle).not.toBe('failed')
  })

  it('item failed 后收到新的 item.started，仍为 running，item 表达 partial_failure', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    const cont = d.apply(official('item.started', { itemId: 'i2' }))
    expect(cont.state.lifecycle).toBe('running')
    expect(cont.state.item).toBe('partial_failure')
    expect(cont.state.cause).toBe('tool_failed')
    expect(cont.state.outputIntegrity).toBe('partial')
    expect(cont.state.turn).toBe('in_progress')
    expect(cont.state.lifecycle).not.toBe('incomplete')
    expect(cont.state.lifecycle).not.toBe('failed')
  })

  it('本地 item_completed failed 且没有 turn 终态时仍是 running，不是 incomplete/failed', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    const r = d.apply(
      local('event_msg.item_completed', {
        rawType: 'item_completed',
        itemId: 'exec-1',
        itemStatus: 'failed',
        itemKind: 'CommandExecution',
        turnId: 't1'
      })
    )
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.cause).toBe('tool_failed')
    expect(r.state.item).toBe('failed')
    expect(r.state.turn).toBe('in_progress')
    expect(r.state.lifecycle).not.toBe('incomplete')
    expect(r.state.lifecycle).not.toBe('failed')
  })

  it('item failed 后收到 turn.completed → completed_signal，不能变成 failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.item).toBe('failed')
    expect(r.state.cause).toBe('tool_failed')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.lifecycle).not.toBe('incomplete')
    expect(r.state.lifecycle).not.toBe('succeeded')
  })

  it('没有 turn 终态且明确 finalize 时才进入 incomplete', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    expect(d.getState().lifecycle).toBe('running')
    const ended = d.finalizeIncomplete(NOW + 80, 'observation_ended_without_turn_terminal')
    expect(ended.applied).toBe(true)
    expect(ended.state.lifecycle).toBe('incomplete')
    expect(ended.state.turn).not.toBe('in_progress')
    expect(ended.state.outputIntegrity).toBe('partial')
    expect(isCodexLifecycleTerminal(ended.state.lifecycle)).toBe(true)
    const again = d.finalizeIncomplete(NOW + 81, 'output_truncated')
    expect(again.applied).toBe(false)
    expect(again.state.lifecycle).toBe('incomplete')
  })

  it('进程异常退出且 turn 仍打开 → incomplete；正常退出不改生命周期', () => {
    const abnormal = new CodexStateDetector()
    abnormal.apply(official('turn.started'))
    const crash = abnormal.applyProcess({ status: 'exited', exitCode: 139, observedAt: NOW + 90 })
    expect(crash.state.lifecycle).toBe('incomplete')
    expect(crash.state.cause).toBe('process_exit')
    expect(crash.state.process).toBe('exited')
    expect(crash.state.turn).not.toBe('in_progress')

    const normal = new CodexStateDetector()
    normal.apply(official('turn.started'))
    const ok = normal.applyProcess({ status: 'exited', exitCode: 0, observedAt: NOW + 91 })
    expect(ok.state.lifecycle).toBe('running')
    expect(ok.state.process).toBe('exited')
    expect(ok.state.lifecycle).not.toBe('incomplete')
  })

  it('incomplete 是终态，与 CODEX_LIFECYCLE_TERMINALS 一致', () => {
    expect(CODEX_LIFECYCLE_TERMINALS).toContain('incomplete')
    expect(isCodexLifecycleTerminal('incomplete')).toBe(true)
    expect(isCodexLifecycleTerminal('running')).toBe(false)
    expect(isCodexLifecycleTerminal('unknown')).toBe(false)
    expect(isCodexLifecycleTerminal('waiting_input')).toBe(false)
  })
})

describe('跨 turn 的 item 状态隔离', () => {
  it('turn 1 item failed 完成后，turn 2 的第一个 item.started 不得是 partial_failure', () => {
    const d = new CodexStateDetector()
    d.apply(official('thread.started', { threadId: 'th-1', sessionId: 'sess-1' }))
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    const done = d.apply(official('turn.completed'))
    expect(done.state.lifecycle).toBe('completed_signal')
    expect(done.state.item).toBe('failed')

    d.applyProcess({ status: 'alive', observedAt: NOW + 70 })
    const turn2 = d.apply(official('turn.started'))
    expect(turn2.state.lifecycle).toBe('running')
    expect(turn2.state.item).toBe('none')
    expect(turn2.state.item).not.toBe('failed')
    expect(turn2.state.item).not.toBe('partial_failure')
    expect(turn2.state.cause).toBe('unknown')
    expect(turn2.state.cause).not.toBe('tool_failed')
    expect(turn2.state.outputIntegrity).toBe('unknown')
    expect(turn2.state.turnId).toBeUndefined()
    expect(turn2.state.sessionId).toBe('sess-1')
    expect(turn2.state.threadId).toBe('th-1')
    expect(turn2.state.process).toBe('alive')
    expect(turn2.migration?.previousState.item).toBe('failed')
    expect(turn2.migration?.previousState.lifecycle).toBe('completed_signal')

    const item2 = d.apply(official('item.started', { itemId: 'i2' }))
    expect(item2.state.lifecycle).toBe('running')
    expect(item2.state.item).toBe('running')
    expect(item2.state.item).not.toBe('partial_failure')
    expect(item2.state.cause).not.toBe('tool_failed')

    const history = d.getMigrations()
    expect(history.some((m) => m.nextState.item === 'failed' && m.cause === 'tool_failed')).toBe(true)
    expect(history.some((m) => m.previousState.item === 'failed')).toBe(true)
    expect(history.length).toBeGreaterThan(4)
  })

  it('官方 turn.started 没有 turnId 也按事件边界重置', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 'legacy-turn' }))
    d.apply(
      local('event_msg.item_completed', {
        rawType: 'item_completed',
        itemId: 'old',
        itemStatus: 'failed',
        turnId: 'legacy-turn'
      })
    )
    expect(d.getState().turnId).toBe('legacy-turn')
    expect(d.getState().item).toBe('failed')

    const next = d.apply(official('turn.started'))
    expect(next.state.turnId).toBeUndefined()
    expect(next.state.item).toBe('none')
    expect(next.state.lifecycle).toBe('running')

    const first = d.apply(official('item.completed', { itemId: 'fresh', itemStatus: 'completed' }))
    expect(first.state.item).toBe('succeeded')
    expect(first.state.item).not.toBe('partial_failure')
  })

  it('本地 task_started 也会重置 item 失败累计，并保留 session / process / migrations', () => {
    const d = new CodexStateDetector()
    d.apply(
      local('event_msg.task_started', {
        rawType: 'task_started',
        turnId: 't1',
        sessionId: 'sess-local',
        threadId: 'th-local'
      })
    )
    d.apply(
      local('event_msg.item_completed', {
        rawType: 'item_completed',
        itemId: 'exec-1',
        itemStatus: 'failed',
        turnId: 't1'
      })
    )
    d.applyProcess({ status: 'alive', observedAt: NOW + 120 })
    d.apply(local('event_msg.task_complete', { rawType: 'task_complete', turnId: 't1' }))

    const turn2 = d.apply(
      local('event_msg.task_started', {
        rawType: 'task_started',
        turnId: 't2',
        sessionId: 'sess-local',
        threadId: 'th-local'
      })
    )
    expect(turn2.state.lifecycle).toBe('running')
    expect(turn2.state.item).toBe('none')
    expect(turn2.state.turnId).toBe('t2')
    expect(turn2.state.sessionId).toBe('sess-local')
    expect(turn2.state.threadId).toBe('th-local')
    expect(turn2.state.process).toBe('alive')
    expect(turn2.migration?.previousState.item).toBe('failed')

    const item2 = d.apply(
      local('event_msg.item_started', { rawType: 'item_started', turnId: 't2', itemId: 'exec-2' })
    )
    expect(item2.state.lifecycle).toBe('running')
    expect(item2.state.item).toBe('running')
    expect(item2.state.item).not.toBe('partial_failure')

    expect(d.getMigrations().some((m) => m.nextState.item === 'failed' && m.cause === 'tool_failed')).toBe(true)
  })
})

describe('取消、error、等待', () => {
  it('明确用户取消 → cancelled', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    const r = d.apply(
      local('event_msg.turn_aborted', {
        rawType: 'turn_aborted',
        turnId: 't1',
        payload: { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'stopped by user' } }
      })
    )
    expect(r.state.lifecycle).toBe('cancelled')
    expect(r.state.cause).toBe('user_cancelled')
    expect(r.state.turn).toBe('interrupted')
  })

  it('不明确的 turn_aborted → unknown，保留原始原因', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    const r = d.apply(
      local('event_msg.turn_aborted', {
        rawType: 'turn_aborted',
        turnId: 't1',
        payload: { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
      })
    )
    expect(r.state.lifecycle).toBe('unknown')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.lifecycle).not.toBe('cancelled')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.migration?.reason).toContain('interrupted')
    expect(r.state.evidence[0]?.eventType).toBe('event_msg.turn_aborted')
    expect(r.state.evidence[0]?.eventType).not.toBe('turn.cancelled')
    expect(r.state.evidence[0]?.source).toBe('session_jsonl')
    expect(isOfficialEvent(local('event_msg.turn_aborted', { rawType: 'turn_aborted' }))).toBe(false)
  })

  it('error 无终态 → unknown，不得 failed/succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('error', { payload: { type: 'error', message: 'unauthorized' } }))
    expect(r.state.lifecycle).toBe('unknown')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.cause).toBe('unknown')
  })

  it('error 后收到 turn.completed → completed_signal', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('error', { payload: { type: 'error', message: 'blip' } }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.lifecycle).not.toBe('failed')
  })

  it('无明确结构化证据时不进入 waiting', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.updated', { itemId: 'i1' }))
    d.apply(local('event_msg.other', { rawType: 'token_count' }))
    d.apply(local('response_item', { rawType: 'response_item' }))
    expect(d.getState().lifecycle).not.toBe('waiting_input')
    expect(d.getState().lifecycle).not.toBe('waiting_approval')
  })
})

describe('冲突、乱序、重复、失联、进程', () => {
  it('重复事件不重复产生迁移', () => {
    const d = new CodexStateDetector()
    const ev = official('turn.started', { dedupKey: 'same-key' })
    const first = d.apply(ev)
    const second = d.apply({ ...ev })
    expect(first.reason).toBe('migrated')
    expect(second.applied).toBe(false)
    expect(second.reason).toBe('duplicate')
    expect(d.getMigrations()).toHaveLength(1)
  })

  it('乱序：先 completed 再 started，按到达顺序迁移到 running', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.completed'))
    const r = d.apply(official('turn.started'))
    expect(d.getMigrations().map((m) => m.nextState.lifecycle)).toEqual(['completed_signal', 'running'])
    expect(r.state.lifecycle).toBe('running')
  })

  it('官方 turn.failed 与本地 task_complete 冲突时保留更高可信度的 failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('turn.failed'))
    const r = d.apply(local('event_msg.task_complete', { rawType: 'task_complete', turnId: 't1' }))
    expect(r.reason).toBe('conflict_ignored')
    expect(r.state.lifecycle).toBe('failed')
    expect(r.state.lifecycle).not.toBe('completed_signal')
    expect(r.state.conflicts[0]?.reason).toContain('lower-confidence')
    expect(r.migration?.reason).toContain('kept failed')
    expect(r.migration?.evidenceIds.length).toBeGreaterThan(0)
  })

  it('turn.completed 后又收到新的 running 事件 → running', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('turn.completed'))
    const r = d.apply(official('turn.started', { threadId: 'th2' }))
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.turn).toBe('in_progress')
  })

  it('不明确 turn_aborted 与进程正常退出同时出现，不得变成 cancelled/failed/succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }))
    d.apply(
      local('event_msg.turn_aborted', {
        rawType: 'turn_aborted',
        payload: { payload: { type: 'turn_aborted', reason: 'interrupted' } }
      })
    )
    const r = d.applyProcess({ status: 'exited', exitCode: 0, observedAt: NOW + 99 })
    expect(r.state.lifecycle).toBe('unknown')
    expect(r.state.process).toBe('exited')
    expect(r.state.lifecycle).not.toBe('cancelled')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.migration?.reason).toContain('does not override lifecycle')
  })

  it('缺少 turnId / itemId 的事件仍可迁移', () => {
    const d = new CodexStateDetector()
    const r = d.apply(official('turn.started'))
    expect(r.state.turnId).toBeUndefined()
    expect(r.state.lifecycle).toBe('running')
    const done = d.apply(official('turn.completed'))
    expect(done.state.lifecycle).toBe('completed_signal')
  })

  it('观察端断线不覆盖最后已知状态，也不得变 failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.markConnection('disconnected', NOW + 50)
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.connection).toBe('disconnected')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.migration?.reason).toContain('lifecycle stays running')
    const stale = d.markConnection('stale', NOW + 51)
    expect(stale.state.lifecycle).toBe('running')
    expect(stale.state.connection).toBe('stale')
  })

  it('observation stale 只改 connection，保留 tool_failed，不得 process_exit', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    const stale = d.markObservationStale(NOW + 80)
    expect(stale.applied).toBe(true)
    expect(stale.state.lifecycle).toBe('running')
    expect(stale.state.connection).toBe('stale')
    expect(stale.state.cause).toBe('tool_failed')
    expect(stale.state.item).toBe('failed')
    expect(stale.state.outputIntegrity).toBe('partial')
    expect(stale.state.process).toBe('not_observed')
    expect(stale.state.cause).not.toBe('process_exit')
    expect(stale.state.lifecycle).not.toBe('failed')
    expect(stale.state.lifecycle).not.toBe('cancelled')
    expect(stale.migration?.reason).toContain('observation_stale')
    expect(d.markObservationStale(NOW + 81).applied).toBe(false)
  })

  it('明确终态和 process_exit 之后不得再标 observation stale', () => {
    const completed = new CodexStateDetector()
    completed.apply(official('turn.started'))
    completed.apply(official('turn.completed'))
    expect(completed.markObservationStale(NOW + 90).applied).toBe(false)
    expect(completed.getState().connection).not.toBe('stale')

    const failed = new CodexStateDetector()
    failed.apply(official('turn.started'))
    failed.apply(official('turn.failed'))
    expect(failed.markObservationStale(NOW + 91).applied).toBe(false)
    expect(failed.getState().lifecycle).toBe('failed')

    const cancelled = new CodexStateDetector()
    cancelled.apply(official('turn.started'))
    cancelled.apply(official('turn.cancelled'))
    expect(cancelled.markObservationStale(NOW + 92).applied).toBe(false)
    expect(cancelled.getState().lifecycle).toBe('cancelled')

    const exited = new CodexStateDetector()
    exited.apply(official('turn.started'))
    exited.applyProcess({ status: 'exited', exitCode: 1, observedAt: NOW + 93 })
    expect(exited.getState().cause).toBe('process_exit')
    expect(exited.markObservationStale(NOW + 94).applied).toBe(false)
    expect(exited.getState().lifecycle).toBe('incomplete')
    expect(exited.getState().connection).not.toBe('stale')
  })

  it('stale 之后新事件恢复 connected，并带 observation_recovered', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.markObservationStale(NOW + 70)
    const recovered = d.apply(official('item.started', { itemId: 'i2' }))
    expect(recovered.state.connection).toBe('connected')
    expect(recovered.state.lifecycle).toBe('running')
    expect(recovered.migration?.reason).toContain('observation_recovered')
  })

  it('迁移证据完整保存 previous/next/cause/evidenceIds/source/observedAt/confidence/reason', () => {
    const d = new CodexStateDetector()
    const ev = official('turn.started', { threadId: 'th' })
    const r = d.apply(ev)
    const m = r.migration
    expect(m).toBeTruthy()
    expect(m?.previousState.lifecycle).toBe('unknown')
    expect(m?.nextState.lifecycle).toBe('running')
    expect(m?.cause).toBe('unknown')
    expect(m?.evidenceIds).toEqual([r.state.evidence[0]?.id])
    expect(m?.source).toBe('exec_json')
    expect(m?.observedAt).toBe(ev.observedAt)
    expect(m?.confidence).toBe('high')
    expect(m?.reason.length).toBeGreaterThan(0)
    expect(m?.eventDedupKey).toBe(ev.dedupKey)
    expect(m?.eventTime).toBeNull()
    expect(m?.observedAt).toBe(ev.observedAt)
  })

  it('eventTime 与 observedAt 分离，缺失时不为 observedAt', () => {
    const d = new CodexStateDetector()
    const eventTime = NOW - 12_000
    const observedAt = NOW + 80
    const r = d.apply(official('turn.started', { threadId: 'th', eventTime, observedAt }))
    expect(r.migration?.eventTime).toBe(eventTime)
    expect(r.migration?.observedAt).toBe(observedAt)
    expect(r.migration?.eventTime).not.toBe(r.migration?.observedAt)
    const missing = d.apply(official('turn.completed', { observedAt: observedAt + 1 }))
    expect(missing.migration?.eventTime).toBeNull()
    expect(missing.migration?.observedAt).toBe(observedAt + 1)
  })
})

describe('item.completed 边界：error / 未知 type / agent_message', () => {
  it('官方 item.completed + item.type=error + status 缺失：不得猜 succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('item.completed', { itemId: 'item-error', itemKind: 'error' }))
    expect(r.state.item).toBe('unknown')
    expect(r.state.item).not.toBe('succeeded')
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.confidence).toBe('medium')
    expect(r.state.confidence).not.toBe('high')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.migration?.reason).toContain(
      'item.completed with item.type=error but status missing; do not infer success'
    )
  })

  it('error item 后收到 turn.completed：completed_signal，不升格 succeeded/failed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'item-error', itemKind: 'error' }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.turn).toBe('completed')
    expect(r.state.item).toBe('unknown')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.outputIntegrity).not.toBe('complete')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.state.taskSemantics).toBe('not_verified')
  })

  it('官方 item.completed + status=failed：item=failed，lifecycle 仍 running', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(
      official('item.completed', { itemId: 'i1', itemStatus: 'failed', itemKind: 'command_execution' })
    )
    expect(r.state.item).toBe('failed')
    expect(r.state.cause).toBe('tool_failed')
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.lifecycle).not.toBe('failed')
    expect(r.state.lifecycle).not.toBe('incomplete')
  })

  it('官方 item.completed + status=declined：item=declined，lifecycle 仍 running', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(
      official('item.completed', { itemId: 'i1', itemStatus: 'declined', itemKind: 'command_execution' })
    )
    expect(r.state.item).toBe('declined')
    expect(r.state.cause).toBe('tool_failed')
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.lifecycle).not.toBe('failed')
  })

  it('官方 item.completed + item.type=agent_message + status 缺失：item 可完成，任务语义仍未验证', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('item.completed', { itemId: 'item-msg', itemKind: 'agent_message' }))
    expect(r.state.item).toBe('succeeded')
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.lifecycle).not.toBe('succeeded')
    expect(r.state.taskSemantics).toBe('not_verified')
  })

  it('未知 item.type + status 缺失：item=unknown，不得猜 succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const r = d.apply(official('item.completed', { itemId: 'item-x', itemKind: 'future_widget' }))
    expect(r.state.item).toBe('unknown')
    expect(r.state.item).not.toBe('succeeded')
    expect(r.state.lifecycle).toBe('running')
    expect(r.state.confidence).not.toBe('high')
    expect(r.state.taskSemantics).toBe('not_verified')
  })

  it('本地 event_msg.item_completed 与官方 item.completed 判断规则一致', () => {
    const compare = (officialEv: CodexObservationEvent, localEv: CodexObservationEvent) => {
      const a = new CodexStateDetector()
      const b = new CodexStateDetector()
      a.apply(official('turn.started'))
      b.apply(local('event_msg.task_started', { rawType: 'task_started' }))
      const oa = a.apply(officialEv).state
      const ob = b.apply(localEv).state
      expect(ob.item).toBe(oa.item)
      expect(ob.cause).toBe(oa.cause)
      expect(ob.lifecycle).toBe(oa.lifecycle)
      expect(ob.taskSemantics).toBe('not_verified')
    }
    compare(
      official('item.completed', { itemKind: 'error' }),
      local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'error' })
    )
    compare(
      official('item.completed', { itemStatus: 'failed', itemKind: 'command_execution' }),
      local('event_msg.item_completed', {
        rawType: 'item_completed',
        itemStatus: 'failed',
        itemKind: 'CommandExecution'
      })
    )
    compare(
      official('item.completed', { itemStatus: 'declined' }),
      local('event_msg.item_completed', { rawType: 'item_completed', itemStatus: 'rejected' })
    )
    compare(
      official('item.completed', { itemKind: 'agent_message' }),
      local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'AgentMessage' })
    )
    compare(
      official('item.completed', { itemKind: 'future_widget' }),
      local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'future_widget' })
    )
  })

  it('真实 exec 脱敏形状：error item 后 agent_message 再 turn.completed，不猜成功也不升格失败', () => {
    // 这是从真实样本抽出的脱敏形状，不代表完整协议覆盖。
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      readFileSync(join(__dirname, 'fixtures/codex/exec-item-error-no-status.redacted.jsonl'), 'utf8'),
      {
        source: 'exec_json',
        observedAt: NOW,
        sourcePath: 'exec-item-error-no-status.redacted.jsonl'
      }
    )
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'item.completed',
      'turn.completed'
    ])
    expect(journal.recorded[2]?.itemKind).toBe('error')
    expect(journal.recorded[2]?.itemStatus).toBeUndefined()
    expect(journal.recorded[3]?.itemKind).toBe('agent_message')
    expect(journal.recorded[3]?.itemStatus).toBeUndefined()
    const d = new CodexStateDetector()
    for (const ev of journal.recorded) d.apply(ev)
    const st = d.getState()
    expect(st.lifecycle).toBe('completed_signal')
    expect(st.turn).toBe('completed')
    expect(st.item).toBe('unknown')
    expect(st.item).not.toBe('succeeded')
    expect(st.lifecycle).not.toBe('succeeded')
    expect(st.lifecycle).not.toBe('failed')
    expect(st.taskSemantics).toBe('not_verified')
    expect(st.cause).toBe('unknown')
    expect(st.outputIntegrity).toBe('partial')
    expect(st.outputIntegrity).not.toBe('complete')
    expect(st.retryability).toBe('unknown')
    expect(st.retryability).not.toBe('never')
  })
})

describe('明确失败后 unknown item 不得覆盖失败事实', () => {
  function expectTurnSummary(state: ReturnType<CodexStateDetector['getState']>): void {
    expect(state.lifecycle).toBe('completed_signal')
    expect(state.cause).toBe('tool_failed')
    expect(state.item).toBe('partial_failure')
    expect(state.item).not.toBe('unknown')
    expect(state.item).not.toBe('succeeded')
    expect(state.outputIntegrity).toBe('partial')
    expect(state.retryability).toBe('unknown')
    expect(state.taskSemantics).toBe('not_verified')
    expect(state.lifecycle).not.toBe('failed')
    expect(state.lifecycle).not.toBe('succeeded')
  }

  it('精确序列：error 无 status → agent_message → command failed → agent_message → turn.completed', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const errorItem = d.apply(official('item.completed', { itemId: 'e1', itemKind: 'error' }))
    expect(errorItem.state.item).toBe('unknown')
    expect(errorItem.state.cause).toBe('unknown')

    const afterMsg = d.apply(official('item.completed', { itemId: 'm1', itemKind: 'agent_message' }))
    expect(afterMsg.state.item).toBe('unknown')
    expect(afterMsg.state.item).not.toBe('succeeded')
    expect(afterMsg.state.item).not.toBe('failed')

    d.apply(official('item.started', { itemId: 'c1', itemKind: 'command_execution' }))
    const failed = d.apply(
      official('item.completed', { itemId: 'c1', itemKind: 'command_execution', itemStatus: 'failed' })
    )
    expect(failed.state.item).toBe('failed')
    expect(failed.state.cause).toBe('tool_failed')
    expect(failed.state.outputIntegrity).toBe('partial')

    const afterFailMsg = d.apply(official('item.completed', { itemId: 'm2', itemKind: 'agent_message' }))
    expect(afterFailMsg.state.item).toBe('partial_failure')
    expect(afterFailMsg.state.item).not.toBe('succeeded')
    expect(afterFailMsg.state.cause).toBe('tool_failed')

    const done = d.apply(official('turn.completed'))
    expectTurnSummary(done.state)
  })

  it('明确失败后 unknown item 不得覆盖为 unknown', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'c1', itemKind: 'command_execution', itemStatus: 'failed' }))
    const unknown = d.apply(official('item.completed', { itemId: 'x1', itemKind: 'future_widget' }))
    expect(unknown.state.item).toBe('partial_failure')
    expect(unknown.state.item).not.toBe('unknown')
    expect(unknown.state.cause).toBe('tool_failed')
    expect(unknown.state.outputIntegrity).toBe('partial')
    expect(unknown.migration?.reason).toContain('kept item=partial_failure')
    const done = d.apply(official('turn.completed'))
    expectTurnSummary(done.state)
  })

  it('明确失败后 turn.completed 不得清除 partial_failure', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'c1', itemStatus: 'failed', itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemId: 'm1', itemKind: 'agent_message' }))
    const done = d.apply(official('turn.completed'))
    expectTurnSummary(done.state)
  })

  it('declined 后成功 item 聚合为 partial_failure，不得恢复 succeeded 或 unknown', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    const declined = d.apply(
      official('item.completed', { itemId: 'd1', itemStatus: 'declined', itemKind: 'command_execution' })
    )
    expect(declined.state.item).toBe('declined')
    const after = d.apply(official('item.completed', { itemId: 'm1', itemKind: 'agent_message' }))
    expect(after.state.item).toBe('partial_failure')
    expect(after.state.item).not.toBe('succeeded')
    expect(after.state.item).not.toBe('unknown')
    expect(after.state.cause).toBe('tool_failed')
  })

  it('session_jsonl 与 exec_json 使用同一聚合规则', () => {
    const exec = new CodexStateDetector()
    exec.apply(official('turn.started'))
    exec.apply(official('item.completed', { itemKind: 'error' }))
    exec.apply(official('item.completed', { itemKind: 'agent_message' }))
    exec.apply(official('item.started', { itemKind: 'command_execution' }))
    exec.apply(official('item.completed', { itemKind: 'command_execution', itemStatus: 'failed' }))
    exec.apply(official('item.completed', { itemKind: 'future_widget' }))
    exec.apply(official('item.completed', { itemKind: 'agent_message' }))
    const execDone = exec.apply(official('turn.completed'))

    const sess = new CodexStateDetector()
    sess.apply(local('event_msg.task_started', { rawType: 'task_started' }))
    sess.apply(local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'error' }))
    sess.apply(local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'agent_message' }))
    sess.apply(local('event_msg.item_started', { rawType: 'item_started', itemKind: 'command_execution' }))
    sess.apply(
      local('event_msg.item_completed', {
        rawType: 'item_completed',
        itemKind: 'command_execution',
        itemStatus: 'failed'
      })
    )
    sess.apply(local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'future_widget' }))
    sess.apply(local('event_msg.item_completed', { rawType: 'item_completed', itemKind: 'agent_message' }))
    const sessDone = sess.apply(local('event_msg.task_complete', { rawType: 'task_complete' }))

    expectTurnSummary(execDone.state)
    expectTurnSummary(sessDone.state)
    expect(sessDone.state.item).toBe(execDone.state.item)
    expect(sessDone.state.cause).toBe(execDone.state.cause)
    expect(sessDone.state.outputIntegrity).toBe(execDone.state.outputIntegrity)
  })
})

describe('当前 turn 失败事实跨后续 item / turn.completed 保留', () => {
  it('item failed → agent_message → turn.completed：保留 tool_failed 与 partial，不伪装 never', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed', itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemId: 'i2', itemKind: 'agent_message' }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.item).toBe('partial_failure')
    expect(r.state.cause).toBe('tool_failed')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.outputIntegrity).not.toBe('complete')
    expect(r.state.outputIntegrity).not.toBe('unknown')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.state.taskSemantics).not.toBe('completed')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.state.confidence).toBe('high')
    expect(r.migration?.reason).toContain('task semantics and retryability are not verified')
    expect(r.migration?.reason).toContain('confidence is for the structured event, not task success')
    expect(r.migration?.reason).toContain('kept tool_failed')
  })

  it('item.type=error 无 status → agent_message → turn.completed：item 不得 succeeded，完整性不得 complete', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'item-error', itemKind: 'error' }))
    d.apply(official('item.completed', { itemId: 'item-msg', itemKind: 'agent_message' }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.item).toBe('unknown')
    expect(r.state.item).not.toBe('succeeded')
    expect(r.state.cause).toBe('unknown')
    expect(r.state.outputIntegrity).toBe('partial')
    expect(r.state.outputIntegrity).not.toBe('complete')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.state.taskSemantics).toBe('not_verified')
  })

  it('failed item 后多个成功 item：不能清除 tool_failed，也不能把 partial_failure 变回 succeeded', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i-fail', itemStatus: 'failed', itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemId: 'i-msg-1', itemKind: 'agent_message' }))
    d.apply(
      official('item.completed', { itemId: 'i-ok', itemStatus: 'completed', itemKind: 'command_execution' })
    )
    const last = d.apply(official('item.completed', { itemId: 'i-msg-2', itemKind: 'agent_message' }))
    expect(last.state.item).toBe('partial_failure')
    expect(last.state.item).not.toBe('succeeded')
    expect(last.state.cause).toBe('tool_failed')
    expect(last.state.outputIntegrity).toBe('partial')
    expect(last.state.lifecycle).toBe('running')
  })

  it('新 turn.started 重置当前 turn 聚合，上一轮失败仍在 migrations', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed', itemKind: 'command_execution' }))
    d.apply(official('item.completed', { itemId: 'i2', itemKind: 'agent_message' }))
    const done = d.apply(official('turn.completed'))
    expect(done.state.item).toBe('partial_failure')
    expect(done.state.cause).toBe('tool_failed')
    expect(done.state.outputIntegrity).toBe('partial')

    const turn2 = d.apply(official('turn.started'))
    expect(turn2.state.item).toBe('none')
    expect(turn2.state.cause).toBe('unknown')
    expect(turn2.state.outputIntegrity).toBe('unknown')
    expect(turn2.state.retryability).toBe('unknown')
    expect(turn2.migration?.previousState.item).toBe('partial_failure')
    expect(turn2.migration?.previousState.cause).toBe('tool_failed')
    expect(turn2.migration?.previousState.outputIntegrity).toBe('partial')
    expect(d.getMigrations().some((m) => m.nextState.item === 'failed' && m.cause === 'tool_failed')).toBe(
      true
    )
    expect(d.getMigrations().some((m) => m.nextState.item === 'partial_failure')).toBe(true)
  })

  it('明确 turn.completed 不得自动改成 taskSemantics=completed 或 retryability=never', () => {
    const d = new CodexStateDetector()
    d.apply(official('turn.started'))
    d.apply(official('item.completed', { itemId: 'item-msg', itemKind: 'agent_message' }))
    const r = d.apply(official('turn.completed'))
    expect(r.state.lifecycle).toBe('completed_signal')
    expect(r.state.taskSemantics).toBe('not_verified')
    expect(r.state.taskSemantics).not.toBe('completed')
    expect(r.state.retryability).toBe('unknown')
    expect(r.state.retryability).not.toBe('never')
    expect(r.state.confidence).toBe('high')
    expect(r.migration?.reason).toContain('confidence is for the structured event, not task success')
  })

  it('真实 exec 脱敏样本回放：failed item 后继续工作再 turn.completed', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      readFileSync(join(__dirname, 'fixtures/codex/exec-item-failed-then-turn-completed.redacted.jsonl'), 'utf8'),
      {
        source: 'exec_json',
        observedAt: NOW,
        sourcePath: 'exec-item-failed-then-turn-completed.redacted.jsonl'
      }
    )
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'item.completed',
      'item.started',
      'item.completed',
      'item.completed',
      'turn.completed'
    ])
    expect(journal.recorded[2]?.itemKind).toBe('error')
    expect(journal.recorded[2]?.itemStatus).toBeUndefined()
    expect(journal.recorded[3]?.itemKind).toBe('agent_message')
    expect(journal.recorded[4]?.itemKind).toBe('command_execution')
    expect(journal.recorded[5]?.itemKind).toBe('command_execution')
    expect(journal.recorded[5]?.itemStatus).toBe('failed')
    expect(journal.recorded[6]?.itemKind).toBe('agent_message')
    const d = new CodexStateDetector()
    for (const ev of journal.recorded) d.apply(ev)
    const st = d.getState()
    expect(st.lifecycle).toBe('completed_signal')
    expect(st.lifecycle).not.toBe('succeeded')
    expect(st.lifecycle).not.toBe('failed')
    expect(st.item).toBe('partial_failure')
    expect(st.item).not.toBe('succeeded')
    expect(st.cause).toBe('tool_failed')
    expect(st.outputIntegrity).toBe('partial')
    expect(st.outputIntegrity).not.toBe('complete')
    expect(st.retryability).toBe('unknown')
    expect(st.retryability).not.toBe('never')
    expect(st.taskSemantics).toBe('not_verified')
    expect(st.confidence).toBe('high')
  })

  it('官方 turn.cancelled fixture 进入检测器：cancelled，不是真实协议验证', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      readFileSync(join(__dirname, 'fixtures/codex/exec-turn-cancelled.redacted.jsonl'), 'utf8'),
      { source: 'exec_json', observedAt: NOW, sourcePath: 'exec-turn-cancelled.redacted.jsonl' }
    )
    const d = new CodexStateDetector()
    for (const ev of journal.recorded) d.apply(ev)
    const st = d.getState()
    expect(st.lifecycle).toBe('cancelled')
    expect(st.lifecycle).not.toBe('failed')
    expect(st.lifecycle).not.toBe('succeeded')
    expect(st.cause).toBe('unknown')
    expect(st.cause).not.toBe('user_cancelled')
    expect(st.outputIntegrity).not.toBe('complete')
    expect(st.taskSemantics).toBe('not_verified')
  })
})

describe('真实中断形状回归（脱敏 fixture，不是 turn.cancelled 协议验证）', () => {
  it('SIGINT 样本没有 turn.cancelled：保持 running，进程证据才收敛为 incomplete', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      readFileSync(join(__dirname, 'fixtures/codex/exec-sigint-no-turn-terminal.redacted.jsonl'), 'utf8'),
      {
        source: 'exec_json',
        observedAt: NOW,
        sourcePath: 'exec-sigint-no-turn-terminal.redacted.jsonl'
      }
    )
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'item.completed',
      'item.started'
    ])
    expect(journal.recorded.some((e) => e.eventType === 'turn.cancelled')).toBe(false)
    expect(journal.recorded.some((e) => e.eventType === 'turn.failed')).toBe(false)
    expect(journal.recorded.some((e) => e.eventType === 'turn.completed')).toBe(false)
    const d = new CodexStateDetector()
    for (const ev of journal.recorded) d.apply(ev)
    const jsonlOnly = d.getState()
    expect(jsonlOnly.lifecycle).toBe('running')
    expect(jsonlOnly.lifecycle).not.toBe('cancelled')
    expect(jsonlOnly.lifecycle).not.toBe('failed')
    expect(jsonlOnly.lifecycle).not.toBe('succeeded')
    expect(jsonlOnly.cause).not.toBe('user_cancelled')
    expect(jsonlOnly.turn).toBe('in_progress')
    expect(jsonlOnly.taskSemantics).toBe('not_verified')

    const afterProcess = d.applyProcess({ status: 'exited', exitCode: 1, observedAt: NOW + 1000 })
    expect(afterProcess.state.lifecycle).toBe('incomplete')
    expect(afterProcess.state.cause).toBe('process_exit')
    expect(afterProcess.state.lifecycle).not.toBe('cancelled')
    expect(afterProcess.state.lifecycle).not.toBe('failed')
    expect(afterProcess.state.cause).not.toBe('user_cancelled')
    expect(afterProcess.state.cause).not.toBe('turn_failed')
  })
})

describe('与观察层联调（模拟 fixture，不是真实 Codex 日志）', () => {
  it('观察层官方完成事件进入检测器仍是 completed_signal', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      '{"type":"thread.started","thread_id":"th"}\n{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n',
      { source: 'exec_json', observedAt: NOW }
    )
    const d = new CodexStateDetector()
    for (const ev of journal.recorded) d.apply(ev)
    expect(d.getState().lifecycle).toBe('completed_signal')
    expect(d.getState().lifecycle).not.toBe('succeeded')
    expect(d.getState().threadId).toBe('th')
  })

  it('观察层 JSON-RPC unsupported 不会变成 running/failed', () => {
    const ev = parseCodexObservation(
      { jsonrpc: '2.0', method: 'codex/event', params: { type: 'thread.started' }, id: 1 },
      { source: 'exec_json', observedAt: NOW }
    )
    const d = new CodexStateDetector()
    d.apply(ev)
    expect(d.getState().lifecycle).toBe('unknown')
    expect(d.getState().lifecycle).not.toBe('running')
  })
})
