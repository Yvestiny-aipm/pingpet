import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import {
  AGENT_MAX_FILES_PER_SOURCE,
  AGENT_SCAN_MAX_DEPTH,
  AGENT_TAIL_BYTES
} from '@shared/defaults'
import type { AgentEnv, AgentEventKind, AgentMonitorEvent, AgentStopReason } from '@shared/types'
import { classifyStopText } from './classify'
import { findRecentFilesAcross } from './findFiles'
import { readJsonlTail } from './readJsonl'

/**
 * Cursor 会话根目录。桌面客户端和 CLI 都写这里，布局完全一致：
 *   ~/.cursor/projects/<工作区 slug>/agent-transcripts/<session-id>/<session-id>.jsonl
 */
export function cursorProjectsRoot(): string {
  return join(homedir(), '.cursor', 'projects')
}

/**
 * CLI 在 project 目录里留下的边车文件（桌面不会产生）。
 * worker.log 只在 worker 启动时写一次，所以它是「这个目录用过 CLI」的持久标记，不是实时信号。
 */
const CLI_MARKERS = ['worker.log', 'repo.json', '.workspace-trusted']

/** 桌面客户端在 project 目录里建的子目录（CLI 不会产生） */
const DESKTOP_MARKERS = ['terminals', 'mcps', 'canvases']

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 推断某个 project 目录属于哪个环境。
 *
 * Cursor 的会话 JSONL 里**没有任何环境字段**（不像 Claude 的 entrypoint / Codex 的 originator），
 * 文件路径和布局在桌面与 CLI 之间也完全相同，只能靠 project 目录里的边车文件反推：
 *   - 桌面客户端：建 terminals/ mcps/ canvases/
 *   - CLI       ：写 worker.log / repo.json / .workspace-trusted
 *
 * 已知局限：同一个工作区既用桌面打开过、又跑过 CLI 时，两类标记会同时存在，
 * 此时无法按会话区分，统一归桌面档（桌面是绝大多数人的主力入口，误判代价更小）。
 */
function inferEnv(projectDir: string): AgentEnv {
  const hasCli = CLI_MARKERS.some((m) => exists(join(projectDir, m)))
  const hasDesktop = DESKTOP_MARKERS.some((m) => exists(join(projectDir, m)))
  if (hasCli && !hasDesktop) return 'terminal'
  return 'desktop'
}

/** 从会话文件路径回推它所属的 project 目录（~/.cursor/projects/<slug>） */
function projectDirOf(filePath: string, root: string): string | null {
  const rel = relative(root, filePath)
  if (!rel || rel.startsWith('..')) return null
  const slug = rel.split(sep)[0]
  if (!slug) return null
  return join(root, slug)
}

/** 取一行的 message 对象（拿不到就空对象） */
function messageOf(line: Record<string, unknown>): Record<string, unknown> {
  return line.message && typeof line.message === 'object'
    ? (line.message as Record<string, unknown>)
    : {}
}

/** 从 message.content 数组里抽出所有 text，合并成一段文本 */
function extractText(message: Record<string, unknown>): string {
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

/** 这一行的 assistant 消息里有没有 tool_use（有 = 还在调工具干活） */
function hasToolUse(message: Record<string, unknown>): boolean {
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_use'
  )
}

