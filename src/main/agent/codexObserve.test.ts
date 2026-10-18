import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyJsonlFeedState } from './readJsonl'
import {
  CodexObservationJournal,
  coerceEventTimeMs,
  emptyCodexJsonlFileCursor,
  observeCodexJsonlFile,
  parseCodexObservation,
  summarizePayload
} from './codexObserve'

const NOW = 1_700_000_000_000
const FIXTURES = join(__dirname, 'fixtures', 'codex')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

function execCtx(extra: Record<string, unknown> = {}) {
  return { source: 'exec_json' as const, observedAt: NOW, ...extra }
}

function sessionCtx(extra: Record<string, unknown> = {}) {
  return { source: 'session_jsonl' as const, observedAt: NOW, ...extra }
}

function loadJournal(name: string, source: 'exec_json' | 'session_jsonl' = 'exec_json'): CodexObservationJournal {
  const journal = new CodexObservationJournal()
  journal.observeJsonl(readFixture(name), { source, observedAt: NOW, sourcePath: name })
  return journal
}

describe('官方 exec --json 结构化事件', () => {
  it('正常开始和完成：thread / turn / item 关系能串起来', () => {
    const journal = loadJournal('exec-happy-path.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'item.completed',
      'turn.completed'
    ])
    expect(journal.recorded.every((e) => e.recognized)).toBe(true)
    expect(journal.recorded.every((e) => e.recognition === 'recognized')).toBe(true)
    expect(journal.recorded.every((e) => e.source === 'exec_json')).toBe(true)
    const rel = journal.relations()
    expect(rel.threadIds).toEqual(['thread-happy'])
    expect(rel.itemIds).toEqual(['item_1', 'item_2'])
    expect(journal.recorded[2]?.threadId).toBe('thread-happy')
    expect(journal.recorded[3]?.itemStatus).toBe('completed')
    expect(journal.recorded.some((e) => e.eventType === 'unknown' || e.eventType === 'turn.failed')).toBe(
      false
    )
  })

  it('turn.failed 记为失败事件，不记成完成', () => {
    const journal = loadJournal('exec-turn-failed.jsonl')
    const failed = journal.recorded.find((e) => e.eventType === 'turn.failed')
    expect(failed?.recognized).toBe(true)
    expect(failed?.threadId).toBe('thread-fail')
    expect(JSON.stringify(failed?.payload)).toContain('model stream closed')
    expect(journal.recorded.some((e) => e.eventType === 'turn.completed')).toBe(false)
  })

  it('item 失败后仍继续记录后续 turn 事件，且不升级成 turn.failed', () => {
    const journal = loadJournal('exec-item-failed-then-continue.jsonl')
    const types = journal.recorded.map((e) => e.eventType)
    expect(types).toContain('item.completed')
    expect(types).toContain('item.updated')
    expect(types).toContain('turn.completed')
    expect(types).not.toContain('turn.failed')
    const failedItem = journal.recorded.find(
      (e) => e.itemId === 'item_cmd' && e.eventType === 'item.completed'
    )
    expect(failedItem?.itemStatus).toBe('failed')
    expect(failedItem?.eventType).toBe('item.completed')
    expect(journal.recorded.find((e) => e.itemId === 'item_retry')?.itemStatus).toBeDefined()
  })

  it('error 事件保留原文摘要，不当成成功', () => {
    const journal = loadJournal('exec-error.jsonl')
    const err = journal.recorded.find((e) => e.eventType === 'error')
    expect(err?.recognized).toBe(true)
    expect(err?.recognition).toBe('recognized')
    expect(JSON.stringify(err?.payload)).toContain('unauthorized')
    expect(journal.recorded.some((e) => e.eventType === 'turn.completed')).toBe(false)
  })

  it('官方 fixture：turn.cancelled 被识别为 exec_json 结构化事件，不是 unknown/unsupported', () => {
    const journal = loadJournal('exec-turn-cancelled.redacted.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'turn.cancelled'
    ])
    const cancelled = journal.recorded[2]
    expect(cancelled?.source).toBe('exec_json')
    expect(cancelled?.evidenceOrigin).toBe('codex_exec_json')
    expect(cancelled?.eventType).toBe('turn.cancelled')
    expect(cancelled?.eventType).not.toBe('event_msg.turn_aborted')
    expect(cancelled?.eventType).not.toBe('unknown')
    expect(cancelled?.eventType).not.toBe('unsupported')
    expect(cancelled?.recognized).toBe(true)
    expect(cancelled?.recognition).toBe('recognized')
    expect(cancelled?.threadId).toBeUndefined()
    expect(cancelled?.turnId).toBeUndefined()
    expect(cancelled?.eventTime).toBeUndefined()
  })

  it('同一字符串 turn.cancelled 在 session_jsonl 中不得伪装成官方事件', () => {
    const official = parseCodexObservation({ type: 'turn.cancelled' }, execCtx())
    const local = parseCodexObservation({ type: 'turn.cancelled' }, sessionCtx())
    expect(official.source).toBe('exec_json')
    expect(official.eventType).toBe('turn.cancelled')
    expect(official.recognized).toBe(true)
    expect(local.source).toBe('session_jsonl')
    expect(local.eventType).not.toBe('turn.cancelled')
    expect(local.eventType).toBe('unknown')
    expect(local.recognized).toBe(false)
  })
})

