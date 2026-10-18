import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent, CodexDerivedState, CodexStateMigration } from '@shared/types'
import { CodexSessionShadow } from './codexShadow'
import {
  appendCodexShadowDiagnostic,
  CODEX_SHADOW_DIAGNOSTIC_KIND,
  formatCodexShadowDiagnostic
} from './codexShadowLog'
import { codexSessionsRoot } from './codex'
import { AgentMonitor } from './monitor'
import type { MonitorConfig } from './monitor'

/**
 * Codex 影子接入测试。旧 onEvent / 桌宠路径必须保持原样；
 * 新状态只进 onCodexState，不能映射成 working/done/needs_attention/failed。
 */

const NOW = 1_700_000_000_000
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

function meta(sessionId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: iso(),
    type: 'session_meta',
    payload: { session_id: sessionId, originator: 'codex_cli', source: 'cli', ...extra }
  }
}

function eventMsg(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: iso(),
    type: 'event_msg',
    payload: { type, ...extra }
  }
}

function createMonitor(shadow?: { maxSlicesPerFile?: number; maxBytesPerSlice?: number }): AgentMonitor {
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
    shadow ? { shadow } : undefined
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

beforeEach(() => {
  clock = NOW
  dispatched = []
  shadowStates = []
  shadowMigrations = []
  petActions = []
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-shadow-'))
  mkdirSync(codexSessionsRoot(), { recursive: true })
  monitor = createMonitor()
})

describe('Codex 影子接入：priming 与增量', () => {
  it('首次扫描历史 session 只 priming，不触发用户事件或影子回调', () => {
    writeSession('hist', [
      meta('real-sess-1'),
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('task_complete', { turn_id: 't1' })
    ])
    monitor.start()
    monitor.stop()
    expect(dispatched).toEqual([])
    expect(shadowStates).toEqual([])
    expect(petActions).toEqual([])
    const snap = monitor.getCodexShadowSnapshots()
    expect(snap).toHaveLength(1)
    expect(snap[0]?.state.sessionId).toBe('real-sess-1')
    expect(snap[0]?.state.sessionId).not.toBe('hist.jsonl')
    expect(snap[0]?.state.lifecycle).toBe('completed_signal')
    expect(snap[0]?.migrations.length).toBeGreaterThan(0)
  })

  it('第二次扫描追加 turn.started，得到 running 影子状态', () => {
    writeSession('s1', [meta('sess-run')])
    prime()
    clock += 1000
    appendSession('s1', [eventMsg('task_started', { turn_id: 't2' })])
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('running')
    expect(shadowStates.at(-1)?.turn).toBe('in_progress')
    expect(shadowStates.at(-1)?.sessionId).toBe('sess-run')
  })

  it('追加 turn.completed，得到 completed_signal', () => {
    writeSession('s1', [meta('sess-done'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    clock += 1000
    appendSession('s1', [eventMsg('task_complete', { turn_id: 't1' })])
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('completed_signal')
    expect(shadowStates.at(-1)?.lifecycle).not.toBe('succeeded')
  })

  it('item failed 后继续执行，得到 running + tool_failed', () => {
    writeSession('s1', [meta('sess-tool'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    clock += 1000
    appendSession('s1', [
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      })
    ])
    monitor.scanNow()
    const state = shadowStates.at(-1)
    expect(state?.lifecycle).toBe('running')
    expect(state?.cause).toBe('tool_failed')
    expect(state?.item).toBe('failed')
    expect(state?.lifecycle).not.toBe('failed')
    expect(state?.lifecycle).not.toBe('incomplete')
  })

  it('item failed 后跨 turn，下一轮不继承 partial_failure', () => {
    writeSession('s1', [meta('sess-cross'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    clock += 1000
    appendSession('s1', [
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      })
    ])
    monitor.scanNow()
    clock += 1000
    appendSession('s1', [eventMsg('task_complete', { turn_id: 't1' })])
    monitor.scanNow()
    clock += 1000
    appendSession('s1', [eventMsg('task_started', { turn_id: 't2' })])
    monitor.scanNow()
    clock += 1000
    appendSession('s1', [
      eventMsg('item_started', {
        turn_id: 't2',
        item: { id: 'exec-2', type: 'CommandExecution', status: 'in_progress' }
      })
    ])
    monitor.scanNow()
    const state = shadowStates.at(-1)
    expect(state?.lifecycle).toBe('running')
    expect(state?.item).toBe('running')
    expect(state?.item).not.toBe('partial_failure')
    expect(state?.turnId).toBe('t2')
    expect(shadowMigrations.some((m) => m.nextState.item === 'failed')).toBe(true)
  })

  it('同一文件追加内容分多次读取，只消费新增内容', () => {
    writeSession('s1', [meta('sess-inc')])
    prime()
    clock += 1000
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(shadowStates.map((s) => s.lifecycle)).toEqual(['running'])
    const afterFirst = shadowMigrations.length
    clock += 1000
    appendSession('s1', [eventMsg('task_complete', { turn_id: 't1' })])
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('completed_signal')
    expect(shadowMigrations.length).toBeGreaterThan(afterFirst)
  })

  it('重复扫描同一内容不重复迁移', () => {
    writeSession('s1', [meta('sess-dup')])
    prime()
    clock += 1000
    appendSession('s1', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    const n = shadowMigrations.length
    monitor.scanNow()
    monitor.scanNow()
    expect(shadowMigrations).toHaveLength(n)
  })
})

describe('Codex 影子接入：隔离、截断、旧路径', () => {
  it('多个 session 相互隔离', () => {
    writeSession('a', [meta('sess-a')])
    writeSession('b', [meta('sess-b')])
    prime()
    clock += 1000
    appendSession('a', [
      eventMsg('task_started', { turn_id: 'ta' }),
      eventMsg('item_completed', {
        turn_id: 'ta',
        item: { id: 'fail-a', type: 'CommandExecution', status: 'failed' }
      })
    ])
    appendSession('b', [eventMsg('task_started', { turn_id: 'tb' })])
    monitor.scanNow()
    const snaps = monitor.getCodexShadowSnapshots()
    const a = snaps.find((s) => s.state.sessionId === 'sess-a')
    const b = snaps.find((s) => s.state.sessionId === 'sess-b')
    expect(a?.state.cause).toBe('tool_failed')
    expect(a?.state.item).toBe('failed')
    expect(b?.state.lifecycle).toBe('running')
    expect(b?.state.item).not.toBe('failed')
    expect(b?.state.item).not.toBe('partial_failure')
    expect(b?.state.cause).not.toBe('tool_failed')
  })

  it('文件截断或轮换后安全恢复，不把旧历史再当成新事件提醒', () => {
    writeSession('rot', [
      meta('old-sess'),
      eventMsg('task_started', { turn_id: 'old' }),
      eventMsg('task_complete', { turn_id: 'old' })
    ])
    prime()
    writeSession('rot', [meta('new-sess')])
    monitor.scanNow()
    expect(shadowStates).toEqual([])
    expect(petActions).toEqual([])
    const afterRotate = monitor.getCodexShadowSnapshots()
    expect(afterRotate[0]?.state.sessionId).toBe('new-sess')
    expect(afterRotate[0]?.state.lifecycle).not.toBe('completed_signal')
    clock += 1000
    appendSession('rot', [eventMsg('task_started', { turn_id: 'fresh' })])
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('running')
    expect(shadowStates.at(-1)?.sessionId).toBe('new-sess')
  })

  it('旧 Monitor 的 onEvent 行为不变：task_started 仍派发 working', () => {
    writeSession('legacy', [meta('sess-legacy')])
    prime()
    clock += 1000
    appendSession('legacy', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
    expect(dispatched[0]?.source).toBe('codex')
    expect(dispatched[0]?.env).toBe('terminal')
    expect(shadowStates.at(-1)?.lifecycle).toBe('running')
  })

  it('影子状态回调不会触发桌宠动作、气泡或声音', () => {
    writeSession('quiet', [meta('sess-quiet'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    clock += 1000
    appendSession('quiet', [
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      }),
      { timestamp: iso(), type: 'not-a-real-type', payload: {} }
    ])
    appendFileSync(sessionPath('quiet'), '{not json\n')
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('running')
    expect(shadowStates.at(-1)?.cause).toBe('tool_failed')
    expect(dispatched).toEqual([])
    expect(petActions).toEqual([])
    const snap = monitor.getCodexShadowSnapshots()[0]
    expect(snap?.state.lifecycle).toBe('running')
    expect(snap?.state.evidence[0]?.eventType).toBe('malformed')
  })

  it('文件不存在或被删除时不崩溃，也不自动 incomplete/failed', () => {
    writeSession('gone', [meta('sess-gone'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    unlinkSync(sessionPath('gone'))
    expect(() => monitor.scanNow()).not.toThrow()
    expect(monitor.getStatus().error).toBeNull()
    expect(monitor.getCodexShadowSnapshots().some((s) => s.filePath.endsWith('gone.jsonl'))).toBe(
      false
    )
    expect(shadowStates).toEqual([])
    expect(shadowStates.every((s) => s.lifecycle !== 'incomplete')).toBe(true)
    expect(shadowStates.every((s) => s.lifecycle !== 'failed')).toBe(true)
  })
})

describe('Codex 影子接入：超大文件 priming', () => {
  it('历史文件需要多轮读完之前，不得影子回调；读完后再追加才回调', () => {
    writeSession('huge', [
      meta('sess-huge'),
      eventMsg('task_started', { turn_id: 't1', pad: 'x'.repeat(80) }),
      eventMsg('token_count', { info: { pad: 'y'.repeat(80) } }),
      eventMsg('token_count', { info: { pad: 'z'.repeat(80) } })
    ])
    monitor = createMonitor({ maxSlicesPerFile: 1, maxBytesPerSlice: 40 })
    monitor.start()
    monitor.stop()
    expect(monitor.getCodexShadowSnapshots()[0]?.primed).toBe(false)
    expect(shadowStates).toEqual([])
    expect(petActions).toEqual([])

    let guard = 0
    while (guard < 40 && !monitor.getCodexShadowSnapshots()[0]?.primed) {
      guard += 1
      monitor.scanNow()
      expect(shadowStates).toEqual([])
    }
    expect(monitor.getCodexShadowSnapshots()[0]?.primed).toBe(true)
    expect(shadowStates).toEqual([])
    expect(monitor.getCodexShadowSnapshots()[0]?.state.lifecycle).toBe('running')

    clock += 1000
    appendSession('huge', [eventMsg('task_complete', { turn_id: 't1' })])
    let added = 0
    while (added < 20 && shadowStates.length === 0) {
      added += 1
      monitor.scanNow()
    }
    expect(shadowStates.at(-1)?.lifecycle).toBe('completed_signal')
    expect(shadowStates.some((s) => s.lifecycle === 'running')).toBe(false)
  })
})

describe('Codex 影子接入：删除、过期、替换', () => {
  it('文件只是暂时不在本轮 filePaths 中时，已有 track 可以保留', () => {
    writeSession('keep', [meta('sess-keep'), eventMsg('task_started', { turn_id: 't1' })])
    writeSession('other', [meta('sess-other')])
    const shadow = new CodexSessionShadow()
    const keep = sessionPath('keep')
    const other = sessionPath('other')
    const callbacks: CodexDerivedState[] = []
    shadow.observe([keep, other], clock, { emitCallbacks: false })
    expect(shadow.snapshotFor(keep)?.primed).toBe(true)
    shadow.observe([other], clock + 1, {
      emitCallbacks: true,
      onState: (state) => callbacks.push(state)
    })
    expect(shadow.snapshotFor(keep)).toBeTruthy()
    expect(shadow.snapshotFor(keep)?.state.sessionId).toBe('sess-keep')
    expect(shadow.snapshotFor(keep)?.state.lifecycle).toBe('running')
    expect(shadow.snapshotFor(keep)?.state.lifecycle).not.toBe('incomplete')
    expect(callbacks).toEqual([])
  })

  it('新文件大小相同或更大时，按替换重新 priming，不回调历史状态', () => {
    const oldLines = [
      meta('old-same'),
      eventMsg('task_started', { turn_id: 'old', pad: 'A'.repeat(48) }),
      eventMsg('task_complete', { turn_id: 'old' })
    ]
    writeSession('swap', oldLines)
    prime()
    expect(monitor.getCodexShadowSnapshots()[0]?.state.lifecycle).toBe('completed_signal')

    const replacement = [
      meta('new-same'),
      eventMsg('task_started', { turn_id: 'new', pad: 'B'.repeat(48) }),
      eventMsg('token_count', { info: { pad: 'C'.repeat(48) } })
    ]
    writeSession('swap', replacement)
    monitor.scanNow()
    expect(shadowStates).toEqual([])
    expect(petActions).toEqual([])
    const snap = monitor.getCodexShadowSnapshots()[0]
    expect(snap?.state.sessionId).toBe('new-same')
    expect(snap?.state.lifecycle).toBe('running')
    expect(snap?.primed).toBe(true)

    clock += 1000
    appendSession('swap', [eventMsg('task_complete', { turn_id: 'new' })])
    monitor.scanNow()
    expect(shadowStates.at(-1)?.lifecycle).toBe('completed_signal')
    expect(shadowStates.at(-1)?.sessionId).toBe('new-same')
  })
})

describe('Codex 影子诊断输出', () => {
  it('诊断记录包含对照字段，且不会进入桌宠路径', () => {
    const diagPath = join(codexSessionsRoot(), 'codex-shadow.jsonl')
    monitor = new AgentMonitor(CONFIG, {
      now: () => clock,
      onEvent: (event) => {
        dispatched.push(event)
        petActions.push(`pet:${event.kind}`)
      },
      onCodexState: (state, migration) => {
        shadowStates.push(state)
        if (migration) shadowMigrations.push(migration)
        appendCodexShadowDiagnostic(state, migration, diagPath)
      }
    })
    writeSession('diag', [meta('sess-diag'), eventMsg('task_started', { turn_id: 't1' })])
    prime()
    clock += 1000
    appendSession('diag', [
      eventMsg('item_completed', {
        turn_id: 't1',
        item: { id: 'exec-1', type: 'CommandExecution', status: 'failed' }
      })
    ])
    monitor.scanNow()
    expect(dispatched).toEqual([])
    expect(petActions).toEqual([])
    const raw = readFileSync(diagPath, 'utf8').trim().split('\n').at(-1)
    expect(raw).toBeTruthy()
    const rec = JSON.parse(raw ?? '{}') as ReturnType<typeof formatCodexShadowDiagnostic>
    expect(rec.kind).toBe(CODEX_SHADOW_DIAGNOSTIC_KIND)
    expect(rec.userVisible).toBe(false)
    expect(rec.note).toContain('shadow')
    expect(rec.sessionId).toMatch(/^sess-/)
    expect(rec.sessionId).not.toBe('sess-diag')
    expect(rec.turnId).toMatch(/^turn-/)
    expect(rec.turnId).not.toBe('t1')
    expect(JSON.stringify(rec)).not.toContain('sess-diag')
    expect(rec.lifecycle).toBe('running')
    expect(rec.cause).toBe('tool_failed')
    expect(rec.process).toBeDefined()
    expect(rec.connection).toBeDefined()
    expect(rec.item).toBe('failed')
    expect(rec.outputIntegrity).toBeDefined()
    expect(rec.confidence).toBeDefined()
    expect(rec.source).toBeDefined()
    expect(rec.reason).toBeTruthy()
    expect(rec.observedAt).toBeGreaterThan(0)
  })
})