/** 从 turn_ended 行的 error 字段摘一句可读原因 */
function errorDetail(line: Record<string, unknown>): string | undefined {
  const raw = line.error
  if (typeof raw === 'string' && raw.trim()) {
    return raw.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  return undefined
}

/**
 * 解析单个 Cursor 会话文件。
 *
 * 关键约束：Cursor 的行里没有时间戳字段，只能用文件 mtime 当事件时间。而 monitor 的
 * 事件 id 里含时间戳，若对同一条历史 turn_ended 反复用「当前 mtime」生成 id，
 * 用户发下一条消息导致 mtime 变化时，旧终态会被当成新事件重复提醒。
 *
 * 因此终态判定一律只看 **文件最后一行**（回合结束后 mtime 冻结 → id 稳定 → 只报一次；
 * 用户发下一条消息后该行不再是最后一行 → 不再产出，天然避免重复提醒）：
 *
 *   1. 最后一行是 turn_ended        → 按 status 映射（新版 Cursor 的显式硬信号，最可信）
 *   2. 最后一行是纯文本 assistant   → 回合结束（老版本 Cursor 不写 turn_ended，实测老会话
 *                                     一律以「只含 text 的 assistant」收尾，即最终答复）
 *   3. 最后一行 assistant 带 tool_use / 是 user → 还在干活，产出 working 保持思考态
 *
 * 第 2 条是必要的兼容：实测 2026-05/06 的会话文件里 turn_ended 出现 0 次，只靠第 1 条
 * 会让老版本用户永远收不到完成提醒。
 */
function parseCursorFile(filePath: string, projectDir: string, nowMs: number): AgentMonitorEvent[] {
  const lines = readJsonlTail(filePath, AGENT_TAIL_BYTES)
  if (lines.length === 0) return []

  let mtimeMs = nowMs
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    /* 读不到就用 now 兜底 */
  }

  const env = inferEnv(projectDir)
  // session id 就是文件名（去掉后缀），同一会话续写时保持不变
  const sessionKey = `cursor:${basename(filePath, '.jsonl')}`

  const last = lines[lines.length - 1]
  const base = {
    id: '',
    source: 'cursor' as const,
    env,
    sessionKey,
    timestampMs: mtimeMs,
    rawPath: filePath
  }
  const working: AgentMonitorEvent = {
    ...base,
    kind: 'working',
    message: 'Cursor 正在处理任务'
  }

  const endedByStatus = last.type === 'turn_ended'
  // 老格式回退：最后一行是「只含 text、不含 tool_use」的 assistant = 最终答复 = 回合结束
  const endedByFinalText =
    !endedByStatus && last.role === 'assistant' && !hasToolUse(messageOf(last))

  if (!endedByStatus && !endedByFinalText) return [working]

  // 回合已结束：取最后一段 assistant 文本，既做气泡正文也用于判断停下原因
  let body = ''
  for (const line of lines) {
    if (line.role !== 'assistant') continue
    const text = extractText(messageOf(line))
    if (text.trim()) body = text
  }

  // 没有 turn_ended 的老格式按「正常收尾」处理，走和 success 相同的分支
  const status = endedByStatus && typeof last.status === 'string' ? last.status : 'success'
  let kind: AgentEventKind
  let reason: AgentStopReason
  let detail: string | undefined

  if (status === 'success') {
    // 正常收尾。文本里若明确在等用户（授权 / 抛问题 / 求验证）才改判 needs_attention，
    // 其余一律算完成——success 本身就是可信的显式信号，不需要再靠文本猜完成。
    const classified = classifyStopText(body)
    if (classified && classified.kind === 'needs_attention') {
      kind = 'needs_attention'
      reason = 'needs_input'
      detail = classified.detail
    } else {
      kind = 'done'
      reason = 'completed'
    }
  } else if (status === 'aborted') {
    kind = 'failed'
    reason = 'interrupted'
    detail = errorDetail(last)
  } else {
    // error / 其它未知状态：一律按出错处理，别静默吞掉
    kind = 'failed'
    reason = 'error'
    detail = errorDetail(last)
  }

  return [{ ...base, kind, message: body.slice(0, 200), reason, detail }]
}

/**
 * 列出所有工作区的 agent-transcripts 目录。
 * 只把这些子树喂给扫描：同级还有 terminals / agent-tools / canvases / mcps 等大量无关文件，
 * 从 projects 整棵树走会白扫一大片（1 秒一轮，重度用户下开销会线性变差）。
 */
function transcriptRoots(root: string): string[] {
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return [] // 没装 Cursor / 目录不可读：安静返回
  }
  const out: string[] = []
  for (const slug of slugs) {
    const dir = join(root, slug, 'agent-transcripts')
    if (exists(dir)) out.push(dir)
  }
  return out
}

/** 扫描最近的 Cursor 会话文件，返回本轮全部归一化事件 */
export function scanCursor(nowMs: number): AgentMonitorEvent[] {
  const root = cursorProjectsRoot()
  const files = findRecentFilesAcross(
    transcriptRoots(root),
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH
  )
  const all: AgentMonitorEvent[] = []
  for (const f of files) {
    // 子 Agent 的分支记录不单独提醒：它结束不等于用户的任务结束，只认父会话
    if (f.includes(`${sep}subagents${sep}`)) continue
    const projectDir = projectDirOf(f, root)
    if (!projectDir) continue
    all.push(...parseCursorFile(f, projectDir, nowMs))
  }
  return all
}