describe('本地 session JSONL / event_msg', () => {
  it('兼容 session_meta、task_started/complete、item_completed、turn_aborted', () => {
    const journal = loadJournal('session-event-msg.jsonl', 'session_jsonl')
    const types = journal.recorded.map((e) => e.eventType)
    expect(types).toEqual([
      'session_meta',
      'event_msg.other',
      'event_msg.task_started',
      'event_msg.item_completed',
      'event_msg.item_completed',
      'event_msg.task_complete',
      'event_msg.other',
      'turn_context',
      'event_msg.turn_aborted'
    ])
    expect(journal.recorded[0]?.sessionId).toBe('sess-1')
    expect(journal.recorded[1]?.threadId).toBe('thread-sess')
    expect(journal.recorded[2]?.turnId).toBe('turn-1')
    expect(journal.recorded[3]?.itemId).toBe('exec-1')
    expect(journal.recorded[3]?.itemStatus).toBe('failed')
    expect(journal.recorded[3]?.itemKind).toBe('CommandExecution')
    expect(journal.recorded[3]?.rawType).toBe('item_completed')
    expect(journal.recorded[3]?.source).toBe('session_jsonl')
    expect(journal.recorded[3]?.evidenceOrigin).toBe('codex_session_jsonl')
    expect(journal.recorded[3]?.parseNote).toContain('session JSONL')
    expect(journal.recorded[5]?.eventType).toBe('event_msg.task_complete')
    expect(journal.recorded[8]?.eventType).toBe('event_msg.turn_aborted')
    expect(journal.recorded[8]?.eventType).not.toBe('turn.cancelled')
    expect(journal.recorded[8]?.source).toBe('session_jsonl')
    expect(journal.recorded.every((e) => e.recognized)).toBe(true)
    expect(journal.relations()).toMatchObject({
      sessionIds: ['sess-1'],
      threadIds: ['thread-sess'],
      turnIds: ['turn-1', 'turn-2'],
      itemIds: ['exec-1', 'msg-1']
    })
  })

  it('顶层下划线 type 不得映射成官方点号事件', () => {
    const aliases = [
      ['thread_started', { thread_id: 't1' }],
      ['turn_started', {}],
      ['turn_completed', {}],
      ['turn_failed', { error: { message: 'x' } }],
      ['turn_cancelled', {}],
      ['item_started', { item: { id: 'i1', type: 'command_execution' } }],
      ['item_updated', { item: { id: 'i1' } }],
      ['item_completed', { item: { id: 'i1', type: 'command_execution', status: 'completed' } }]
    ] as const
    for (const [rawType, extra] of aliases) {
      const event = parseCodexObservation({ type: rawType, ...extra }, execCtx())
      expect(event.eventType, rawType).not.toBe(rawType.replaceAll('_', '.'))
      expect(event.recognized, rawType).toBe(false)
      expect(['unknown', 'unsupported']).toContain(event.eventType)
      expect(event.rawType).toBe(rawType)
    }
  })

  it('event_msg 缺 payload.type 记 unsupported，不丢弃也不当成功', () => {
    const event = parseCodexObservation(
      { type: 'event_msg', payload: { turn_id: 't1' } },
      sessionCtx()
    )
    expect(event.eventType).toBe('unsupported')
    expect(event.recognized).toBe(false)
    expect(event.recognition).toBe('unsupported')
    expect(event.turnId).toBe('t1')
  })
})

