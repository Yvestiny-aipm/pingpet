import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { grokPersistenceDir, scanGrok } from './grok'

/**
 * Grok Bot 没有「回合结束」硬信号，状态全靠 roster 字段 + 文件 mtime 推。
 * 这类靠跨轮状态机推出来的判定最容易被改坏，且坏了只表现为「不提醒 / 重复提醒」。
 *
 * 注意：scanGrok 有模块级状态（botStates），下面每个 it 都是「连续几轮扫描」的模拟，
 * 依赖 vitest 的文件级隔离保证互不污染。
 */

let dir: string
let clock = 1_700_000_000_000
const BOT = 'bot-abc'
const ACCOUNT = 'acct-1'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** 文件名是存储键的 base32（小写无 padding），和 grok.ts 里的解码互为逆运算 */
function encodeStorageKey(key: string): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of Buffer.from(key, 'utf8')) {
    value = ((value << 8) | byte) >>> 0
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
      value &= (1 << bits) - 1
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function blobPath(key: string): string {
  return join(dir, `${encodeStorageKey(key)}.blob`)
}

function writeSlice(key: string, value: unknown, mtimeSec?: number): void {
  const path = blobPath(key)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, value }))
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
}

interface RosterOpts {
  unreadCount?: number
  awaiting?: { reason?: string } | null
  lastActivityAt?: number
  botId?: string
}

function writeRoster(opts: RosterOpts = {}): void {
  writeSlice(`sand.client.slice.account.${ACCOUNT}.roster.last-roster`, {
    rows: [
      {
        id: opts.botId ?? BOT,
        name: '小助手',
        unreadCount: opts.unreadCount ?? 0,
        awaitingUserResponse: opts.awaiting ?? null,
        lastActivityAt: opts.lastActivityAt ?? clock - 5_000
      }
    ]
  })
}

/** 写 Bot 会话；mtimeSec 显式给定，用来精确控制「有没有新动静」 */
function writeTranscript(botText: string, mtimeSec: number, botId = BOT): void {
  writeSlice(
    `sand.client.slice.account.${ACCOUNT}.transcript.replicas.${botId}`,
    {
      entries: [
        { kind: 'message', role: 'user', content: '帮我看下这个 bug' },
        { kind: 'send-message', message: { type: 'text', content: botText } }
      ]
    },
    mtimeSec
  )
}

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-grok-test-'))
  dir = grokPersistenceDir()
  mkdirSync(dir, { recursive: true })
  clock = 1_700_000_000_000
})

describe('基线（首轮不补发历史）', () => {
  it('第一次见到某个 Bot 只记基线，不产出任何事件', () => {
    writeRoster({ unreadCount: 3 })
    writeTranscript('早就发过的消息', 1_699_000_000)
    expect(scanGrok(clock)).toEqual([])
  })

  it('基线之后若一直没动静，也不会对静止的老会话补发提醒', () => {
    writeRoster({ unreadCount: 3 })
    writeTranscript('早就发过的消息', 1_699_000_000)
    scanGrok(clock)
    expect(scanGrok(clock + 1000)).toEqual([])
  })
})

describe('正在干活', () => {
  it('会话文件 mtime 变化 → working，时间戳用 now 以便思考态续期', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)

    writeTranscript('第二段', 1_699_000_100)
    const events = scanGrok(clock + 1000)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('working')
    expect(events[0].timestampMs).toBe(clock + 1000)
    expect(events[0].env).toBe('desktop')
    expect(events[0].sessionKey).toBe(`grok:${BOT}`)
  })
})

describe('回你了（unreadCount）', () => {
  it('活动过、mtime 稳定且有未读 → done，正文取 send-message 里 Bot 说的话', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock) // 基线

    writeTranscript('修好了，已经提交', 1_699_000_100)
    expect(scanGrok(clock + 1000)[0].kind).toBe('working') // 见到活动

    writeRoster({ unreadCount: 1, lastActivityAt: clock + 1500 })
    const events = scanGrok(clock + 2000)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('done')
    expect(events[0].reason).toBe('completed')
    expect(events[0].message).toBe('修好了，已经提交')
  })

  it('终态在多轮里时间戳保持不变，交给 monitor 去重后只提醒一次', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('修好了', 1_699_000_100)
    scanGrok(clock + 1000)

    writeRoster({ unreadCount: 1, lastActivityAt: clock + 1500 })
    const a = scanGrok(clock + 2000)[0]
    const b = scanGrok(clock + 3000)[0]
    expect(a.kind).toBe('done')
    expect(b.timestampMs).toBe(a.timestampMs)
    expect(b.message).toBe(a.message)
  })

  it('未读为 0 → 不产出终态', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('还在写', 1_699_000_100)
    scanGrok(clock + 1000)

    writeRoster({ unreadCount: 0 })
    expect(scanGrok(clock + 2000)).toEqual([])
  })
})

describe('等你批准（awaitingUserResponse）', () => {
  it('awaitingUserResponse 有值 → needs_attention，reason 进 detail', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('要不要我合并这个 PR', 1_699_000_100)
    scanGrok(clock + 1000)

    writeRoster({ awaiting: { reason: '等待合并授权' }, lastActivityAt: clock + 1500 })
    const events = scanGrok(clock + 2000)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('needs_attention')
    expect(events[0].reason).toBe('needs_input')
    expect(events[0].detail).toBe('等待合并授权')
  })

  it('等你批准优先于未读（同时成立时只报需要你）', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('要不要我合并', 1_699_000_100)
    scanGrok(clock + 1000)

    writeRoster({ unreadCount: 5, awaiting: {}, lastActivityAt: clock + 1500 })
    const events = scanGrok(clock + 2000)
    expect(events.map((e) => e.kind)).toEqual(['needs_attention'])
  })

  it('未读且正文明确在等你拍板 → 改判 needs_attention', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('两个方案我都写好了，请选择一个再继续', 1_699_000_100)
    scanGrok(clock + 1000)

    writeRoster({ unreadCount: 1, lastActivityAt: clock + 1500 })
    expect(scanGrok(clock + 2000)[0].kind).toBe('needs_attention')
  })
})

describe('健壮性', () => {
  it('没装 Grok Bot（目录为空）时返回空', () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-grok-empty-'))
    expect(scanGrok(clock)).toEqual([])
  })

  it('只有 roster 没有会话文件时返回空', () => {
    writeRoster({ unreadCount: 2 })
    expect(scanGrok(clock)).toEqual([])
  })

  it('文件内容坏掉（写入中途）时安静跳过，不抛错', () => {
    writeFileSync(blobPath(`sand.client.slice.account.${ACCOUNT}.roster.last-roster`), '{ "half')
    writeTranscript('x', 1_699_000_000)
    expect(() => scanGrok(clock)).not.toThrow()
    expect(scanGrok(clock)).toEqual([])
  })

  it('Bot 会话被删除后重新出现，重新走基线而不是立刻补发提醒', () => {
    writeRoster()
    writeTranscript('第一段', 1_699_000_000)
    scanGrok(clock)
    writeTranscript('修好了', 1_699_000_100)
    scanGrok(clock + 1000) // 已见过活动

    // 换成另一个 Bot：原 Bot 从 roster 消失，状态应被清理
    writeRoster({ botId: 'bot-other' })
    writeTranscript('新 Bot 的话', 1_699_000_200, 'bot-other')
    scanGrok(clock + 2000)

    // 原 Bot 回来 + 有未读：因为状态已清，这一轮只该记基线、不补发
    writeRoster({ unreadCount: 9, lastActivityAt: clock + 2500 })
    expect(scanGrok(clock + 3000)).toEqual([])
  })
})
