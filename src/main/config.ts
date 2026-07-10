/** 气泡文案与节奏常量。v0.1 全部本地，无任何网络请求。 */

/** 闲时陪伴文案（安静、简短） */
export const IDLE_BUBBLE_LINES: readonly string[] = [
  '我在这儿。',
  '陪你一会儿。',
  '今天也慢慢来。',
  '嗯，一切都还好。',
  '记得偶尔看看远处。',
  '你做得已经很好了。',
  '累了的话，歇一下也可以。',
  '我会安静待着的。'
]

/** 被点击时的反应文案 */
export const CLICK_BUBBLE_LINES: readonly string[] = [
  '点到我啦。',
  '嘿嘿，在呢。',
  '干嘛戳我呀～',
  '被你发现了。',
  '我在认真陪你哦。'
]

/** 气泡展示时长（毫秒），到点自动消失 */
export const BUBBLE_DURATION_MS = 5000

import type { AgentMonitorEvent, AgentSource, AgentStopReason } from '@shared/types'

/**
 * v0.2.1：Agent 只在「停下来」时弹气泡，且气泡要说清「为什么停」。
 * 文案 = 来源名 + 停止原因短语（+ 可选细节）。working 不再弹气泡。
 */
const SOURCE_NAME: Record<AgentSource, string> = {
  codex: 'Codex',
  claude: 'Claude Code'
}

/** 每种停止原因对应一句主文案（不含来源名和细节） */
const STOP_REASON_PHRASE: Record<AgentStopReason, string> = {
  completed: '输出结束了，任务完成 ✅',
  needs_input: '停下来了，需要你处理一下 🙋',
  error: '出错停下了 ⚠️',
  interrupted: '输出被中断了 ⛔'
}

/** reason 缺省时按 kind 兜底，保证老数据也有合理文案 */
function effectiveReason(event: AgentMonitorEvent): AgentStopReason {
  return (
    event.reason ??
    (event.kind === 'failed'
      ? 'error'
      : event.kind === 'needs_attention'
        ? 'needs_input'
        : 'completed')
  )
}

/**
 * v0.5：气泡首行（来源 + 停止原因短语）。这一行来自显式信号 / 规则分类，可信；
 * AI 总结只替换第二行细节，不改动这行的事实性结论。
 */
export function buildAgentBubbleHead(event: AgentMonitorEvent): string {
  return `${SOURCE_NAME[event.source]} ${STOP_REASON_PHRASE[effectiveReason(event)]}`
}

/**
 * 为一条终态 Agent 事件生成气泡文案：明确说出是哪个 Agent、因为什么停的。
 */
export function buildAgentBubbleText(event: AgentMonitorEvent): string {
  const head = buildAgentBubbleHead(event)
  const reason = effectiveReason(event)
  // error / interrupted 若摘到了具体原因，补一句让用户知道是什么导致的
  const detail = event.detail?.trim()
  if (detail && (reason === 'error' || reason === 'interrupted' || reason === 'needs_input')) {
    return `${head}\n${detail}`
  }
  return head
}

/** 闲时气泡间隔的抖动比例（±35%），避免机械感 */
export const BUBBLE_JITTER = 0.35

/** 闲时气泡的最短间隔兜底（毫秒） */
export const BUBBLE_MIN_INTERVAL_MS = 15_000