describe('重复、乱序、未知、缺字段', () => {
  it('同一条结构化事件重复观察只记录一次', () => {
    const journal = new CodexObservationJournal()
    const raw = { type: 'thread.started', thread_id: 'dup' }
    const first = journal.observe(raw, execCtx())
    const second = journal.observe(raw, execCtx())
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(second.reason).toBe('duplicate')
    expect(first.event.dedupKey).toBe(second.event.dedupKey)
    expect(journal.recorded).toHaveLength(1)
  })

  it('同一 JSONL 行重放按行号去重', () => {
    const journal = new CodexObservationJournal()
    const text = readFixture('exec-happy-path.jsonl')
    journal.observeJsonl(text, { ...execCtx(), sourcePath: 'happy.jsonl' })
    journal.attachFeed(emptyJsonlFeedState())
    const again = journal.observeJsonl(text, { ...execCtx(), sourcePath: 'happy.jsonl' })
    expect(again.every((r) => r.reason === 'duplicate')).toBe(true)
    expect(journal.recorded).toHaveLength(6)
  })

  it('未识别事件以 unknown 保留，且不会被标成 recognized', () => {
    const journal = loadJournal('exec-unknown.jsonl')
    const unknown = journal.recorded.find((e) => e.eventType === 'unknown')
    expect(unknown).toBeTruthy()
    expect(unknown?.recognized).toBe(false)
    expect(unknown?.recognition).toBe('unknown')
    expect(unknown?.rawType).toBe('future.widget')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'unknown',
      'turn.started'
    ])
  })

  it('缺少 thread/turn/item id 的事件仍记录', () => {
    const journal = loadJournal('exec-missing-fields.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'turn.started',
      'item.started',
      'item.completed',
      'error',
      'turn.completed'
    ])
    expect(journal.recorded[0]?.threadId).toBeUndefined()
    expect(journal.recorded[1]?.itemId).toBeUndefined()
    expect(journal.recorded[3]?.eventType).toBe('error')
    expect(journal.recorded.every((e) => e.recognized)).toBe(true)
  })

  it('乱序事件按到达顺序保存，不重排、不丢弃', () => {
    const journal = loadJournal('exec-out-of-order.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'turn.completed',
      'item.completed',
      'turn.started',
      'thread.started'
    ])
    expect(journal.recorded[3]?.threadId).toBe('thread-late')
    // 乱序到达的 turn/item 在 thread.started 之前，不得假装已经有 threadId
    expect(journal.recorded[0]?.threadId).toBeUndefined()
  })
})

