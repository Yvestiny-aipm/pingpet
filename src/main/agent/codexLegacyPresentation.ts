import type { AgentEventKind, AgentMonitorEvent, PetState } from '@shared/types'

/**
 * Codex 旧路径「协议完成」是否向用户发中性提醒。
 *
 * 打开后：task_complete / kind=done 会弹一条「Codex 这一轮结束了，回去看看」的中性气泡。
 * 仍然不做：不响完成音、不切 happy/celebrating、不把 done 解释成任务成功。
 * 这是旧 Monitor 的兼容路径，不是 candidate 可见层；candidate 仍 shouldNotify=false。
 */
export const CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED = true

export type AgentTerminalLike = Pick<AgentMonitorEvent, 'source' | 'kind'>

/** 旧路径内部仍用 kind=done 兼容；对 Codex 这只是协议结束，不是 succeeded。 */
export function isCodexLegacyProtocolComplete(event: AgentTerminalLike): boolean {
  return event.source === 'codex' && event.kind === 'done'
}

/**
 * 终态事件要不要弹气泡。
 * Codex done 走中性提醒（见上面的开关）；其他 Agent 与 Codex 的 failed/needs_attention 不变。
 */
export function shouldPresentAgentTerminalToUser(event: AgentTerminalLike): boolean {
  if (event.kind === 'working') return false
  if (isCodexLegacyProtocolComplete(event)) return CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED
  return event.kind === 'done' || event.kind === 'needs_attention' || event.kind === 'failed'
}

/** 完成音只跟「非 Codex 的 done」走。Codex done 不得触发成功完成音。 */
export function shouldPlayAgentCompletionSound(events: readonly AgentTerminalLike[]): boolean {
  return events.some((event) => event.kind === 'done' && !isCodexLegacyProtocolComplete(event))
}

export function presentableTerminalEvents<T extends AgentTerminalLike>(events: readonly T[]): T[] {
  return events.filter((event) => shouldPresentAgentTerminalToUser(event))
}

export function countPresentableDone(events: readonly AgentTerminalLike[]): number {
  return presentableTerminalEvents(events).filter((event) => event.kind === 'done').length
}

/** Codex 协议结束后最多静默回到 idle，不得 happy/celebrating。 */
export function silentCodexCompletionPetState(): Extract<PetState, 'idle'> {
  return 'idle'
}

export function isCelebratingPetState(state: PetState): boolean {
  return state === 'happy'
}

export function petStateForPresentedKind(kind: AgentEventKind): PetState {
  switch (kind) {
    case 'working':
      return 'thinking'
    case 'done':
      return 'happy'
    case 'needs_attention':
      return 'attention'
    case 'failed':
      return 'failed'
  }
}

/** 单条终态事件对应的宠物姿态：Codex 的协议完成只回 idle，不庆祝。 */
export function petStateForTerminalEvent(event: AgentTerminalLike): PetState {
  if (isCodexLegacyProtocolComplete(event)) return silentCodexCompletionPetState()
  return petStateForPresentedKind(event.kind)
}

/** 多条终态合并时的姿态：失败 > 需要你 > 有真实完成则 happy > 只有 Codex 协议完成则 idle。 */
export function petStateForTerminalBatch(events: readonly AgentTerminalLike[]): PetState {
  if (events.some((event) => event.kind === 'failed')) return 'failed'
  if (events.some((event) => event.kind === 'needs_attention')) return 'attention'
  if (events.length > 0 && events.every(isCodexLegacyProtocolComplete)) {
    return silentCodexCompletionPetState()
  }
  return 'happy'
}

const SUCCESS_HINTS = ['任务已完成', '任务完成', '完成了任务', 'celebrat']

export function looksLikeTaskSuccessCopy(text: string): boolean {
  return SUCCESS_HINTS.some((hint) => text.includes(hint))
}
