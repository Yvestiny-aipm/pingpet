import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent, CodexDerivedState, CodexStateMigration } from '@shared/types'
import { AgentMonitor } from './monitor'
import type { MonitorConfig } from './monitor'
import { codexSessionsRoot } from './codex'
import {
  appendCodexCandidateDiagnostic,
  appendCodexLegacyDiagnostic,
  appendCodexShadowDiagnostic,
  formatCodexLegacyDiagnostic,
  formatCodexShadowDiagnostic,
  resetCodexDiagnosticDedupForTests,
  type CodexLegacyDiagnosticDraft
} from './codexShadowLog'
import type { CodexShadowCallbackMeta } from './codexShadow'

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
let shadowMeta: CodexShadowCallbackMeta[] = []
let legacyDrafts: CodexLegacyDiagnosticDraft[] = []
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

function createMonitor(overrides: {
  onLegacyDiagnostic?: (draft: CodexLegacyDiagnosticDraft) => void
  onCodexState?: (
    state: CodexDerivedState,
    migration?: CodexStateMigration,
    meta?: CodexShadowCallbackMeta
  ) => void
} = {}): AgentMonitor {
  return new AgentMonitor(CONFIG, {
    now: () => clock,
    onEvent: (event) => {
      dispatched.push(event)
      petActions.push(`pet:${event.kind}`)
    },
    onLegacyDiagnostic: (draft) => {
      legacyDrafts.push(draft)
      overrides.onLegacyDiagnostic?.(draft)
    },
    onCodexState: (state, migration, meta) => {
      shadowStates.push(state)
      if (migration) shadowMigrations.push(migration)
      if (meta) shadowMeta.push(meta)
      overrides.onCodexState?.(state, migration, meta)
    }
  })
}

function prime(): void {
  monitor.start()
  monitor.stop()
  dispatched = []
  shadowStates = []
  shadowMigrations = []
  shadowMeta = []
  legacyDrafts = []
  petActions = []
}

beforeEach(() => {
  clock = NOW
  dispatched = []
  shadowStates = []
  shadowMigrations = []
  shadowMeta = []
  legacyDrafts = []
  petActions = []
  resetCodexDiagnosticDedupForTests()
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-dual-'))
  mkdirSync(codexSessionsRoot(), { recursive: true })
  monitor = createMonitor()
})

afterEach(() => {
  monitor?.stop()
})