describe('JSONL 半行与异常行', () => {
  it('半行先缓冲，补全后才成为一条事件', () => {
    const journal = new CodexObservationJournal()
    const first = journal.observeJsonl('{"type":"thread.started","thread_id":"t-half"', execCtx())
    expect(first).toEqual([])
    expect(journal.leftover).toContain('thread.started')
    expect(journal.recorded).toHaveLength(0)
    const second = journal.observeJsonl('}\n{"type":"turn.started"}\n', execCtx())
    expect(second.map((r) => r.event.eventType)).toEqual(['thread.started', 'turn.started'])
    expect(journal.leftover).toBe('')
  })

  it('flush 未完成的半行记为 partial_line，不丢弃也不当成功', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(readFixture('jsonl-half-line.jsonl'), execCtx())
    expect(journal.recorded.map((e) => e.eventType)).toEqual(['thread.started'])
    expect(journal.leftover.length).toBeGreaterThan(0)
    const flushed = journal.flushLeftover(execCtx())
    expect(flushed?.accepted).toBe(true)
    expect(flushed?.event.eventType).toBe('partial_line')
    expect(flushed?.event.recognized).toBe(false)
    expect(flushed?.event.recognition).toBe('partial')
    expect(flushed?.event.evidenceOrigin).toBe('jsonl_partial')
  })

  it('异常 JSON 行记为 malformed，后续正常行不受影响', () => {
    const journal = loadJournal('jsonl-malformed.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual([
      'thread.started',
      'malformed',
      'turn.started'
    ])
    expect(journal.recorded[1]?.recognized).toBe(false)
    expect(journal.recorded[1]?.recognition).toBe('malformed')
    expect(journal.recorded[1]?.evidenceOrigin).toBe('jsonl_malformed')
    expect(journal.recorded[2]?.eventType).toBe('turn.started')
  })

  it('增量读文件时半行留在 cursor，下一块能拼回去', () => {
    const journal = new CodexObservationJournal()
    const path = join(FIXTURES, 'jsonl-malformed.jsonl')
    const first = observeCodexJsonlFile(path, journal, emptyCodexJsonlFileCursor(), NOW, 40, 'exec_json')
    expect(first.eof === false || journal.recorded.length + (journal.leftover ? 1 : 0) >= 1).toBe(true)
    const second = observeCodexJsonlFile(path, journal, first.cursor, NOW, 256_000, 'exec_json')
    expect(second.eof).toBe(true)
    expect(journal.recorded.some((e) => e.eventType === 'malformed')).toBe(true)
    expect(journal.recorded.some((e) => e.eventType === 'turn.started')).toBe(true)
    expect(journal.recorded.some((e) => e.eventType === 'thread.started')).toBe(true)
  })
})

describe('安全摘要与时间', () => {
  it('超长字段被截断，原始大对象不会原样留下', () => {
    const summary = summarizePayload({
      type: 'session_meta',
      payload: { base_instructions: 'x'.repeat(4000), session_id: 's' }
    }) as Record<string, unknown>
    const payload = summary.payload as Record<string, unknown>
    expect(String(payload.base_instructions).length).toBeLessThan(120)
  })

  it('ISO / 毫秒 / 秒时间都能收', () => {
    expect(coerceEventTimeMs('2026-09-11T08:00:00.000Z')).toBe(Date.parse('2026-09-11T08:00:00.000Z'))
    expect(coerceEventTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(coerceEventTimeMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(coerceEventTimeMs(-1)).toBeUndefined()
  })

  it('无 type 的对象记 unknown', () => {
    const event = parseCodexObservation({ hello: 1 }, execCtx())
    expect(event.eventType).toBe('unknown')
    expect(event.recognized).toBe(false)
  })
})

describe('session id 优先级', () => {
  it('payload session_id 优先于文件名 fallback', () => {
    const event = parseCodexObservation(
      {
        type: 'session_meta',
        payload: { session_id: 'sess-payload', id: 'sess-payload' }
      },
      sessionCtx({ sourcePath: 'rollout-WRONG-NAME.jsonl', fallbackSessionId: 'rollout-WRONG-NAME.jsonl' })
    )
    expect(event.sessionId).toBe('sess-payload')
    expect(event.sourcePath).toBe('rollout-WRONG-NAME.jsonl')
    expect(event.parseNote ?? '').not.toContain('fell back to filename')
  })

  it('读文件时文件名与 payload session_id 不一致，仍用 payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-codex-session-id-'))
    const path = join(dir, 'rollout-WRONG-NAME.jsonl')
    writeFileSync(path, readFixture('session-event-msg.jsonl'))
    const journal = new CodexObservationJournal()
    observeCodexJsonlFile(path, journal, emptyCodexJsonlFileCursor(), NOW)
    expect(journal.recorded[0]?.sessionId).toBe('sess-1')
    expect(journal.recorded[0]?.sourcePath).toBe(path)
    expect(journal.recorded.every((e) => e.sessionId !== 'rollout-WRONG-NAME.jsonl')).toBe(true)
    expect(journal.relations().sessionIds).toEqual(['sess-1'])
  })

  it('没有 payload session_id 时才回退文件名', () => {
    const event = parseCodexObservation(
      { type: 'event_msg', payload: { type: 'token_count' } },
      sessionCtx({ sourcePath: 'orphan.jsonl', fallbackSessionId: 'orphan.jsonl' })
    )
    expect(event.sessionId).toBe('orphan.jsonl')
    expect(event.sourcePath).toBe('orphan.jsonl')
    expect(event.parseNote).toContain('fell back to filename')
  })
})

