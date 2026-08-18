import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent } from '@shared/types'
import { codexSessionsRoot, scanCodex } from './codex'

/**
 * Codex 这边最关键的是环境判定：客户端和 VS Code 的 session_meta 里 source 都是 'vscode'，
 * 只有 originator 能区分。这个坑修过一次（v0.3.3），必须有测试钉住，否则一旦回退成
 * 「按 source 判断」，用户在设置里关掉 VS Code 档会把客户端的提醒一起关掉。
 */

const NOW = 1_700_000_000_000
const iso = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString()

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-test-'))
  mkdirSync(codexSessionsRoot(), { recursive: true })
})

function session(name: string, lines: unknown[]): void {
  writeFileSync(
    join(codexSessionsRoot(), `${name}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n')
  )
}

const meta = (payload: Record<string, unknown>): unknown => ({
  timestamp: iso(-60_000),
  type: 'session_meta',
  payload: { ...payload }
})
const eventMsg = (type: string, extra: Record<string, unknown> = {}, offset = 0): unknown => ({
  timestamp: iso(offset),
  type: 'event_msg',
  payload: { type, ...extra }
})
const responseItem = (payload: Record<string, unknown>, offset = 0): unknown => ({
  timestamp: iso(offset),
  type: 'response_item',
  payload
})
const assistantMsg = (text: string, offset = 0): unknown =>
  responseItem(
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    offset
  )

function kinds(events: AgentMonitorEvent[]): string[] {
  return events.map((e) => e.kind)
}

describe('环境判定', () => {
  it('originator=Codex Desktop → desktop（即使 source 是 vscode）', () => {
    session('s1', [
      meta({ originator: 'Codex Desktop', source: 'vscode' }),
      eventMsg('task_started')
    ])
    expect(scanCodex(NOW)[0].env).toBe('desktop')
  })

  it('originator=Codex VSCode → vscode', () => {
    session('s1', [meta({ originator: 'Codex VSCode', source: 'vscode' }), eventMsg('task_started')])
    expect(scanCodex(NOW)[0].env).toBe('vscode')
  })

  it('originator=codex_cli → terminal', () => {
    session('s1', [meta({ originator: 'codex_cli', source: 'cli' }), eventMsg('task_started')])
    expect(scanCodex(NOW)[0].env).toBe('terminal')
  })

  it('没有 originator 时用 source 兜底', () => {
    session('s1', [meta({ source: 'vscode' }), eventMsg('task_started')])
    expect(scanCodex(NOW)[0].env).toBe('vscode')
  })

  it('两个字段都读不到 → 兜底 terminal', () => {
    session('s1', [meta({}), eventMsg('task_started')])
    expect(scanCodex(NOW)[0].env).toBe('terminal')
  })
})

describe('事件映射', () => {
  it('task_started → working', () => {
    session('s1', [meta({}), eventMsg('task_started')])
    expect(kinds(scanCodex(NOW))).toEqual(['working'])
  })

  it('task_complete → done/completed', () => {
    session('s1', [meta({}), eventMsg('task_complete')])
    const e = scanCodex(NOW)[0]
    expect(e.kind).toBe('done')
    expect(e.reason).toBe('completed')
  })

  it('turn_aborted → failed/interrupted，并带上中断原因', () => {
    session('s1', [meta({}), eventMsg('turn_aborted', { reason: '用户按了 Esc' })])
    const e = scanCodex(NOW)[0]
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('interrupted')
    expect(e.detail).toBe('用户按了 Esc')
  })

  it('reasoning / function_call → working（还在干活）', () => {
    session('s1', [meta({}), responseItem({ type: 'reasoning' }), responseItem({ type: 'function_call' })])
    expect(kinds(scanCodex(NOW))).toEqual(['working', 'working'])
  })

  it('assistant 文本能判出停下原因时才成为终态事件', () => {
    session('s1', [meta({}), assistantMsg('已完成，改动都提交了')])
    expect(kinds(scanCodex(NOW))).toEqual(['done'])
  })

  it('assistant 文本判不出类别时不产出事件（避免每句话都提醒）', () => {
    session('s1', [meta({}), assistantMsg('嗯，我看一下')])
    expect(scanCodex(NOW)).toEqual([])
  })

  it('token_count 之类的噪声行不产出事件', () => {
    session('s1', [meta({}), eventMsg('token_count', { total: 123 }), eventMsg('agent_message')])
    expect(scanCodex(NOW)).toEqual([])
  })
})

describe('会话与时间戳', () => {
  it('sessionKey 用文件名，同一会话的 working 与终态能关联起来', () => {
    session('s1', [meta({}), eventMsg('task_started'), eventMsg('task_complete', {}, 1000)])
    const events = scanCodex(NOW)
    expect(new Set(events.map((e) => e.sessionKey)).size).toBe(1)
    expect(events[0].sessionKey).toBe('s1.jsonl')
  })

  it('时间戳取行里的 ISO 时间', () => {
    session('s1', [meta({}), eventMsg('task_started', {}, -5_000)])
    expect(scanCodex(NOW)[0].timestampMs).toBe(NOW - 5_000)
  })

  it('没装 Codex（目录不存在）时安静返回空', () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-empty-'))
    expect(scanCodex(NOW)).toEqual([])
  })
})

describe('省掉白做的工（不生成注定被丢弃的事件）', () => {
  it('早于新鲜窗口的历史行不再产出事件', () => {
    session('s1', [
      meta({}),
      eventMsg('task_complete', {}, -10 * 60_000), // 10 分钟前的老回合
      eventMsg('task_started', {}, -8 * 60_000)
    ])
    expect(scanCodex(NOW)).toEqual([])
  })

  it('同一文件里新旧混杂时，只留下窗口内的那几条', () => {
    session('s1', [
      meta({}),
      eventMsg('task_complete', {}, -10 * 60_000),
      eventMsg('task_started', {}, -3_000),
      eventMsg('task_complete', {}, -1_000)
    ])
    expect(kinds(scanCodex(NOW))).toEqual(['working', 'done'])
  })

  it('mtime 过老的整个文件被跳过，连打开都不打开', () => {
    session('stale', [meta({}), eventMsg('task_started')])
    const path = join(codexSessionsRoot(), 'stale.jsonl')
    const sec = (NOW - 30 * 60_000) / 1000
    utimesSync(path, sec, sec)
    expect(scanCodex(NOW)).toEqual([])
  })
})
