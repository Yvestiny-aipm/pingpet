import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentMonitorEvent } from '@shared/types'
import { classifyStopText } from './classify'

/**
 * Grok Bot（Anysphere 出品，Bundle ID com.anysphere.sand，用 Cursor 账号登录）的本地状态目录。
 *
 * 只有客户端这一个环境可监听：官方平台仅 macOS / Windows 桌面端 + iOS，
 * 没有 CLI、没有 IDE 插件、没有网页版。iOS 上派的活会同步到桌面端的同一份文件，
 * 所以只要客户端开着，手机端发起的任务也一并覆盖。
 */
export function grokPersistenceDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence')
}

/**
 * 目录里的文件名是「存储键」的 base32（RFC 4648 小写、无 padding），后缀 .blob 但内容是明文 JSON：
 *   sand.client.slice.account.<账号>.transcript.replicas.<botId>  单个 Bot 的完整会话
 *   sand.client.slice.account.<账号>.roster.last-roster           Bot 列表 + 每个 Bot 的状态
 */
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function decodeStorageKey(name: string): string | null {
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of name) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    value = ((value << 5) | idx) >>> 0
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 每个 slice 文件都是 { schemaVersion, value }，只认得的 schemaVersion 才用 */
function readSlice(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const value = (parsed as Record<string, unknown>).value
    if (!value || typeof value !== 'object') return null
    return value as Record<string, unknown>
  } catch {
    return null // 正在被写 / 格式变了：这一轮跳过，下一轮再来
  }
}

/** roster 里的一行 = 一个 Bot。只列出我们真正读的字段，其余忽略 */
interface RosterRow {
  id: string
  name: string
  /** 有值 = Bot 卡住在等你（授权 / 回答 / 确认），reason 是它等的原因 */
  awaitingReason: string | null
  /** 未读条数：Bot 给你发了东西而你还没看 */
  unreadCount: number
  /** 该会话最后一次活动时间（Bot 发言、你发言都算） */
  lastActivityAt: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * awaitingUserResponse 在客户端模型里是对象（{ reason, ... }）而不是布尔，闲置时为 null。
 * 这里只取 reason 当细节文案；对象存在但没 reason 也照样算「在等你」。
 */
function awaitingReasonOf(row: Record<string, unknown>): string | null {
  const raw = row.awaitingUserResponse
  if (!raw || typeof raw !== 'object') return null
  const reason = (raw as Record<string, unknown>).reason
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 80) : ''
}

function parseRoster(filePath: string): RosterRow[] {
  const value = readSlice(filePath)
  const rows = value?.rows
  if (!Array.isArray(rows)) return []
  const out: RosterRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = asString(row.id)
    if (!id) continue
    out.push({
      id,
      name: asString(row.name) || asString(row.title) || 'Bot',
      awaitingReason: awaitingReasonOf(row),
      unreadCount: asNumber(row.unreadCount),
      lastActivityAt: asNumber(row.lastActivityAt) || asNumber(row.updatedAt)
    })
  }
  return out
}

/**
 * 从会话里取「Bot 最近说的一段话」，用于气泡正文 / AI 总结 / 文本兜底分类。
 *
 * 注意 Grok Bot 的存法和另外三家都不一样：Bot 回复**你**的内容在 send-message 条目里
 * （message.{type,content}，type 可能是 text / widget / attachment / cursor-agent）；
 * 而 kind==='message' 且带 fromAgent / toAgent 的，是 Bot 之间互相发的消息，不是给你的。
 */
function lastBotText(filePath: string): string {
  const value = readSlice(filePath)
  const entries = value?.entries
  if (!Array.isArray(entries)) return ''
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.kind === 'send-message') {
      const msg = e.message
      if (msg && typeof msg === 'object') {
        const m = msg as Record<string, unknown>
        if (m.type === 'text') {
          const text = asString(m.content).trim()
          if (text) return text
        }
      }
      continue
    }
    // 退路：没有 send-message 时用 Bot 发给别的 Bot 的最后一段话，总比空白强
    if (e.kind === 'message' && e.role === 'assistant') {
      const text = asString(e.content).trim()
      if (text) return text
    }
  }
  return ''
}

/** 单个 Bot 的跨轮状态。scanGrok 每秒被调一次，靠它判断「这一轮有没有新动静」 */
interface BotState {
  /** 上一轮看到的会话文件 mtime */
  mtimeMs: number
  /** 是否见过真实活动（首轮只记录基线，不算活动，避免启动时把历史会话当新事件） */
  activitySeen: boolean
}

const botStates = new Map<string, BotState>()

/** 正文缓存：会话文件动辄几百 KB，mtime 没变就不重复解析 */
const textCache = new Map<string, { mtimeMs: number; text: string }>()

function cachedLastBotText(filePath: string, mtimeMs: number): string {
  const hit = textCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.text
  const text = lastBotText(filePath)
  textCache.set(filePath, { mtimeMs, text })
  return text
}

