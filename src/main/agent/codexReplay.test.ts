import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_FRESH_MS } from '@shared/defaults'
import {
  discoverCodexSessionFiles,
  explainOldPathOfflineLimits,
  isSensitiveKey,
  redactForReplay,
  redactId,
  replayCodexSessionFile,
  replayNewPathFile,
  replayOldPathFile
} from './codexReplay'

const NOW = 1_700_000_000_000

function iso(at = NOW): string {
  return new Date(at).toISOString()
}

function writeJsonl(dir: string, name: string, lines: unknown[]): string {
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

function sessionLines(sessionId: string, extra: unknown[] = []): unknown[] {
  return [
    {
      timestamp: iso(),
      type: 'session_meta',
      payload: { session_id: sessionId, originator: 'codex_cli', source: 'cli' }
    },
    ...extra
  ]
}

describe('回放入口与脱敏', () => {
  it('真实日志回放入口：能发现本机 session 或明确得到空目录', () => {
    const found = discoverCodexSessionFiles()
    expect(found.rootExists === false || Array.isArray(found.files)).toBe(true)
    expect(found.files.every((f) => /^session-\d{3}$/.test(f.alias))).toBe(true)
    expect(found.files.every((f) => !('path' in f))).toBe(true)
  })

  it('敏感字段脱敏：不保留 prompt/正文/token', () => {
    expect(isSensitiveKey('prompt')).toBe(true)
    expect(isSensitiveKey('api_key')).toBe(true)
    const redacted = redactForReplay(
      { prompt: 'do not leak this task', token: 'sk-secret', type: 'event_msg' },
      ''
    ) as Record<string, string>
    expect(JSON.stringify(redacted)).not.toContain('do not leak')
    expect(JSON.stringify(redacted)).not.toContain('sk-secret')
    expect(redacted.prompt).toBe('string')
    expect(redactId('real-session-id', 'sess')).toMatch(/^sess-/)
    expect(redactId('real-session-id', 'sess')).not.toBe('real-session-id')
  })
})

describe('回放工具：大文件、隔离、跨 turn、未知事件', () => {
  it('大文件分片回放：多 slice 才能读完，结果与一次读完一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-replay-big-'))
    const path = writeJsonl(
      dir,
      'big',
      sessionLines('sess-big', [
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', pad: 'x'.repeat(80) } },
        { timestamp: iso(), type: 'event_msg', payload: { type: 'token_count', info: { pad: 'y'.repeat(80) } } },
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }
      ])
    )
    const chunked = replayNewPathFile(path, { nowMs: NOW, maxBytesPerSlice: 40, maxSlicesPerFile: 64 })
    const once = replayNewPathFile(path, { nowMs: NOW, maxBytesPerSlice: 256_000 })
    expect(chunked.state.lifecycle).toBe('completed_signal')
    expect(once.state.lifecycle).toBe('completed_signal')
    expect(chunked.state.lifecycle).not.toBe('succeeded')
  })

  it('多个 session 隔离：失败不会串到另一个文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-replay-iso-'))
    const a = writeJsonl(
      dir,
      'a',
      sessionLines('sess-a', [
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'ta' } },
        {
          timestamp: iso(),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'ta',
            item: { id: 'x', type: 'CommandExecution', status: 'failed' }
          }
        }
      ])
    )
    const b = writeJsonl(
      dir,
      'b',
      sessionLines('sess-b', [
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'tb' } }
      ])
    )
    const ra = replayCodexSessionFile(a, 'session-001', { nowMs: NOW })
    const rb = replayCodexSessionFile(b, 'session-002', { nowMs: NOW })
    expect(ra.newFinal.cause).toBe('tool_failed')
    expect(rb.newFinal.lifecycle).toBe('running')
    expect(rb.newFinal.cause).not.toBe('tool_failed')
    expect(rb.newFinal.item).not.toBe('failed')
  })

  it('跨 turn item 失败隔离：下一轮第一个 item 不是 partial_failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-replay-turn-'))
    const path = writeJsonl(
      dir,
      'cross',
      sessionLines('sess-cross', [
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
        {
          timestamp: iso(),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 't1',
            item: { id: 'x', type: 'CommandExecution', status: 'failed' }
          }
        },
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
        { timestamp: iso(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
        {
          timestamp: iso(),
          type: 'event_msg',
          payload: {
            type: 'item_started',
            turn_id: 't2',
            item: { id: 'y', type: 'CommandExecution', status: 'in_progress' }
          }
        }
      ])
    )
    const replayed = replayNewPathFile(path, { nowMs: NOW })
    expect(replayed.state.lifecycle).toBe('running')
    expect(replayed.state.item).toBe('running')
    expect(replayed.state.item).not.toBe('partial_failure')
    expect(replayed.rows.some((r) => r.item === 'failed')).toBe(true)
  })

  it('未知事件不会导致错误成功判断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-replay-unk-'))
    const path = writeJsonl(dir, 'unk', [
      { timestamp: iso(), type: 'not-a-real-protocol', payload: { prompt: 'secret task' } },
      'this is not json'
    ])
    const replayed = replayNewPathFile(path, { nowMs: NOW })
    expect(replayed.state.lifecycle).not.toBe('succeeded')
    expect(replayed.state.lifecycle).not.toBe('completed_signal')
    expect(replayed.rows.some((r) => r.eventType === 'unknown' || r.eventType === 'malformed')).toBe(true)
    expect(JSON.stringify(replayed.rows)).not.toContain('secret task')
  })

  it('旧路径无法按生产规则离线回放时，明确降级并记录忽略原因', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-replay-old-'))
    mkdirSync(dir, { recursive: true })
    const stale = NOW - AGENT_EVENT_FRESH_MS - 5_000
    const path = writeJsonl(dir, 'stale', [
      {
        timestamp: new Date(stale).toISOString(),
        type: 'session_meta',
        payload: { session_id: 'sess-stale', originator: 'codex_cli', source: 'cli' }
      },
      {
        timestamp: new Date(stale).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't1' }
      }
    ])
    const events = replayOldPathFile(path, { nowMs: NOW, recentScanPaths: [] })
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.kind).toBe('done')
    expect(events[0]?.ignoredByProduction).toContain('freshness')
    expect(events[0]?.ignoredByProduction).toContain('file_not_in_recent_scan')
    expect(explainOldPathOfflineLimits().some((line) => line.includes('freshness') || line.includes('120'))).toBe(
      true
    )
    const replayed = replayCodexSessionFile(path, 'session-stale', { nowMs: NOW, recentScanPaths: [] })
    const visibleRow = replayed.comparisons.find((row) => row.phase.includes('生产 Monitor'))
    expect(visibleRow?.oldResult).toContain('生产不可见')
    expect(visibleRow?.oldResult).toContain('不能当成无事件')
    expect(visibleRow?.oldResult).not.toMatch(/旧路径无识别事件|旧路径无事件/)
    expect(visibleRow?.userImpact).toContain('生产不可见')
  })

  it('官方 exec_json 回放与默认 session_jsonl 隔离：turn.cancelled 不会混源，也不会几乎无迁移', () => {
    const path = writeJsonl(dirForOfficial(), 'official-cancel', [
      { type: 'thread.started' },
      { type: 'turn.started' },
      { type: 'turn.cancelled' }
    ])
    const asSession = replayNewPathFile(path, { nowMs: NOW })
    expect(asSession.state.lifecycle).not.toBe('cancelled')
    expect(asSession.rows.every((r) => r.eventType !== 'turn.cancelled')).toBe(true)
    expect(asSession.rows.some((r) => r.eventType === 'unknown')).toBe(true)

    const asOfficial = replayNewPathFile(path, { nowMs: NOW, source: 'exec_json' })
    expect(asOfficial.rows.map((r) => r.eventType)).toEqual([
      'thread.started',
      'turn.started',
      'turn.cancelled'
    ])
    expect(asOfficial.state.lifecycle).toBe('cancelled')
    expect(asOfficial.state.lifecycle).not.toBe('failed')
    expect(asOfficial.rows.some((r) => r.reason !== 'unchanged')).toBe(true)
    expect(asOfficial.state.taskSemantics).toBe('not_verified')
  })
})

function dirForOfficial(): string {
  return mkdtempSync(join(tmpdir(), 'pet-replay-official-'))
}
