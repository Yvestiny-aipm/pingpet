import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent } from '@shared/types'
import { scanCursor } from './cursor'

/**
 * Cursor 的两个脆弱点都在这里兜住：
 *   1. 终态只认「文件最后一行」——这是防重复提醒的唯一机制，一旦回退成「扫全文找
 *      turn_ended」，用户每发一条消息都会被旧终态再提醒一次。
 *   2. 老版本（2026-05/06）不写 turn_ended，靠「末行是纯文本 assistant」兜底，
 *      去掉这条老用户就永远收不到完成提醒。
 */

let home: string
const NOW = 1_700_000_000_000

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pet-cursor-test-'))
  process.env.HOME = home
})

/** 造一个工作区，markers 是要在 project 目录里放的边车文件/目录名 */
function project(slug: string, markers: string[] = ['terminals']): string {
  const dir = join(home, '.cursor', 'projects', slug)
  mkdirSync(join(dir, 'agent-transcripts'), { recursive: true })
  for (const m of markers) {
    if (m.includes('.')) writeFileSync(join(dir, m), 'x')
    else mkdirSync(join(dir, m), { recursive: true })
  }
  return dir
}

/** 在某个工作区里写一个会话文件 */
function session(projectDir: string, sid: string, lines: unknown[], sub = false): void {
  const base = join(projectDir, 'agent-transcripts', ...(sub ? ['subagents'] : []), sid)
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
}

const userLine = (text: string): unknown => ({
  role: 'user',
  message: { content: [{ type: 'text', text }] }
})
const assistantText = (text: string): unknown => ({
  role: 'assistant',
  message: { content: [{ type: 'text', text }] }
})
const assistantTool = (): unknown => ({
  role: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'edit_file', input: {} }] }
})
const turnEnded = (status: string, error?: string): unknown => ({
  type: 'turn_ended',
  status,
  ...(error ? { error } : {})
})

function scanOne(): AgentMonitorEvent {
  const events = scanCursor(NOW)
  expect(events).toHaveLength(1)
  return events[0]
}

describe('回合结束判定', () => {
  it('末行是 turn_ended/success → done', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [userLine('改一下'), assistantText('改好了'), turnEnded('success')])
    const e = scanOne()
    expect(e.kind).toBe('done')
    expect(e.reason).toBe('completed')
    expect(e.message).toBe('改好了')
  })

  it('末行是 turn_ended/aborted → failed/interrupted', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [userLine('改一下'), assistantText('改到一半'), turnEnded('aborted', '用户取消')])
    const e = scanOne()
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('interrupted')
    expect(e.detail).toBe('用户取消')
  })

  it('末行是 turn_ended/error → failed/error', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [assistantText('出问题了'), turnEnded('error', 'tool crashed')])
    const e = scanOne()
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('error')
  })

  it('turn_ended 之后又有新行 → 只报 working，不重复提醒旧终态', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [
      assistantText('改好了'),
      turnEnded('success'),
      userLine('再改一处') // 用户发了下一条：mtime 变了，但旧终态不该再提醒一次
    ])
    expect(scanOne().kind).toBe('working')
  })

  it('末行 assistant 带 tool_use → working（还在调工具）', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [userLine('改一下'), assistantTool()])
    expect(scanOne().kind).toBe('working')
  })

  it('老版本无 turn_ended：末行是纯文本 assistant → done', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [userLine('讲一下'), assistantTool(), assistantText('讲完了')])
    const e = scanOne()
    expect(e.kind).toBe('done')
    expect(e.message).toBe('讲完了')
  })

  it('success 但文本明确在等用户 → 改判 needs_attention', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [
      assistantText('这一步需要你授权：是否允许我删掉这个目录？'),
      turnEnded('success')
    ])
    expect(scanOne().kind).toBe('needs_attention')
  })
})

describe('环境推断', () => {
  it('只有 CLI 边车文件 → terminal', () => {
    const p = project('proj-cli', ['worker.log', 'repo.json'])
    session(p, 'sid-1', [assistantText('done'), turnEnded('success')])
    expect(scanOne().env).toBe('terminal')
  })

  it('有桌面标记目录 → desktop', () => {
    const p = project('proj-app', ['terminals', 'mcps'])
    session(p, 'sid-1', [assistantText('done'), turnEnded('success')])
    expect(scanOne().env).toBe('desktop')
  })

  it('两类标记都有（同一工作区既开过客户端又跑过 CLI）→ 归 desktop', () => {
    const p = project('proj-both', ['worker.log', 'terminals'])
    session(p, 'sid-1', [assistantText('done'), turnEnded('success')])
    expect(scanOne().env).toBe('desktop')
  })

  it('什么标记都没有 → 兜底 desktop', () => {
    const p = project('proj-bare', [])
    session(p, 'sid-1', [assistantText('done'), turnEnded('success')])
    expect(scanOne().env).toBe('desktop')
  })
})

describe('扫描范围', () => {
  it('子 Agent 的分支记录不产出事件（它结束不等于用户的任务结束）', () => {
    const p = project('proj-a')
    session(p, 'sub-1', [assistantText('子任务完成'), turnEnded('success')], true)
    expect(scanCursor(NOW)).toHaveLength(0)
  })

  it('多个工作区的会话都能扫到，sessionKey 用会话 id', () => {
    session(project('proj-a'), 'sid-a', [assistantText('a'), turnEnded('success')])
    session(project('proj-b'), 'sid-b', [assistantText('b'), turnEnded('success')])
    const keys = scanCursor(NOW)
      .map((e) => e.sessionKey)
      .sort()
    expect(keys).toEqual(['cursor:sid-a', 'cursor:sid-b'])
  })

  it('没装 Cursor（目录不存在）时安静返回空，不抛错', () => {
    expect(scanCursor(NOW)).toEqual([])
  })

  it('空会话文件不产出事件', () => {
    const p = project('proj-a')
    session(p, 'sid-1', [])
    expect(scanCursor(NOW)).toEqual([])
  })

  it('mtime 过老的会话被跳过（Cursor 用 mtime 当事件时间，老文件必然过期）', () => {
    const p = project('proj-a')
    session(p, 'sid-old', [assistantText('很久以前完成的'), turnEnded('success')])
    const path = join(p, 'agent-transcripts', 'sid-old', 'sid-old.jsonl')
    const sec = (NOW - 30 * 60_000) / 1000
    utimesSync(path, sec, sec)
    expect(scanCursor(NOW)).toEqual([])
  })
})