interface Discovered {
  rosterPath: string | null
  /** botId -> 该 Bot 的会话文件路径 */
  transcripts: Map<string, string>
}

/** 扫一遍目录，把文件名解码回存储键，分出 roster 和各 Bot 的会话文件 */
function discover(dir: string): Discovered {
  const out: Discovered = { rosterPath: null, transcripts: new Map() }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out // 没装 Grok Bot / 目录不可读：安静返回
  }
  for (const name of names) {
    if (!name.endsWith('.blob')) continue
    const key = decodeStorageKey(name.slice(0, -'.blob'.length))
    if (!key) continue
    if (key.endsWith('.roster.last-roster')) {
      out.rosterPath = join(dir, name)
      continue
    }
    const marker = '.transcript.replicas.'
    const at = key.indexOf(marker)
    if (at >= 0) {
      const botId = key.slice(at + marker.length)
      if (botId) out.transcripts.set(botId, join(dir, name))
    }
  }
  return out
}

function mtimeOf(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

/**
 * 扫描 Grok Bot，返回本轮全部归一化事件。
 *
 * 和另外三家最大的区别：Grok Bot 没有 turn_ended 这类「回合结束」硬信号——Bot 是常驻的
 * 云端同事，会一直往会话里追加进展。所以状态改判到 roster 上，用它自己的两个字段：
 *
 *   awaitingUserResponse ≠ null → needs_attention（Bot 卡住在等你，这正是 Grok Bot
 *                                 「只在需要你批准时才回来找你」的产品语义）
 *   unreadCount > 0              → done（Bot 给你发了新东西且你还没看）
 *   会话文件 mtime 变化           → working（Bot 正在往里写，保持思考态）
 *
 * 时间戳选择：working 用 now（每轮 id 都变，思考态才能被持续续期），终态用
 * lastActivityAt（同一条消息 id 稳定 → monitor 去重后只提醒一次）。
 *
 * 终态一律推迟到「见过活动之后的下一轮」才发：monitor 会把同一轮的事件按时间戳排序，
 * 而终态的 lastActivityAt 必然早于 working 的 now，同轮发出会让终态排在 working 前面、
 * 撞上「终态需先见过 working」的规则被丢弃且再不补发。延迟一轮（1 秒）代价可忽略。
 */
export function scanGrok(nowMs: number): AgentMonitorEvent[] {
  const dir = grokPersistenceDir()
  const { rosterPath, transcripts } = discover(dir)
  if (!rosterPath || transcripts.size === 0) return []

  const rows = parseRoster(rosterPath)
  if (rows.length === 0) return []

  const events: AgentMonitorEvent[] = []
  const alive = new Set<string>()

  for (const row of rows) {
    const filePath = transcripts.get(row.id)
    if (!filePath) continue
    const mtimeMs = mtimeOf(filePath)
    if (mtimeMs === null) continue
    alive.add(row.id)

    const prev = botStates.get(row.id)
    // 首次见到这个 Bot：只记基线，不产出任何事件（否则启动时历史会话会全被当成新消息）
    if (!prev) {
      botStates.set(row.id, { mtimeMs, activitySeen: false })
      continue
    }

    const base = {
      id: '',
      source: 'grok' as const,
      env: 'desktop' as const,
      sessionKey: `grok:${row.id}`,
      rawPath: filePath
    }

    if (mtimeMs !== prev.mtimeMs) {
      botStates.set(row.id, { mtimeMs, activitySeen: true })
      events.push({
        ...base,
        kind: 'working',
        message: `${row.name} 正在处理任务`,
        timestampMs: nowMs
      })
      continue
    }

    // 没新动静：只有先前见过活动的 Bot 才评估终态，避免对启动前就静止的老会话补发提醒
    if (!prev.activitySeen) continue

    const body = cachedLastBotText(filePath, mtimeMs)
    const timestampMs = row.lastActivityAt || mtimeMs

    if (row.awaitingReason !== null) {
      events.push({
        ...base,
        kind: 'needs_attention',
        message: body.slice(0, 200),
        timestampMs,
        reason: 'needs_input',
        detail: row.awaitingReason || undefined
      })
      continue
    }

    if (row.unreadCount > 0) {
      // Bot 回你了。文本里若明确还在等你拍板，改判 needs_attention——
      // awaitingUserResponse 只在它走正式审批框时才置位，自由文本里的提问不会置位。
      const classified = classifyStopText(body)
      if (classified && classified.kind === 'needs_attention') {
        events.push({
          ...base,
          kind: 'needs_attention',
          message: body.slice(0, 200),
          timestampMs,
          reason: 'needs_input',
          detail: classified.detail
        })
      } else {
        events.push({
          ...base,
          kind: 'done',
          message: body.slice(0, 200),
          timestampMs,
          reason: 'completed'
        })
      }
    }
  }

  // 会话被删掉后清掉状态，别让 Map 无限长
  for (const id of [...botStates.keys()]) {
    if (!alive.has(id)) botStates.delete(id)
  }
  return events
}