describe('App Server JSON-RPC 范围', () => {
  it('JSON-RPC 外层不解包成官方事件，记 unsupported', () => {
    const journal = loadJournal('app-server-jsonrpc.jsonl')
    expect(journal.recorded.map((e) => e.eventType)).toEqual(['unsupported', 'thread.started'])
    expect(journal.recorded[0]?.recognized).toBe(false)
    expect(journal.recorded[0]?.recognition).toBe('unsupported')
    expect(journal.recorded[0]?.parseNote).toContain('JSON-RPC')
    expect(journal.recorded[0]?.threadId).toBeUndefined()
    expect(journal.recorded[1]?.threadId).toBe('thread-exec')
  })

  it('params 里即使带着 thread.started 也不算已支持 App Server', () => {
    const event = parseCodexObservation(
      {
        jsonrpc: '2.0',
        method: 'codex/event',
        params: { type: 'thread.started', thread_id: 'hidden' },
        id: 7
      },
      execCtx()
    )
    expect(event.eventType).toBe('unsupported')
    expect(event.threadId).toBeUndefined()
    expect(event.recognized).toBe(false)
  })
})

describe('turn 归属与跨 turn', () => {
  it('已结束或中断的 turn 不得继承给后续缺 turn_id 的事件', () => {
    const journal = loadJournal('session-cross-turn.jsonl', 'session_jsonl')
    expect(journal.recorded.map((e) => [e.eventType, e.turnId ?? null])).toEqual([
      ['session_meta', null],
      ['event_msg.task_started', 'turn-1'],
      ['event_msg.item_completed', 'turn-1'],
      ['event_msg.task_complete', 'turn-1'],
      ['event_msg.item_completed', null],
      ['event_msg.task_started', 'turn-2'],
      ['event_msg.item_completed', 'turn-2'],
      ['event_msg.turn_aborted', 'turn-2'],
      ['event_msg.item_completed', null]
    ])
    expect(journal.recorded[4]?.itemId).toBe('item-late')
    expect(journal.recorded[4]?.turnId).toBeUndefined()
    expect(journal.recorded[8]?.itemId).toBe('item-after-abort')
    expect(journal.recorded[8]?.turnId).toBeUndefined()
  })

  it('官方 turn.started 没有 turn_id 时不得编造，结束后更不能继承', () => {
    const journal = new CodexObservationJournal()
    journal.observeJsonl(
      [
        '{"type":"thread.started","thread_id":"th"}',
        '{"type":"turn.started"}',
        '{"type":"item.started","item":{"id":"i1","type":"command_execution"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
        '{"type":"item.started","item":{"id":"i2","type":"command_execution"}}'
      ].join('\n') + '\n',
      execCtx()
    )
    expect(journal.recorded.map((e) => e.turnId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(journal.recorded.map((e) => e.threadId)).toEqual(['th', 'th', 'th', 'th', 'th'])
  })
})
