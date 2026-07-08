import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
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

function parseClaudeFile(filePath: string, nowMs: number): AgentMonitorEvent[] {
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES)
  const events: AgentMonitorEvent[] = []

  // 会话级环境：entrypoint 逐行都带，取 tail 里能读到的最后一个；读不到兜底 terminal
  let env: AgentEnv = 'terminal'
  for (const line of lines) {
    const ep = entrypointToEnv(line.entrypoint)
    if (ep) env = ep
  }

  for (const line of lines) {
    const type = line.type
    const message =
      line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : {}
    const tsMs = getTimestampMs(line) || nowMs
    const sessionKey = sessionKeyFor(filePath, line)

    let kind: AgentEventKind | null = null
    let text = ''
    let reason: AgentStopReason | undefined
    let detail: string | undefined

    if (type === 'assistant') {
      const stopReason = message.stop_reason
      if (stopReason === 'tool_use') {
        // 仍在调工具 = 正在干活。发 working 事件让宠物切 thinking，但不会弹气泡。
        kind = 'working'
        text = 'Claude Code 正在处理任务'
      } else if (stopReason === 'end_turn') {
        // 回合结束 = Agent 停下来了。判断为什么停：完成 / 需要你 / 出错。
        const body = extractAssistantText(message)
        const classified = classifyStopText(body)
        if (classified) {
          kind = classified.kind
          reason = classified.reason
          detail = classified.detail
        } else {
          // end_turn 认不出具体类别时，视为正常「回合结束」= 完成（最常见情况）
          kind = 'done'
          reason = 'completed'
        }
        text = body.slice(0, 200)
      }
    } else if (type === 'last-prompt' || type === 'user') {
      // 用户刚发出指令 / 回合推进：视为 working（不弹气泡，只让宠物切 thinking）
      kind = 'working'
      text = 'Claude Code 正在处理任务'
    }

    if (kind) {
      events.push({
        id: '',
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
    AGENT_SCAN_MAX_DEPTH
  )
  const all: AgentMonitorEvent[] = []
  for (const f of files) {
    all.push(...parseClaudeFile(f, nowMs))
  }
  return all
}
