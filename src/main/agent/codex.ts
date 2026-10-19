import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  AGENT_EVENT_FRESH_MS,
  AGENT_FILE_FRESH_MS,
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

export type CodexLegacySignalVia =
  | 'event_msg.task_started'
  | 'event_msg.task_complete'
  | 'event_msg.turn_aborted'
  | 'response_item.reasoning'
  | 'response_item.function_call'
  | 'response_item.assistant_text'

/** 旧路径对单行 session JSONL 的分类。回放可复用；不改变 scanCodex 语义。 */
export interface CodexLegacySignal {
  kind: AgentEventKind
  reason?: AgentStopReason
  detail?: string
  via: CodexLegacySignalVia
  timestampMs: number
}

export function getCodexLineTimestampMs(line: Record<string, unknown>): number {
  // codex 行常带 ISO 时间戳字段（timestamp / ts），拿不到就用 0（由 monitor 侧兜底）
  const raw = line.timestamp ?? line.ts
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return 0
}

export interface ClassifyCodexLegacyLineOptions {
  /**
   * 仅回放 / 历史报告用：复现修复前「assistant 正文可判终态」的行为。
   * 生产扫描不得打开——长任务里“第一步完成了，接下来……”极常见，
   * 由正文触发 done 会在任务中途误报结束。
   */
  allowAssistantTextTerminal?: boolean
}

/**
 * 旧路径单行判定（与 parseCodexFile 同一套规则）。
 * 回放不得把 assistant 正文带出；调用方如需气泡文案，仍由 parseCodexFile 本地拼。
 *
 * 终态只认结构化事件：task_complete / turn_aborted。
 * assistant 正文默认不产出任何事件；只有回放显式打开选项时才复现旧行为。
 */
export function classifyCodexLegacyLine(
  line: Record<string, unknown>,
  options: ClassifyCodexLegacyLineOptions = {}
): CodexLegacySignal | null {
  const type = line.type
  const payload =
    line.payload && typeof line.payload === 'object' ? (line.payload as Record<string, unknown>) : {}
  const payloadType = payload.type
  const timestampMs = getCodexLineTimestampMs(line)

  if (type === 'event_msg') {
    switch (payloadType) {
      case 'task_started':
        return { kind: 'working', via: 'event_msg.task_started', timestampMs }
      case 'task_complete':
        return { kind: 'done', reason: 'completed', via: 'event_msg.task_complete', timestampMs }
      case 'turn_aborted':
        return {
          kind: 'failed',
          reason: 'interrupted',
          detail: payloadReason(payload),
          via: 'event_msg.turn_aborted',
          timestampMs
        }
      default:
        return null
    }
  }

  if (type === 'response_item') {
    if (payloadType === 'reasoning' || payloadType === 'function_call') {
      return {
        kind: 'working',
        via: payloadType === 'reasoning' ? 'response_item.reasoning' : 'response_item.function_call',
        timestampMs
      }
    }
    if (payloadType === 'message' && payload.role === 'assistant') {
      // 生产路径：assistant 正文只说明“它说了一句话”，不代表这一轮结束。
      // 长任务里“第一步完成了，接下来……”极常见；由正文触发 done 会在中途误报。
      // 回放/历史报告显式打开选项时，才复现旧的文本终态行为。
      if (!options.allowAssistantTextTerminal) return null
      const text = extractOutputText(payload)
      const classified = classifyStopText(text)
      if (classified) {
        return {
          kind: classified.kind,
          reason: classified.reason,
          detail: classified.detail,
          via: 'response_item.assistant_text',
          timestampMs
        }
      }
    }
  }

  return null
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

  // 一个会话文件的 tail 里往往堆着几十个历史回合，它们的事件必然过期、必然被 monitor 丢弃。
  // 在这里就跳过，省掉后面的文本分类开销（1 秒一轮，白做的量很可观）。
  const oldestMs = nowMs - AGENT_EVENT_FRESH_MS

  // 最近一条 assistant 正文。只在 task_complete 时用来判断“是不是在等你”，
  // 绝不单独拿它当终态；每个新 task_started 都会重置，避免上一轮的话污染这一轮。
  let lastAssistantText = ''

  for (const line of lines) {
    const payload =
      line.payload && typeof line.payload === 'object'
        ? (line.payload as Record<string, unknown>)
        : {}

    if (line.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = extractOutputText(payload)
      if (text) lastAssistantText = text
    }

    const classified = classifyCodexLegacyLine(line)
    if (!classified) continue

    if (classified.via === 'event_msg.task_started') lastAssistantText = ''

    const tsMs = classified.timestampMs || nowMs
    if (tsMs < oldestMs) continue

    if (classified.via === 'event_msg.task_complete') {
      const hint = classifyStopText(lastAssistantText)
      // 只在“最后一句明确在等你”时改成 needs_attention。
      // 仍然不允许文本产出 done / failed：文本可以请你回来，不能宣布任务结束或出错。
      if (hint?.kind === 'needs_attention') {
        classified.kind = 'needs_attention'
        classified.reason = 'needs_input'
        classified.detail = hint.detail
      }
    }

    let message = ''
    if (classified.via === 'event_msg.task_started') message = 'Codex 开始处理任务'
    else if (classified.via === 'event_msg.task_complete') {
      message = classified.kind === 'needs_attention' ? 'Codex 停下来了，需要你处理' : 'Codex 这一轮结束了'
    } else if (classified.via === 'event_msg.turn_aborted') message = 'Codex 任务被中断'
    else if (classified.via === 'response_item.reasoning' || classified.via === 'response_item.function_call') {
      message = 'Codex 正在处理任务'
    }

    events.push({
      id: '', // 由 monitor 统一生成稳定 id
      source: 'codex',
      env,
      sessionKey,
      kind: classified.kind,
      message,
      timestampMs: tsMs,
      rawPath: filePath,
      reason: classified.reason,
      detail: classified.detail
    })
  }

  return events
}

/** 扫描所有最近的 codex 会话文件，返回本轮全部归一化事件 */
export function scanCodex(nowMs: number): AgentMonitorEvent[] {
  const files = findRecentFiles(
    codexSessionsRoot(),
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH,
    { minMtimeMs: nowMs - AGENT_FILE_FRESH_MS }
  )
  const all: AgentMonitorEvent[] = []
  for (const f of files) {
    all.push(...parseCodexFile(f, nowMs))
  }
  return all
}
