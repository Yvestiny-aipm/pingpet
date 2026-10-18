import { appendFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent, CodexDerivedState, CodexStateMigration } from '@shared/types'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import { CodexSessionShadow } from './codexShadow'
import { CodexStateDetector } from './codexState'
import { codexSessionsRoot } from './codex'
import { AgentMonitor } from './monitor'
import type { MonitorConfig } from './monitor'

/**
 * 观察失联是 PingPet 产品策略。测试只用注入 clock 和短阈值，禁止真实长等待。
 * 不调用 applyProcess（除验证未来 process_exit 优先级的检测器单测外）。
 */

const NOW = 1_700_000_000_000
const STALE_AFTER = 1_000
const OFF = { enabled: false, envs: [] }
const CONFIG: MonitorConfig = {
  codex: { enabled: true, envs: ['terminal'] },
  claude: OFF,
  cursor: OFF,
  grok: OFF
}

let clock = NOW
let dispatched: AgentMonitorEvent[] = []
let shadowStates: CodexDerivedState[] = []
let shadowMigrations: CodexStateMigration[] = []
let petActions: string[] = []
let monitor: AgentMonitor
let applyProcessCalls = 0

function iso(at = clock): string {
  return new Date(at).toISOString()
}

function sessionPath(name: string): string {
  return join(codexSessionsRoot(), `${name}.jsonl`)
}

