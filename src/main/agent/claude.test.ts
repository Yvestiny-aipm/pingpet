import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectsRoot, scanClaude } from './claude'

const NOW = 1_700_000_000_000
const iso = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString()

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-claude-test-'))
})

function session(slug: string, file: string, lines: unknown[]): void {
  const dir = join(claudeProjectsRoot(), slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${file}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
}

const assistant = (
  stopReason: string,
  text = '',
  extra: Record<string, unknown> = {},
  offset = 0
): unknown => ({
  timestamp: iso(offset),
  type: 'assistant',
  sessionId: 'sess-1',
  ...extra,
  message: { stop_reason: stopReason, content: [{ type: 'text', text }] }
})

describe('环境判定（entrypoint）', () => {
  it.each([
    ['cli', 'terminal'],
    ['sdk-cli', 'terminal'],
    ['claude-vscode', 'vscode'],
    ['claude-desktop', 'desktop'],
    ['某个没见过的值', 'terminal']
  ])('entrypoint=%s → %s', (entrypoint, env) => {
    session('proj', 'f', [assistant('tool_use', '', { entrypoint })])
    expect(scanClaude(NOW)[0].env).toBe(env)
  })

  it('完全没有 entrypoint 字段 → 兜底 terminal', () => {
    session('proj', 'f', [assistant('tool_use')])
    expect(scanClaude(NOW)[0].env).toBe('terminal')
  })
})

describe('事件映射', () => {
  it('stop_reason=tool_use → working（还在调工具）', () => {
    session('proj', 'f', [assistant('tool_use')])
    expect(scanClaude(NOW)[0].kind).toBe('working')
  })

  it('stop_reason=end_turn 且文本认不出类别 → 兜底 done（最常见情况）', () => {
    session('proj', 'f', [assistant('end_turn', '我看了一下这段逻辑')])
    const e = scanClaude(NOW)[0]
    expect(e.kind).toBe('done')
    expect(e.reason).toBe('completed')
  })

  it('end_turn 且文本明确在等你 → needs_attention', () => {
    session('proj', 'f', [assistant('end_turn', '这一步需要你授权才能继续')])
    expect(scanClaude(NOW)[0].kind).toBe('needs_attention')
  })

  it('end_turn 且文本提到报错 → 仍按这一轮结束，不靠关键词升级失败', () => {
    session('proj', 'f', [assistant('end_turn', '构建失败，报错如下：xxx')])
    const e = scanClaude(NOW)[0]
    expect(e.kind).toBe('done')
    expect(e.reason).toBe('completed')
  })

  it('stop_reason=stop_sequence → done', () => {
    session('proj', 'f', [assistant('stop_sequence', '触发了停止序列')])
    expect(scanClaude(NOW)[0]).toMatchObject({ kind: 'done', reason: 'completed' })
  })

  it('stop_reason=max_tokens → failed/error，detail 说明截断', () => {
    session('proj', 'f', [assistant('max_tokens', '写到一半')])
    const e = scanClaude(NOW)[0]
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('error')
    expect(e.detail).toContain('max_tokens')
  })

  it('assistant isApiErrorMessage → failed/error，优先于 stop_reason', () => {
    session('proj', 'f', [
      assistant('end_turn', '请求失败', {
        isApiErrorMessage: true,
        error: 'auth failed'
      })
    ])
    const e = scanClaude(NOW)[0]
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('error')
    expect(e.detail).toBe('auth failed')
  })

  it('sidechain 子 Agent 的 end_turn 不产出主任务事件', () => {
    session('proj', 'f', [
      assistant('end_turn', '子任务完成', { isSidechain: true }),
      assistant('tool_use', '主任务还在跑')
    ])
    const events = scanClaude(NOW)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('working')
  })

  it('sidechain 子 Agent 的 user / tool_use 也不产出事件', () => {
    session('proj', 'f', [
      {
        timestamp: iso(),
        type: 'user',
        sessionId: 'sess-1',
        isSidechain: true,
        message: { content: '子任务输入' }
      },
      assistant('tool_use', '', { isSidechain: true })
    ])
    expect(scanClaude(NOW)).toEqual([])
  })

  it('system api_error 自动重试中 → working，不提前报错', () => {
    session('proj', 'f', [
      {
        timestamp: iso(),
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        sessionId: 'sess-1',
        retryAttempt: 1,
        maxRetries: 10,
        retryInMs: 584,
        error: 'overloaded'
      }
    ])
    expect(scanClaude(NOW)[0]).toMatchObject({ kind: 'working' })
  })

  it('system api_error 重试耗尽 → failed/error', () => {
    session('proj', 'f', [
      {
        timestamp: iso(),
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        sessionId: 'sess-1',
        retryAttempt: 10,
        maxRetries: 10,
        error: 'overloaded'
      }
    ])
    const e = scanClaude(NOW)[0]
    expect(e.kind).toBe('failed')
    expect(e.reason).toBe('error')
    expect(e.detail).toBe('overloaded')
  })

  it('assistant 的 uuid 用作稳定事件 id', () => {
    session('proj', 'f', [assistant('tool_use', '', { uuid: 'uuid-123' })])
    expect(scanClaude(NOW)[0].id).toBe('claude:uuid-123')
  })

  it('user 行 → working（用户刚发指令，回合在推进）', () => {
    session('proj', 'f', [
      { timestamp: iso(), type: 'user', sessionId: 'sess-1', message: { content: '帮我改一下' } }
    ])
    expect(scanClaude(NOW)[0].kind).toBe('working')
  })

  it('其它类型的行不产出事件', () => {
    session('proj', 'f', [{ timestamp: iso(), type: 'summary', summary: 'xxx' }])
    expect(scanClaude(NOW)).toEqual([])
  })
})

describe('会话标识', () => {
  it('优先用 sessionId，这样同一会话跨文件也能关联', () => {
    session('proj', 'f', [assistant('tool_use')])
    expect(scanClaude(NOW)[0].sessionKey).toBe('claude:sess-1')
  })

  it('没有 sessionId 时退回「项目目录/文件名」', () => {
    session('proj-x', 'file-y', [
      { timestamp: iso(), type: 'assistant', message: { stop_reason: 'tool_use', content: [] } }
    ])
    expect(scanClaude(NOW)[0].sessionKey).toBe('claude:proj-x/file-y.jsonl')
  })

  it('没装 Claude Code 时安静返回空', () => {
    expect(scanClaude(NOW)).toEqual([])
  })
})

describe('省掉白做的工（不生成注定被丢弃的事件）', () => {
  it('早于新鲜窗口的历史回合不再产出事件', () => {
    session('proj', 'f', [
      assistant('end_turn', '很久以前就干完了', {}, -10 * 60_000),
      assistant('tool_use', '', {}, -8 * 60_000)
    ])
    expect(scanClaude(NOW)).toEqual([])
  })

  it('新旧混杂时只留窗口内的，正常提醒不受影响', () => {
    session('proj', 'f', [
      assistant('end_turn', '上个回合干完了', {}, -10 * 60_000),
      assistant('tool_use', '', {}, -3_000),
      assistant('end_turn', '这次也搞定了', {}, -1_000)
    ])
    expect(scanClaude(NOW).map((e) => e.kind)).toEqual(['working', 'done'])
  })

  it('mtime 过老的整个文件被跳过', () => {
    session('proj', 'f', [assistant('tool_use')])
    const path = join(claudeProjectsRoot(), 'proj', 'f.jsonl')
    const sec = (NOW - 30 * 60_000) / 1000
    utimesSync(path, sec, sec)
    expect(scanClaude(NOW)).toEqual([])
  })
})
