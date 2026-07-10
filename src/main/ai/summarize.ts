import { net } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import {
  AI_SUMMARY_MAX_TOKENS,
  AI_SUMMARY_TIMEOUT_MS,
  AI_TRANSCRIPT_MAX_CHARS
} from '@shared/defaults'
import type { AgentMonitorEvent, AiTestResult, Settings } from '@shared/types'
import { readJsonlTail } from '../agent/readJsonl'

/**
 * v0.5「停下原因总结 Agent」：任务停下时读会话末尾，让大模型生成一句人话总结拼进气泡。
 *
 * 边界（重要）：
 *  - BYOK：用用户自己填的 API Key，App 不自带任何 Key、无后端。
 *  - 只有 aiSummaryEnabled 开着才联网；发出去的只有该会话末尾 ≤ AI_TRANSCRIPT_MAX_CHARS 的文本。
 *  - 全防御式：任何失败（无 Key / 超时 / 网络 / 解析）都返回 null，气泡回落规则文案，绝不打断提醒。
 *  - 网络一律走 Electron net.fetch（Chromium 网络栈，吃系统代理），和形象库同一姿势。
 */

const SYSTEM_PROMPT =
  '你是 macOS 桌宠应用 PingPet 的任务播报员。用户把编程任务交给了 AI 编码助手，' +
  '助手刚刚停了下来。请根据会话末尾的记录，用一句简短中文告诉用户发生了什么：' +
  '助手做了什么或得出了什么结论；如果它在等用户做事（授权、回答问题、确认方案等），优先说清楚用户需要做什么。' +
  '要求：只输出这一句话本身，不超过 45 个字，不要引号、不要 markdown、不要换行、不要任何前缀。'

const REASON_LABEL: Record<string, string> = {
  completed: '正常完成',
  needs_input: '等待用户处理',
  error: '出错停止',
  interrupted: '被中断'
}

// ---------- 会话末尾转录提取 ----------

/** 从 content（字符串或 blocks 数组）里抽纯文本，兼容 claude 的 text 与 codex 的 input/output_text */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>
      if (
        (it.type === 'text' || it.type === 'input_text' || it.type === 'output_text') &&
        typeof it.text === 'string'
      ) {
        parts.push(it.text)
      }
    }
  }
  return parts.join('\n')
}

/** 提取 Claude Code 会话（~/.claude/projects/*.jsonl）末尾的用户/助手对话 */
function claudeTranscript(lines: Record<string, unknown>[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const message =
      line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : null
    if (!message) continue
    if (line.type === 'user') {
      const text = extractText(message.content).trim()
      if (text) out.push(`[用户] ${text}`)
    } else if (line.type === 'assistant') {
      const text = extractText(message.content).trim()
      if (text) out.push(`[助手] ${text}`)
    }
  }
  return out
}

/** 提取 Codex 会话（~/.codex/sessions/rollout-*.jsonl）末尾的用户/助手对话 */
function codexTranscript(lines: Record<string, unknown>[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line.type !== 'response_item') continue
    const payload =
      line.payload && typeof line.payload === 'object'
        ? (line.payload as Record<string, unknown>)
        : null
    if (!payload || payload.type !== 'message') continue
    const text = extractText(payload.content).trim()
    if (!text) continue
    out.push(payload.role === 'user' ? `[用户] ${text}` : `[助手] ${text}`)
  }
  return out
}

/**
 * 读事件对应会话文件的末尾，拼成给模型看的转录文本（从末尾截断到上限）。
 * 拿不到文件（dev 模拟 / 文件被清）时回落 event.detail / message。
 */
function buildTranscript(event: AgentMonitorEvent): string {
  let entries: string[] = []
  if (event.rawPath) {
    try {
      const lines = readJsonlTail(event.rawPath, 64_000)
      entries = event.source === 'codex' ? codexTranscript(lines) : claudeTranscript(lines)
    } catch {
      /* 读不到就用事件自带信息兜底 */
    }
  }
  if (entries.length === 0) {
    const fallback = [event.detail, event.message].filter(Boolean).join('\n').trim()
    return fallback.slice(-AI_TRANSCRIPT_MAX_CHARS)
  }
  // 从末尾往前收集，控制在上限内（末尾的对话离「为什么停」最近）
  const picked: string[] = []
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i].slice(0, AI_TRANSCRIPT_MAX_CHARS)
    if (total + entry.length > AI_TRANSCRIPT_MAX_CHARS) break
    picked.unshift(entry)
    total += entry.length
  }
  return picked.join('\n')
}

// ---------- Provider 调用 ----------

/**
 * electron net.fetch：走 Chromium 网络栈（系统代理）。
 * Electron 与 @types/node 的 fetch 类型声明不互认，统一收窄成标准 fetch 签名。
 */
const electronFetch = net.fetch.bind(net) as unknown as typeof globalThis.fetch

