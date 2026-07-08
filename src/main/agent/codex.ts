import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  AGENT_MAX_FILES_PER_SOURCE,
  AGENT_SCAN_MAX_DEPTH,
  AGENT_TAIL_BYTES
} from '@shared/defaults'
import type { AgentEnv, AgentEventKind, AgentMonitorEvent, AgentStopReason } from '@shared/types'
import { classifyStopText } from './classify'
import { findRecentFiles } from './findFiles'
import { readJsonlHead, readJsonlTail } from './readJsonl'

/** Codex 会话根目录（只扫 sessions 子树，~/.codex 下还有一堆无关文件） */
export function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions')
}

/** 从 codex message 行的 payload.content 里抽出所有 output_text，合并成一段文本 */
function extractOutputText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>
      // assistant 消息是 output_text；也顺带兼容 text 字段
      if ((it.type === 'output_text' || it.type === 'text') && typeof it.text === 'string') {
        parts.push(it.text)
      }
    }
  }
  return parts.join('\n')
}

/** 从 turn_aborted 等 payload 里尽量摘出一句可读的中断/失败原因 */
function payloadReason(payload: Record<string, unknown>): string | undefined {
  for (const key of ['reason', 'message', 'error', 'detail']) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  return undefined
}

/**
 * 从 codex 会话的 session_meta 推断运行环境。
 *
 * ⚠️ 实测坑（v0.3.3 修）：Codex **客户端** 和 **VS Code** 的 session_meta 里
 * `source` 都是 `'vscode'`，靠 source 分不出这两者；真正区分靠 `originator`：
 *   - 客户端：originator = 'Codex Desktop'
 *   - VS Code：originator 不含 Desktop（如 'Codex VSCode' / 'vscode' 等）
 * 所以判定顺序必须 **originator 优先**，source 只作兜底。
 */
function codexMetaToEnv(payload: Record<string, unknown>): AgentEnv | null {
  // 1. originator 优先（唯一能区分 客户端 vs VS Code 的字段）
  const originator = payload.originator
  if (typeof originator === 'string' && originator) {
    const o = originator.toLowerCase()
    if (o.includes('desktop') || o.includes('app')) return 'desktop'
    if (o.includes('vscode') || o.includes('vs code')) return 'vscode'
    if (o.includes('cli') || o.includes('terminal') || o.includes('tui')) return 'terminal'
  }
  // 2. source 兜底
  const source = payload.source
  if (typeof source === 'string' && source) {
    const s = source.toLowerCase()
    if (s.includes('desktop') || s.includes('app')) return 'desktop'
    if (s.includes('vscode') || s.includes('vs code')) return 'vscode'
    if (s.includes('cli') || s.includes('terminal') || s.includes('tui')) return 'terminal'
  }
  return null
}

function getTimestampMs(line: Record<string, unknown>): number {
  // codex 行常带 ISO 时间戳字段（timestamp / ts），拿不到就用 0（由 monitor 侧兜底）
  const raw = line.timestamp ?? line.ts
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return 0
}

/**
 * 解析单个 codex 会话文件，产出本轮扫到的归一化事件（未去重、未过滤新鲜度）。
 * sessionKey 用文件名，保证同一会话的 working→done 能被 monitor 关联。
 */
function parseCodexFile(filePath: string, nowMs: number): AgentMonitorEvent[] {
  const sessionKey = basename(filePath)
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES)
  const events: AgentMonitorEvent[] = []

  // 环境标识在文件头部的 session_meta 里（tail 读不到），单独读头几行拿 source/originator
  let env: AgentEnv = 'terminal'
  for (const head of readJsonlHead(filePath)) {
    const payload =
      head.payload && typeof head.payload === 'object'
        ? (head.payload as Record<string, unknown>)
        : head
    const e = codexMetaToEnv(payload)
    if (e) {
      env = e
      break
    }
  }

  for (const line of lines) {
    const type = line.type
    const payload =
      line.payload && typeof line.payload === 'object'
        ? (line.payload as Record<string, unknown>)
        : {}
    const payloadType = payload.type
    const tsMs = getTimestampMs(line) || nowMs

    let kind: AgentEventKind | null = null
    let message = ''
    let reason: AgentStopReason | undefined
    let detail: string | undefined

    if (type === 'event_msg') {
      // event_msg 提供最明确的显式信号，优先用它
      switch (payloadType) {
        case 'task_started':
          // 正在干活：发 working 让宠物切 thinking，但不弹气泡
          kind = 'working'
          message = 'Codex 开始处理任务'
          break
        case 'task_complete':
          kind = 'done'
          reason = 'completed'
          message = 'Codex 完成了任务'
          break
        case 'turn_aborted':
          // 被中断：尽量从 payload 里摘出中断原因（reason / message 字段）
          kind = 'failed'
          reason = 'interrupted'
          detail = payloadReason(payload)
          message = 'Codex 任务被中断'
          break
        default:
          break // token_count / agent_message / user_message 不单独成事件
      }
    } else if (type === 'response_item') {
      if (payloadType === 'reasoning' || payloadType === 'function_call') {
        // 正在干活：working（不弹气泡）
        kind = 'working'
        message = 'Codex 正在处理任务'
      } else if (payloadType === 'message' && payload.role === 'assistant') {
        // assistant 说话且能判出「停下原因」时，才当成一次终态提醒
        const text = extractOutputText(payload)
        const classified = classifyStopText(text)
        if (classified) {
          kind = classified.kind
          reason = classified.reason
          detail = classified.detail
          message = text.slice(0, 200)
        }
      }
    }

    if (kind) {
      events.push({
        id: '', // 由 monitor 统一生成稳定 id
        source: 'codex',
        env,
        sessionKey,
        kind,
        message,
        timestampMs: tsMs,
        rawPath: filePath,
        reason,
        detail
      })
    }
  }

  return events
}

/** 扫描所有最近的 codex 会话文件，返回本轮全部归一化事件 */
export function scanCodex(nowMs: number): AgentMonitorEvent[] {
  const files = findRecentFiles(
    codexSessionsRoot(),
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH
  )
  const all: AgentMonitorEvent[] = []
  for (const f of files) {
    all.push(...parseCodexFile(f, nowMs))
  }
  return all
}
