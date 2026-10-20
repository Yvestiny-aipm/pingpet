import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
import { readJsonlTail } from './readJsonl'

/** Claude Code 项目会话根目录 */
export function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** 从 assistant message 的 content 数组里抽出所有 text，合并成一段文本 */
function extractAssistantText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>
      if (it.type === 'text' && typeof it.text === 'string') parts.push(it.text)
    }
  }
  return parts.join('\n')
}

function getTimestampMs(line: Record<string, unknown>): number {
  const raw = line.timestamp
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return 0
}

/**
 * 从 Claude jsonl 行里的 entrypoint 字段推断运行环境。
 * 实测取值：cli / sdk-cli → terminal，claude-vscode → vscode，claude-desktop → desktop。
 * 读不到时返回 null（由调用方兜底为 terminal）。
 */
function entrypointToEnv(entrypoint: unknown): AgentEnv | null {
  if (typeof entrypoint !== 'string') return null
  if (entrypoint === 'claude-vscode') return 'vscode'
  if (entrypoint === 'claude-desktop') return 'desktop'
  if (entrypoint === 'cli' || entrypoint === 'sdk-cli') return 'terminal'
  // 其它未知 entrypoint：保守归终端档
  return 'terminal'
}

/**
 * 会话标识：优先用行里的 sessionId（同一会话跨文件也能关联），
 * 拿不到就退回「项目目录名/文件名」。
 */
function sessionKeyFor(filePath: string, line: Record<string, unknown>): string {
  const sid = line.sessionId
  if (typeof sid === 'string' && sid) return `claude:${sid}`
  return `claude:${basename(dirname(filePath))}/${basename(filePath)}`
}

/** 把任意 error 字段压成一句可读 detail，最多 120 字符 */
function errorDetail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 120) : undefined
}

/** API 错误正在自动重试时不是终态；重试耗尽后才提醒。 */
function isRetryScheduled(line: Record<string, unknown>): boolean {
  const attempt = typeof line.retryAttempt === 'number' ? line.retryAttempt : undefined
  const max = typeof line.maxRetries === 'number' ? line.maxRetries : undefined
  if (attempt !== undefined && max !== undefined && attempt < max) return true
  return typeof line.retryInMs === 'number' && line.retryInMs > 0
}

function parseClaudeFile(filePath: string, nowMs: number): AgentMonitorEvent[] {
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES)
  const events: AgentMonitorEvent[] = []

  // 会话级环境：entrypoint 逐行都带，取 tail 里能读到的最后一个；读不到兜底 terminal
  let env: AgentEnv = 'terminal'
  for (const line of lines) {
    if (line.isSidechain === true) continue
    const ep = entrypointToEnv(line.entrypoint)
    if (ep) env = ep
  }

  // tail 里的历史回合事件必然过期、必然被 monitor 丢弃，提前跳过省掉后面的文本分类开销
  const oldestMs = nowMs - AGENT_EVENT_FRESH_MS

  for (const line of lines) {
    // 子 Agent 的回合结束不代表用户主任务结束；与 Cursor 的 subagents/ 同理。
    if (line.isSidechain === true) continue

    const type = line.type
    const message =
      line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : {}
    const tsMs = getTimestampMs(line) || nowMs
    if (tsMs < oldestMs) continue
    const sessionKey = sessionKeyFor(filePath, line)
    const body = extractAssistantText(message)

    let kind: AgentEventKind | null = null
    let text = ''
    let reason: AgentStopReason | undefined
    let detail: string | undefined

    if (type === 'assistant') {
      // API 错误是结构化终态，优先级高于 stop_reason。
      if (line.isApiErrorMessage === true || typeof line.error === 'string') {
        kind = 'failed'
        reason = 'error'
        detail = errorDetail(line.error) ?? (body ? body.slice(0, 120) : 'Claude API 返回错误')
        text = body.slice(0, 200)
      } else {
        const stopReason = message.stop_reason
        if (stopReason === 'tool_use') {
          // 仍在调工具 = 正在干活。发 working 事件让宠物切 thinking，但不会弹气泡。
          kind = 'working'
          text = 'Claude Code 正在处理任务'
        } else if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
          // 回合结束。文本只用于判断“是否在等用户”，不把关键词升级成成功/失败。
          const classified = classifyStopText(body)
          if (classified?.kind === 'needs_attention') {
            kind = 'needs_attention'
            reason = 'needs_input'
            detail = classified.detail
          } else {
            kind = 'done'
            reason = 'completed'
          }
          text = body.slice(0, 200)
        } else if (stopReason === 'max_tokens') {
          kind = 'failed'
          reason = 'error'
          detail = '输出被截断（max_tokens）'
          text = body.slice(0, 200)
        }
      }
    } else if (type === 'system' && (line.subtype === 'api_error' || line.level === 'error')) {
      // 自动重试中的 api_error 不是终态；重试耗尽后才提醒。
      if (isRetryScheduled(line)) {
        kind = 'working'
        text = 'Claude Code 正在重试 API 请求'
      } else {
        kind = 'failed'
        reason = 'error'
        detail = errorDetail(line.error) ?? 'Claude API 请求失败'
      }
    } else if (type === 'last-prompt' || type === 'user') {
      // 用户刚发出指令 / 回合推进：视为 working（不弹气泡，只让宠物切 thinking）
      kind = 'working'
      text = 'Claude Code 正在处理任务'
    }

    if (kind) {
      events.push({
        // Claude 每条 assistant/system 都有 uuid；用它做跨轮稳定去重，缺失时交给 Monitor 生成。
        id: typeof line.uuid === 'string' && line.uuid ? `claude:${line.uuid}` : '',
        source: 'claude',
        env,
        sessionKey,
        kind,
        message: text,
        timestampMs: tsMs,
        rawPath: filePath,
        reason,
        detail
      })
    }
  }

  return events
}

export function scanClaude(nowMs: number): AgentMonitorEvent[] {
  const files = findRecentFiles(
    claudeProjectsRoot(),
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH,
    { minMtimeMs: nowMs - AGENT_FILE_FRESH_MS }
  )
  const all: AgentMonitorEvent[] = []
  for (const f of files) {
    all.push(...parseClaudeFile(f, nowMs))
  }
  return all
}