describe('在线双轨诊断', () => {
  it('在线旧事件和影子迁移可以同时记录，且不进桌宠路径', () => {
    writeSession('live', [meta('sess-live')])
    prime()
    clock += 1000
    appendSession('live', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
    expect(shadowStates.at(-1)?.lifecycle).toBe('running')
    expect(legacyDrafts.some((d) => d.legacyKind === 'working' && d.dispatched)).toBe(true)
    expect(shadowMeta.length).toBeGreaterThan(0)
    expect(shadowMeta[0]?.observationId).toMatch(/^shadow:/)
    expect(legacyDrafts[0]?.observationId).toMatch(/^legacy:/)
    expect(petActions).toEqual(['pet:working'])
    expect(shadowStates.at(-1)?.lifecycle).not.toBe('succeeded')
  })

  it('两条诊断路径互不影响', () => {
    const boomLegacy: string[] = []
    const boomShadow: string[] = []
    monitor = createMonitor({
      onLegacyDiagnostic: () => {
        boomLegacy.push('legacy')
        throw new Error('legacy writer down')
      },
      onCodexState: () => {
        boomShadow.push('shadow')
        throw new Error('shadow writer down')
      }
    })
    writeSession('iso', [meta('sess-iso')])
    prime()
    clock += 1000
    appendSession('iso', [eventMsg('task_started', { turn_id: 't1' })])
    expect(() => monitor.scanNow()).not.toThrow()
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
    expect(boomLegacy.length).toBeGreaterThan(0)
    expect(boomShadow.length).toBeGreaterThan(0)
    expect(petActions).toEqual(['pet:working'])
  })

  it('重复 tick 不重复写同一迁移', () => {
    writeSession('dup', [meta('sess-dup')])
    prime()
    clock += 1000
    appendSession('dup', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    const legacyOnce = legacyDrafts.length
    const shadowOnce = shadowMigrations.length
    monitor.scanNow()
    monitor.scanNow()
    expect(legacyDrafts.length).toBe(legacyOnce)
    expect(shadowMigrations.length).toBe(shadowOnce)
  })

  it('首次 priming 不写历史诊断', () => {
    writeSession('hist', [
      meta('sess-hist'),
      eventMsg('task_started', { turn_id: 't1' }),
      eventMsg('task_complete', { turn_id: 't1' })
    ])
    monitor.start()
    monitor.stop()
    expect(legacyDrafts).toEqual([])
    expect(shadowStates).toEqual([])
    expect(dispatched).toEqual([])
    expect(petActions).toEqual([])
  })

  it('新 session 文件不重放历史影子诊断', () => {
    writeSession('seed', [meta('sess-seed')])
    prime()
    clock += 1000
    writeSession('brand-new', [
      meta('sess-new'),
      eventMsg('task_started', { turn_id: 'old' }),
      eventMsg('task_complete', { turn_id: 'old' })
    ])
    monitor.scanNow()
    expect(shadowStates).toEqual([])
    expect(shadowMigrations).toEqual([])
    const snap = monitor.getCodexShadowSnapshots().find((s) => s.filePath.endsWith('brand-new.jsonl'))
    expect(snap?.primed).toBe(true)
    expect(snap?.state.lifecycle).toBe('completed_signal')
  })

  it('影子诊断缺失 eventTime 时写 null，不得用 observedAt 填入', () => {
    const rec = formatCodexShadowDiagnostic({
      lifecycle: 'running',
      cause: 'unknown',
      process: 'not_observed',
      connection: 'unknown',
      session: 'active',
      turn: 'in_progress',
      item: 'none',
      outputIntegrity: 'unknown',
      taskSemantics: 'not_verified',
      retryability: 'unknown',
      confidence: 'low',
      evidence: [],
      conflicts: [],
      observedAt: NOW
    })
    expect(rec.eventTime).toBeNull()
    expect(rec.migrationObservedAt).toBeNull()
    expect(rec.observedAt).toBe(NOW)
    expect(rec.threadId).toBe('unknown')
    expect(rec.turnId).toBe('unknown')
  })

  it('诊断信息不包含 prompt、assistant 正文、命令、token 或文件内容', () => {
    const draft: CodexLegacyDiagnosticDraft = {
      observationId: 'legacy:test',
      seq: 1,
      observedAt: NOW,
      eventTime: NOW,
      source: 'codex',
      env: 'terminal',
      legacyKind: 'working',
      rawPath: '/Users/czy/.codex/sessions/secret-session.jsonl',
      sessionKey: 'secret-session.jsonl',
      dispatched: true,
      ignoredBy: [],
      productionVisible: true
    }
    const rec = formatCodexLegacyDiagnostic(draft)
    const text = JSON.stringify(rec)
    expect(text).not.toContain('secret-session')
    expect(text).not.toContain('/Users/czy')
    expect(text).not.toContain('prompt')
    expect(rec.sessionKey).toMatch(/^sess-/)
    expect(rec.fileAlias).toMatch(/^file-/)
    expect(rec.userVisible).toBe(false)
  })

  it('不同 session/thread/turn 不串线', () => {
    writeSession('a', [meta('sess-a')])
    writeSession('b', [meta('sess-b')])
    prime()
    clock += 1000
    appendSession('a', [
      eventMsg('task_started', { turn_id: 'ta' }),
      eventMsg('item_completed', {
        turn_id: 'ta',
        item: { id: 'x', type: 'CommandExecution', status: 'failed' }
      })
    ])
    appendSession('b', [eventMsg('task_started', { turn_id: 'tb' })])
    monitor.scanNow()
    const snaps = monitor.getCodexShadowSnapshots()
    const a = snaps.find((s) => s.filePath.endsWith('a.jsonl'))
    const b = snaps.find((s) => s.filePath.endsWith('b.jsonl'))
    expect(a?.state.sessionId).toBe('sess-a')
    expect(b?.state.sessionId).toBe('sess-b')
    expect(a?.state.cause).toBe('tool_failed')
    expect(b?.state.cause).not.toBe('tool_failed')
    expect(b?.state.turnId).toBe('tb')
    expect(a?.state.turnId).toBe('ta')
  })

  it('旧路径被环境过滤忽略时标记生产不可见，不能当作无事件', () => {
    monitor = new AgentMonitor(
      { ...CONFIG, codex: { enabled: true, envs: ['vscode'] } },
      {
        now: () => clock,
        onEvent: (event) => {
          dispatched.push(event)
          petActions.push(`pet:${event.kind}`)
        },
        onLegacyDiagnostic: (draft) => {
          legacyDrafts.push(draft)
        },
        onCodexState: (state, migration, meta) => {
          shadowStates.push(state)
          if (migration) shadowMigrations.push(migration)
          if (meta) shadowMeta.push(meta)
        }
      }
    )
    writeSession('envcut', [meta('sess-env')])
    prime()
    clock += 1000
    appendSession('envcut', [eventMsg('task_started', { turn_id: 't1' })])
    monitor.scanNow()
    expect(dispatched).toEqual([])
    expect(legacyDrafts.some((d) => d.ignoredBy.includes('env') && !d.productionVisible)).toBe(true)
    expect(legacyDrafts.some((d) => d.legacyKind === 'working')).toBe(true)
    expect(legacyDrafts.some((d) => d.dispatched)).toBe(false)
  })

  it('诊断写入去重且失败不影响 Monitor；记录可关联 session/turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-diag-write-'))
    const legacyPath = join(dir, 'codex-legacy.jsonl')
    const shadowPath = join(dir, 'codex-shadow.jsonl')
    writeSession('w', [meta('sess-w')])
    prime()
    clock += 1000
    appendSession('w', [eventMsg('task_started', { turn_id: 'tw' })])
    monitor = createMonitor({
      onLegacyDiagnostic: (draft) => appendCodexLegacyDiagnostic(draft, legacyPath),
      onCodexState: (state, migration, meta) =>
        appendCodexShadowDiagnostic(state, migration, shadowPath, {
          observationId: meta?.observationId,
          seq: meta?.seq,
          fileAlias: meta?.fileAlias
        })
    })
    monitor.start()
    monitor.stop()
    clock += 1000
    appendSession('w', [eventMsg('task_complete', { turn_id: 'tw' })])
    monitor.scanNow()
    monitor.scanNow()
    const legacyLines = readFileSync(legacyPath, 'utf8').trim().split('\n').filter(Boolean)
    const shadowLines = readFileSync(shadowPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(legacyLines.length).toBeGreaterThan(0)
    expect(shadowLines.length).toBeGreaterThan(0)
    expect(new Set(legacyLines).size).toBe(legacyLines.length)
    const legacyRec = JSON.parse(legacyLines.at(-1) ?? '{}') as { sessionKey?: string; observationId?: string }
    const shadowRec = JSON.parse(shadowLines.at(-1) ?? '{}') as {
      sessionId?: string
      observationId?: string
      turnId?: string
    }
    expect(legacyRec.sessionKey).toMatch(/^sess-/)
    expect(shadowRec.sessionId).toMatch(/^sess-/)
    expect(shadowRec.turnId).toMatch(/^turn-/)
    expect(JSON.stringify(legacyRec)).not.toContain('sess-w')
    expect(dispatched.some((e) => e.kind === 'done' || e.kind === 'working')).toBe(true)
  })

  it('候选诊断写入后旧 onEvent / 桌宠动作不变；重复 migration 不重复写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-candidate-shadow-'))
    const candidatePath = join(dir, 'codex-candidate.jsonl')
    writeSession('cand', [meta('sess-cand')])
    prime()
    clock += 1000
    appendSession('cand', [eventMsg('task_started', { turn_id: 'tc' })])
    monitor = createMonitor({
      onCodexState: (state, migration, meta) =>
        appendCodexCandidateDiagnostic(state, migration, candidatePath, {
          observationId: meta?.observationId,
          seq: meta?.seq,
          fileAlias: meta?.fileAlias
        })
    })
    monitor.start()
    monitor.stop()
    clock += 1000
    appendSession('cand', [eventMsg('task_complete', { turn_id: 'tc' })])
    monitor.scanNow()
    const beforePets = [...petActions]
    const firstLines = readFileSync(candidatePath, 'utf8').trim().split('\n').filter(Boolean)
    expect(firstLines.length).toBeGreaterThan(0)
    const rec = JSON.parse(firstLines.at(-1) ?? '{}') as {
      userVisible?: boolean
      shouldNotify?: boolean
      observationSource?: string
      candidatePetState?: string
    }
    expect(rec.userVisible).toBe(false)
    expect(rec.shouldNotify).toBe(false)
    expect(rec.observationSource).toBe('session_jsonl')
    expect(rec.candidatePetState).toBeDefined()
    expect(dispatched.some((e) => e.kind === 'done')).toBe(true)
    monitor.scanNow()
    const secondLines = readFileSync(candidatePath, 'utf8').trim().split('\n').filter(Boolean)
    expect(secondLines).toEqual(firstLines)
    expect(petActions).toEqual(beforePets)
  })

  it('eventTime 与 observedAt 分离，缺失时 eventTime 为 null', () => {
    const eventTime = NOW - 60_000
    writeSession('times', [
      {
        timestamp: new Date(eventTime).toISOString(),
        type: 'session_meta',
        payload: { session_id: 'sess-time', originator: 'codex_cli', source: 'cli' }
      }
    ])
    prime()
    clock = NOW + 5_000
    appendSession('times', [
      {
        timestamp: new Date(eventTime).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't-time' }
      }
    ])
    monitor.scanNow()
    const mig = shadowMigrations.at(-1)
    expect(mig).toBeTruthy()
    expect(mig?.eventTime).toBe(eventTime)
    expect(mig?.observedAt).toBe(clock)
    expect(mig?.eventTime).not.toBe(mig?.observedAt)
    const rec = formatCodexLegacyDiagnostic(legacyDrafts[0]!)
    expect(rec.eventTime).toBe(eventTime)
    expect(rec.observedAt).toBe(clock)
    expect(rec.threadId).toBe('unknown')
    expect(rec.turnId).toBe('unknown')
    expect(rec.correlationLevel).toBe('session')
    const shadowRec = formatCodexShadowDiagnostic(shadowStates.at(-1)!, mig)
    expect(shadowRec.eventTime).toBe(eventTime)
    expect(shadowRec.observedAt).toBe(clock)
    expect(shadowRec.migrationObservedAt).toBe(clock)
    expect(shadowRec.eventTime).not.toBe(shadowRec.observedAt)
  })

  it('缺失 threadId/turnId 时保留 unknown，不从 sessionKey 猜造', () => {
    writeSession('noid', [meta('sess-noid')])
    prime()
    clock += 1000
    appendSession('noid', [eventMsg('task_started')])
    monitor.scanNow()
    const snap = monitor.getCodexShadowSnapshots().find((s) => s.filePath.endsWith('noid.jsonl'))
    expect(snap?.state.turnId).toBeUndefined()
    expect(snap?.state.threadId).toBeUndefined()
    const legacy = formatCodexLegacyDiagnostic(legacyDrafts[0]!)
    expect(legacy.threadId).toBe('unknown')
    expect(legacy.turnId).toBe('unknown')
    expect(legacy.sessionKey).toMatch(/^sess-/)
    expect(legacy.sessionKey).not.toBe('noid')
  })

  it('Claude/Cursor/Grok 事件不写入 codex-legacy.jsonl，且 onEvent 仍派发', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-legacy-iso-'))
    const legacyPath = join(dir, 'codex-legacy.jsonl')
    writeSession('keep', [meta('sess-keep')])
    prime()
    clock += 1000
    const others: AgentMonitorEvent[] = [
      {
        id: 'claude-1',
        source: 'claude',
        env: 'terminal',
        sessionKey: 'claude:sess',
        kind: 'working',
        message: 'claude working',
        timestampMs: clock
      },
      {
        id: 'cursor-1',
        source: 'cursor',
        env: 'vscode',
        sessionKey: 'cursor:sess',
        kind: 'done',
        message: 'cursor done',
        timestampMs: clock
      },
      {
        id: 'grok-1',
        source: 'grok',
        env: 'desktop',
        sessionKey: 'grok:sess',
        kind: 'working',
        message: 'grok working',
        timestampMs: clock
      }
    ]
    monitor = createMonitor({
      onLegacyDiagnostic: (draft) => appendCodexLegacyDiagnostic(draft, legacyPath)
    })
    monitor.start()
    monitor.stop()
    dispatched = []
    legacyDrafts = []
    petActions = []
    for (const event of others) monitor.ingest(event, false)
    expect(dispatched.map((e) => e.source)).toEqual(['claude', 'cursor', 'grok'])
    expect(petActions).toEqual(['pet:working', 'pet:done', 'pet:working'])
    expect(legacyDrafts).toEqual([])
    expect(() => readFileSync(legacyPath, 'utf8')).toThrow()
    appendCodexLegacyDiagnostic(
      {
        observationId: 'legacy:claude-pollute',
        seq: 99,
        observedAt: clock,
        eventTime: clock,
        source: 'claude',
        env: 'terminal',
        legacyKind: 'working',
        sessionKey: 'claude:sess',
        dispatched: true,
        ignoredBy: [],
        productionVisible: true
      },
      legacyPath
    )
    expect(() => readFileSync(legacyPath, 'utf8')).toThrow()
  })

  it('诊断写入失败不影响 onEvent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-diag-fail-'))
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'file')
    const legacyPath = join(blocked, 'codex-legacy.jsonl')
    const shadowPath = join(blocked, 'codex-shadow.jsonl')
    writeSession('failwrite', [meta('sess-failwrite')])
    prime()
    clock += 1000
    appendSession('failwrite', [eventMsg('task_started', { turn_id: 'tf' })])
    monitor = createMonitor({
      onLegacyDiagnostic: (draft) => appendCodexLegacyDiagnostic(draft, legacyPath),
      onCodexState: (state, migration, meta) =>
        appendCodexShadowDiagnostic(state, migration, shadowPath, {
          observationId: meta?.observationId,
          seq: meta?.seq,
          fileAlias: meta?.fileAlias
        })
    })
    monitor.start()
    monitor.stop()
    dispatched = []
    petActions = []
    clock += 1000
    appendSession('failwrite', [eventMsg('task_complete', { turn_id: 'tf' })])
    expect(() => monitor.scanNow()).not.toThrow()
    expect(dispatched.some((e) => e.kind === 'done')).toBe(true)
    expect(petActions).toContain('pet:done')
  })
})
