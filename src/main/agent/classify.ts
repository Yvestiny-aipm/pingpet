import type { AgentEventKind, AgentStopReason } from '@shared/types'

/**
 * 保守的文本分类：把一段「Agent 已经停下」的文本归到 done / needs_attention / failed。
 * 只在 Agent 停止输出时调用——working 不再走文本分类，也不再弹气泡。
 *
 * 返回 kind + reason + detail：
 *   - kind   给宠物状态用（done→happy / needs_attention→attention / failed→failed）
 *   - reason 停下的细分原因（completed / needs_input / error / interrupted），拼进气泡
 *   - detail 从文本里摘出的一句原因细节（如报错首句），让气泡说清「因为什么停」
 *
 * 优先级：error/interrupted（失败）> needs_input（等你）> completed（完成）。
 * 认不出具体类别时返回 null，由调用方决定兜底（Claude 的 end_turn 兜底为 completed）。
 *
 * 粗分策略（用户确认）：授权 / Agent 抛问题让你选 / 需要你帮忙验证，这三种在文本里
 * 长得很像，统一归到 needs_input（「需要你处理」），不强行细分以免误报。
 *
 * 保守化（用户确认 2026-07-06，"文本只判完成，出错/中断优先信显式信号"的落地）：
 * failed / needs_input 的关键词表已收紧为「几乎只在真出事/真提问时才出现」的高置信短语，
 * 剔除了 error/失败/错误/需要你/要不要 等在正常完成回复里高频误伤的宽泛词。
 * 真正可靠的失败/中断判定交给显式硬信号：Codex 的 turn_aborted（→failed/interrupted）。
 * 代价：只在自由文本里报错、又不含高置信短语的失败可能漏报——符合"宁漏勿误报"。
 */

export interface ClassifyResult {
  kind: AgentEventKind
  reason: AgentStopReason
  /** 从文本里摘出的原因细节（已裁剪长度），可能为空 */
  detail: string
}

/** 被「中断 / 中止」类关键词——归 failed + interrupted */
const INTERRUPTED_KEYWORDS = [
  'aborted',
  'interrupted',
  'cancelled',
  'canceled',
  'stopped by user',
  '被中断',
  '已中断',
  '中止',
  '已取消',
  '被取消'
]

/**
 * 「出错」类关键词——归 failed + error。
 *
 * 保守策略（用户确认 2026-07-06）：出错/中断优先信显式硬信号（Codex turn_aborted 等）。
 * 文本分类只保留「几乎只在真报错时才出现」的高置信短语；已剔除 error / failed /
 * 错误 / 失败 / 异常 / blocked 这些在正常完成回复里（"错误处理""避免失败"）会误伤的宽泛词，
 * 避免把含「错误」二字的正常完成误判成出错。
 */
const ERROR_KEYWORDS = [
  'traceback (most recent call last)',
  'cannot continue',
  'fatal error',
  'unhandled exception',
  'command failed with exit code',
  'no such file or directory',
  '报错如下',
  '执行失败',
  '运行失败',
  '构建失败',
  '编译失败',
  '无法继续',
  '无法完成任务'
]

/**
 * 「需要你处理」类关键词——授权 / 提问选项 / 求助验证，统一归 needs_input。
 *
 * 保守策略：只保留「基本只在真的停下等你回话时才出现」的强信号（授权/是否允许/请选择/
 * 等待输入 等）。已剔除口语礼貌词（should i / would you like / 要不要 / 需要你 / 请确认），
 * 因为 Agent 正常收尾也常这么说，容易把普通完成误判成"需要你"。
 */
const NEEDS_INPUT_KEYWORDS = [
  // 授权 / 批准（高置信）
  'awaiting your approval',
  'waiting for approval',
  'grant permission',
  'grant access',
  'do you want to proceed',
  'need your permission',
  '需要你授权',
  '需要您授权',
  '请授权',
  '是否允许',
  '请批准',
  '等待授权',
  // 抛问题 / 选项（高置信）
  'which option would you like',
  'please choose one',
  'please select an option',
  'let me know which',
  '请从以下选项',
  '请选择一个',
  '你想选哪',
  // 求助 / 验证（高置信）
  'please verify',
  'please confirm it works',
  'can you test',
  '请你验证',
  '帮我验证一下',
  '请确认是否正常',
  // 明确等待输入
  'waiting for input',
  'waiting for your input',
  'waiting for your response',
  '等待你的输入',
  '等待您的输入'
]

/** 「完成」类关键词——归 done + completed */
const COMPLETED_KEYWORDS = [
  'done',
  'complete',
  'completed',
  'fixed',
  'ready',
  'implemented',
  'finished',
  'all set',
  '完成',
  '已完成',
  '搞定',
  '修好了',
  '实现了',
  '处理好了'
]

function firstMatch(haystackLower: string, keywords: string[]): string | null {
  for (const k of keywords) {
    if (haystackLower.includes(k.toLowerCase())) return k
  }
  return null
}

/**
 * 从原文里摘一句「原因细节」：优先取包含命中关键词的那一行/句，裁剪到合理长度。
 * 摘不到就返回原文首句。用于 failed 气泡显示具体报错、needs_input 显示问题本身。
 */
function extractDetail(text: string, hitKeyword: string | null): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (hitKeyword) {
    const lines = text.split(/\r?\n/)
    const hitLine = lines.find((l) => l.toLowerCase().includes(hitKeyword.toLowerCase()))
    if (hitLine) {
      const t = hitLine.replace(/\s+/g, ' ').trim()
      if (t) return t.slice(0, 80)
    }
  }
  // 退回首句（到第一个句号/问号/换行为止）
  const firstSentence = clean.split(/(?<=[。！？!?.])\s/)[0] ?? clean
  return firstSentence.slice(0, 80)
}

/**
 * 分类一段「已停止」文本。返回 null 表示认不出具体类别（交给调用方兜底）。
 */
export function classifyStopText(text: string): ClassifyResult | null {
  if (!text || typeof text !== 'string') return null
  const lower = text.toLowerCase()

  const interruptedHit = firstMatch(lower, INTERRUPTED_KEYWORDS)
  if (interruptedHit) {
    return { kind: 'failed', reason: 'interrupted', detail: extractDetail(text, interruptedHit) }
  }
  const errorHit = firstMatch(lower, ERROR_KEYWORDS)
  if (errorHit) {
    return { kind: 'failed', reason: 'error', detail: extractDetail(text, errorHit) }
  }
  const needsHit = firstMatch(lower, NEEDS_INPUT_KEYWORDS)
  if (needsHit) {
    return { kind: 'needs_attention', reason: 'needs_input', detail: extractDetail(text, needsHit) }
  }
  const doneHit = firstMatch(lower, COMPLETED_KEYWORDS)
  if (doneHit) {
    return { kind: 'done', reason: 'completed', detail: extractDetail(text, doneHit) }
  }
  return null
}