function writeSession(name: string, lines: unknown[]): void {
  writeFileSync(sessionPath(name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

function appendSession(name: string, lines: unknown[]): void {
  appendFileSync(sessionPath(name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

function meta(sessionId: string): unknown {
  return {
    timestamp: iso(),
    type: 'session_meta',
    payload: { session_id: sessionId, originator: 'codex_cli', source: 'cli' }
  }
}

function eventMsg(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: iso(),
    type: 'event_msg',
    payload: { type, ...extra }
  }
}

function createMonitor(): AgentMonitor {
  return new AgentMonitor(
    CONFIG,
    {
      now: () => clock,
      onEvent: (event) => {
        dispatched.push(event)
        petActions.push(`pet:${event.kind}`)
      },
      onCodexState: (state, migration) => {
        shadowStates.push(state)
        if (migration) shadowMigrations.push(migration)
      }
    },
    { shadow: { observationStaleAfterMs: STALE_AFTER } }
  )
}

function prime(): void {
  monitor.start()
  monitor.stop()
  dispatched = []
  shadowStates = []
  shadowMigrations = []
  petActions = []
}

function last(states: CodexDerivedState[] = shadowStates): CodexDerivedState | undefined {
  return states.at(-1)
}

function staleMigrations(): CodexStateMigration[] {
  return shadowMigrations.filter(
    (m) => m.nextState.connection === 'stale' && m.previousState.connection !== 'stale'
  )
}

function recoveredMigrations(): CodexStateMigration[] {
  return shadowMigrations.filter((m) => m.reason.includes('observation_recovered'))
}

beforeEach(() => {
  clock = NOW
  dispatched = []
  shadowStates = []
  shadowMigrations = []
  petActions = []
  applyProcessCalls = 0
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-stale-'))
  mkdirSync(codexSessionsRoot(), { recursive: true })
  monitor = createMonitor()
})

describe('Codex 影子观察失联', () => {
  it('1. 阈值之前保持 connected / working', () => {
    writeSession('s1', [meta('sess-fresh')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(last()?.lifecycle).toBe('running')
    expect(last()?.connection).toBe('connected')
    clock += STALE_AFTER - 1
    monitor.scanNow()
    expect(last()?.connection).toBe('connected')
    expect(mapCodexDerivedToCandidate(last()!).candidate).toBe('working')
    expect(staleMigrations()).toHaveLength(0)
  })

  it('2. 超过阈值后 connection=stale、candidate=unknown', () => {
    writeSession('s1', [meta('sess-late')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    const state = last()
    expect(state?.lifecycle).toBe('running')
    expect(state?.connection).toBe('stale')
    const c = mapCodexDerivedToCandidate(state!)
    expect(c.candidate).toBe('unknown')
    expect(c.reasonCodes).toContain('observation_stale')
  })

  it('3. stale 不变成 failed/cancelled/succeeded', () => {
    writeSession('s1', [meta('sess-no-guess')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    const state = last()
    expect(state?.lifecycle).toBe('running')
    expect(state?.lifecycle).not.toBe('failed')
    expect(state?.lifecycle).not.toBe('cancelled')
    expect(state?.lifecycle).not.toBe('succeeded')
    expect(state?.cause).not.toBe('user_cancelled')
    expect(state?.cause).not.toBe('turn_failed')
    expect(state?.cause).not.toBe('process_exit')
    const c = mapCodexDerivedToCandidate(state!)
    expect(c.candidate).not.toBe('failed')
    expect(c.candidate).not.toBe('cancelled')
  })

  it('4. stale 不调用 applyProcess，process 保持 not_observed', () => {
    const original = CodexStateDetector.prototype.applyProcess
    CodexStateDetector.prototype.applyProcess = function (...args) {
      applyProcessCalls += 1
      return original.apply(this, args)
    }
    try {
      writeSession('s1', [meta('sess-no-proc')])
      prime()
      clock += 10
      appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
      monitor.scanNow()
      clock += STALE_AFTER
      monitor.scanNow()
      expect(applyProcessCalls).toBe(0)
      expect(last()?.process).toBe('not_observed')
      expect(last()?.process).not.toBe('exited')
    } finally {
      CodexStateDetector.prototype.applyProcess = original
    }
  })

  it('5. 只有旧文件不在 filePaths 中，不进入 stale', () => {
    writeSession('keep', [meta('sess-keep')])
    writeSession('other', [meta('sess-other')])
    const shadow = new CodexSessionShadow({ observationStaleAfterMs: STALE_AFTER })
    const keep = sessionPath('keep')
    const other = sessionPath('other')
    const callbacks: CodexDerivedState[] = []
    shadow.observe([keep, other], clock, { emitCallbacks: false })
    clock += 10
    appendSession('keep', [eventMsg('task_started', { turn_id: 't1' })])
    shadow.observe([keep, other], clock, {
      emitCallbacks: true,
      onState: (state) => callbacks.push(state)
    })
    expect(callbacks.at(-1)?.lifecycle).toBe('running')
    clock += STALE_AFTER
    shadow.observe([other], clock, {
      emitCallbacks: true,
      onState: (state) => callbacks.push(state)
    })
    expect(shadow.snapshotFor(keep)?.state.connection).not.toBe('stale')
    expect(shadow.snapshotFor(keep)?.state.lifecycle).toBe('running')
    expect(callbacks.filter((s) => s.connection === 'stale')).toHaveLength(0)
  })

  it('6. 文件删除不进入 stale', () => {
    writeSession('gone', [meta('sess-gone')])
    prime()
    clock += 10
    appendSession('gone', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    unlinkSync(sessionPath('gone'))
    clock += STALE_AFTER
    monitor.scanNow()
    expect(monitor.getCodexShadowSnapshots().some((s) => s.filePath.endsWith('gone.jsonl'))).toBe(false)
    expect(staleMigrations()).toHaveLength(0)
    expect(shadowStates.every((s) => s.connection !== 'stale')).toBe(true)
  })

  it('7. priming 历史文件不进入 stale', () => {
    writeSession('hist', [meta('sess-hist'), eventMsg('task_started', { turn_id: 't1' })])
    monitor.start()
    monitor.stop()
    expect(shadowStates).toEqual([])
    expect(monitor.getCodexShadowSnapshots()[0]?.state.lifecycle).toBe('running')
    expect(monitor.getCodexShadowSnapshots()[0]?.state.connection).not.toBe('stale')
    clock += STALE_AFTER * 5
    monitor.scanNow()
    expect(staleMigrations()).toHaveLength(0)
    expect(monitor.getCodexShadowSnapshots()[0]?.state.connection).not.toBe('stale')
    expect(petActions).toEqual([])
  })

  it('8. 没有活动 turn 的 session 不进入 stale', () => {
    writeSession('idle', [meta('sess-idle')])
    prime()
    clock += 10
    appendSession('idle', [
      {
        timestamp: iso(),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total: 1 } }
      }
    ])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    expect(staleMigrations()).toHaveLength(0)
    const snap = monitor.getCodexShadowSnapshots()[0]
    expect(snap?.state.lifecycle).not.toBe('running')
    expect(snap?.state.connection).not.toBe('stale')
  })

  it('9. stale 后收到新事件，恢复 connected / working', () => {
    writeSession('s1', [meta('sess-rec')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    expect(last()?.connection).toBe('stale')
    clock += 10
    appendSession('s1', [
      eventMsg('item_started', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'in_progress' }
      })
    ])
    monitor.scanNow()
    expect(last()?.connection).toBe('connected')
    expect(last()?.lifecycle).toBe('running')
    expect(mapCodexDerivedToCandidate(last()!).candidate).toBe('working')
    expect(recoveredMigrations()).toHaveLength(1)
  })

  it('10. stale 后收到 turn.completed，直接进入 completed_signal', () => {
    writeSession('s1', [meta('sess-done')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    clock += 10
    appendSession('s1', [eventMsg('task_complete', { turn_id: 't1' })])
    monitor.scanNow()
    expect(last()?.lifecycle).toBe('completed_signal')
    expect(last()?.connection).toBe('connected')
    expect(last()?.lifecycle).not.toBe('failed')
    expect(mapCodexDerivedToCandidate(last()!).candidate).toBe('completed_signal')
    expect(recoveredMigrations()).toHaveLength(1)
  })

  it('11. 已有 tool_failed 后进入 stale，失败事实仍保留', () => {
    writeSession('s1', [meta('sess-fail')])
    prime()
    clock += 10
    appendSession('s1', [
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      })
    ])
    monitor.scanNow()
    expect(last()?.cause).toBe('tool_failed')
    clock += STALE_AFTER
    monitor.scanNow()
    const state = last()
    expect(state?.connection).toBe('stale')
    expect(state?.lifecycle).toBe('running')
    expect(state?.cause).toBe('tool_failed')
    expect(state?.item).toBe('failed')
    expect(state?.outputIntegrity).toBe('partial')
    expect(state?.cause).not.toBe('process_exit')
    const c = mapCodexDerivedToCandidate(state!)
    expect(c.candidate).toBe('unknown')
    expect(c.reasonCodes).toContain('observation_stale')
    expect(c.reasonCodes).toContain('tool_failed_fact_present_not_turn_failed')
  })

  it('12. stale 后恢复，partial/tool_failed 仍保留', () => {
    writeSession('s1', [meta('sess-keep-fail')])
    prime()
    clock += 10
    appendSession('s1', [
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      })
    ])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    clock += 10
    appendSession('s1', [
      eventMsg('item_started', {
        turn_id: 't1',
        item: { id: 'exec-2', type: 'CommandExecution', status: 'in_progress' }
      })
    ])
    monitor.scanNow()
    const state = last()
    expect(state?.connection).toBe('connected')
    expect(state?.cause).toBe('tool_failed')
    expect(['failed', 'partial_failure']).toContain(state?.item)
    expect(state?.outputIntegrity).toBe('partial')
    const c = mapCodexDerivedToCandidate(state!)
    expect(c.candidate).toBe('working')
    expect(c.candidatePetState).toBe('cautious')
    expect(c.reasonCodes).toContain('running_with_item_failure')
  })

  it('13. 连续多个 tick 不重复写 stale', () => {
    writeSession('s1', [meta('sess-once')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    const afterFirst = staleMigrations().length
    expect(afterFirst).toBe(1)
    const n = shadowMigrations.length
    clock += STALE_AFTER
    monitor.scanNow()
    monitor.scanNow()
    expect(staleMigrations()).toHaveLength(1)
    expect(shadowMigrations).toHaveLength(n)
  })

  it('14. 恢复只写一次 recovered', () => {
    writeSession('s1', [meta('sess-rec-once')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    clock += 10
    appendSession('s1', [
      eventMsg('item_started', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'in_progress' }
      })
    ])
    monitor.scanNow()
    expect(recoveredMigrations()).toHaveLength(1)
    clock += 10
    monitor.scanNow()
    monitor.scanNow()
    expect(recoveredMigrations()).toHaveLength(1)
  })

  it('15. 多 session 互相隔离', () => {
    writeSession('a', [meta('sess-a')])
    writeSession('b', [meta('sess-b')])
    prime()
    clock += 10
    appendSession('a', [eventMsg('task_started', { turn_id: 'ta' })])
    appendSession('b', [eventMsg('task_started', { turn_id: 'tb' })])
    monitor.scanNow()
    clock += 10
    appendSession('b', [
      eventMsg('item_started', {
        turn_id: 'tb',
        item: { id: 'exec-b', type: 'CommandExecution', status: 'in_progress' }
      })
    ])
    monitor.scanNow()
    clock += STALE_AFTER - 10
    monitor.scanNow()
    const snaps = monitor.getCodexShadowSnapshots()
    const a = snaps.find((s) => s.state.sessionId === 'sess-a')
    const b = snaps.find((s) => s.state.sessionId === 'sess-b')
    expect(a?.state.connection).toBe('stale')
    expect(b?.state.connection).toBe('connected')
    expect(b?.state.lifecycle).toBe('running')
    expect(mapCodexDerivedToCandidate(a!.state).candidate).toBe('unknown')
    expect(mapCodexDerivedToCandidate(b!.state).candidate).toBe('working')
  })

  it('16. turn.completed / 明确取消后不进入 stale', () => {
    writeSession('done', [meta('sess-term')])
    prime()
    clock += 10
    appendSession('done', [
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('task_complete', { turn_id: 't1' })
    ])
    monitor.scanNow()
    expect(last()?.lifecycle).toBe('completed_signal')
    clock += STALE_AFTER
    monitor.scanNow()
    expect(monitor.getCodexShadowSnapshots()[0]?.state.connection).not.toBe('stale')
    expect(staleMigrations()).toHaveLength(0)

    writeSession('cancel', [meta('sess-cancel')])
    clock += 10
    monitor.scanNow()
    clock += 10
    appendSession('cancel', [
      eventMsg('task_started', { turn_id: 'tc' }),
      eventMsg('turn_aborted', { turn_id: 'tc', reason: 'user_cancelled' })
    ])
    monitor.scanNow()
    const cancelSnap = monitor.getCodexShadowSnapshots().find((s) => s.state.sessionId === 'sess-cancel')
    expect(cancelSnap?.state.lifecycle).toBe('cancelled')
    clock += STALE_AFTER
    monitor.scanNow()
    const cancelAfter = monitor.getCodexShadowSnapshots().find((s) => s.state.sessionId === 'sess-cancel')
    expect(cancelAfter?.state.connection).not.toBe('stale')
    expect(cancelAfter?.state.lifecycle).toBe('cancelled')
    expect(cancelAfter?.state.cause).toBe('user_cancelled')
  })

  it('17. 未来 process_exit 证据优先于 stale', () => {
    const d = new CodexStateDetector()
    d.apply({
      source: 'exec_json',
      eventType: 'turn.started',
      observedAt: clock,
      payload: { type: 'turn.started' },
      recognized: true,
      recognition: 'recognized',
      evidenceOrigin: 'codex_exec_json',
      dedupKey: 'exec:turn.started:prio',
      rawType: 'turn.started'
    })
    d.applyProcess({ status: 'exited', exitCode: 1, observedAt: clock + 1 })
    expect(d.getState().cause).toBe('process_exit')
    expect(d.markObservationStale(clock + STALE_AFTER).applied).toBe(false)
    expect(d.getState().lifecycle).toBe('incomplete')
    expect(d.getState().connection).not.toBe('stale')
    const c = mapCodexDerivedToCandidate(d.getState())
    expect(c.candidate).toBe('incomplete')
    expect(c.reasonCodes).toContain('process_exit')
    expect(c.reasonCodes).not.toContain('observation_stale')
  })

  it('18. shouldNotify 始终为 false', () => {
    writeSession('s1', [meta('sess-notify')])
    prime()
    clock += 10
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    clock += STALE_AFTER
    monitor.scanNow()
    clock += 10
    appendSession('s1', [eventMsg('task_complete', { turn_id: 't1' })])
    monitor.scanNow()
    for (const state of shadowStates) {
      expect(mapCodexDerivedToCandidate(state).shouldNotify).toBe(false)
    }
  })

  it('19. 旧 Monitor / onEvent / 桌宠路径保持不变', () => {
    writeSession('legacy', [meta('sess-legacy')])
    prime()
    clock += 10
    appendSession('legacy', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
    expect(petActions).toEqual(['pet:working'])
    clock += STALE_AFTER
    monitor.scanNow()
    expect(last()?.connection).toBe('stale')
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
    expect(petActions).toEqual(['pet:working'])
    expect(dispatched.some((e) => e.kind === 'failed')).toBe(false)
    expect(dispatched.some((e) => e.kind === 'needs_attention')).toBe(false)
  })

  it('只有 turn_aborted 不会立刻变成 stale 或 user_cancelled（无明确取消词）', () => {
    writeSession('s1', [meta('sess-abort')])
    prime()
    clock += 10
    appendSession('s1', [
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('turn_aborted', { turn_id: 't1', reason: 'interrupted' })
    ])
    monitor.scanNow()
    expect(last()?.lifecycle).toBe('unknown')
    expect(last()?.cause).not.toBe('user_cancelled')
    expect(last()?.connection).not.toBe('stale')
    clock += STALE_AFTER - 1
    monitor.scanNow()
    expect(last()?.connection).not.toBe('stale')
  })
})