function callAnthropic(settings: Settings, userContent: string): Promise<string> {
  const client = new Anthropic({
    apiKey: settings.aiAnthropicApiKey,
    fetch: electronFetch,
    maxRetries: 0,
    timeout: AI_SUMMARY_TIMEOUT_MS
  })
  return client.messages
    .create({
      model: settings.aiAnthropicModel || 'claude-opus-4-8',
      max_tokens: AI_SUMMARY_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
    .then((response) => {
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) return block.text
      }
      throw new Error('模型没有返回文本')
    })
}

async function callOpenAiCompatible(settings: Settings, userContent: string): Promise<string> {
  const base = (settings.aiOpenaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_SUMMARY_TIMEOUT_MS)

  const once = async (): Promise<string> => {
    const res = await electronFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.aiOpenaiApiKey}`
      },
      body: JSON.stringify({
        model: settings.aiOpenaiModel,
        max_tokens: AI_SUMMARY_MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
      }),
      // @types/node 与 DOM 的 AbortSignal 声明不互认（缺 onabort），运行时是同一个东西
      signal: controller.signal as never
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      const err = new Error(`HTTP ${res.status}${body ? `：${body}` : ''}`) as Error & {
        retryable?: boolean
      }
      // 429 / 5xx 是平台瞬时拥堵（硅基流动 50609 之类），值得重试一次
      err.retryable = res.status === 429 || res.status >= 500
      throw err
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const text = data.choices?.[0]?.message?.content
    if (typeof text === 'string' && text.trim()) return text
    throw new Error('模型没有返回文本')
  }

  try {
    try {
      return await once()
    } catch (err) {
      // 瞬时拥堵重试一次（等 1.5s）；总时长仍受同一个 AbortController 上限约束
      if ((err as { retryable?: boolean }).retryable) {
        await new Promise((r) => setTimeout(r, 1_500))
        return await once()
      }
      throw err
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 模型输出后处理：压成一行、去引号包裹、封顶长度（气泡容不下长文） */
function tidySummary(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '')
  return oneLine.slice(0, 80)
}

function buildUserContent(event: AgentMonitorEvent): string {
  const who = event.source === 'codex' ? 'Codex' : 'Claude Code'
  const reason = REASON_LABEL[event.reason ?? ''] ?? '停止'
  return `助手：${who}\n停止类别：${reason}\n会话末尾记录：\n${buildTranscript(event)}`
}

function callProvider(settings: Settings, userContent: string): Promise<string> {
  if (settings.aiProvider === 'openai') return callOpenAiCompatible(settings, userContent)
  return callAnthropic(settings, userContent)
}

/** 当前设置下 AI 总结是否可用（开关开 + 对应 Provider 的 Key 已填） */
export function aiSummaryReady(settings: Settings): boolean {
  if (!settings.aiSummaryEnabled) return false
  if (settings.aiProvider === 'openai') {
    return settings.aiOpenaiApiKey.length > 0 && settings.aiOpenaiModel.length > 0
  }
  return settings.aiAnthropicApiKey.length > 0
}

/**
 * 为一条终态事件生成一句 AI 总结。
 * 关着 / 没配好 / 失败 / 超时 → 一律返回 null，调用方回落规则文案。
 */
export async function summarizeAgentStop(
  event: AgentMonitorEvent,
  settings: Settings
): Promise<string | null> {
  if (!aiSummaryReady(settings)) return null
  try {
    const raw = await callProvider(settings, buildUserContent(event))
    const tidy = tidySummary(raw)
    return tidy.length > 0 ? tidy : null
  } catch {
    return null
  }
}

/** 设置台「测试」按钮：用当前设置对一段样例转录发一次真实请求，把结果/错误直接回给 UI */
export async function testAiSummary(settings: Settings): Promise<AiTestResult> {
  if (!settings.aiSummaryEnabled) return { ok: false, error: '请先打开 AI 总结开关' }
  if (settings.aiProvider === 'openai') {
    if (!settings.aiOpenaiApiKey) return { ok: false, error: '请先填写 API Key' }
    if (!settings.aiOpenaiModel) return { ok: false, error: '请先填写模型 ID' }
  } else if (!settings.aiAnthropicApiKey) {
    return { ok: false, error: '请先填写 API Key' }
  }
  const sample =
    '助手：Claude Code\n停止类别：等待用户处理\n会话末尾记录：\n' +
    '[用户] 帮我把登录页的表单校验改成实时校验\n' +
    '[助手] 我已经改好了 LoginForm.tsx 的校验逻辑，共修改 2 个文件。' +
    '在提交前我想先运行一遍现有的表单测试确认没有回归，需要执行 npm test，是否允许？'
  try {
    const raw = await callProvider(settings, sample)
    const tidy = tidySummary(raw)
    if (!tidy) return { ok: false, error: '模型返回了空内容' }
    return { ok: true, text: tidy }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.slice(0, 300) }
  }
}
