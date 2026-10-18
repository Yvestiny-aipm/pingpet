import type { AgentEventKind, AgentMonitorEvent, PetState } from '@shared/types'

/**
 * Codex 旧路径「协议完成」是否还对用户发成功提醒。
 *
 * 默认关闭：task_complete / kind=done 只表示协议轮次结束，不是任务语义成功。
 * 不得把这个开关理解成接入了 candidate 可见层。
 */
export const CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED = false

export type AgentTerminalLike = Pick<AgentMonitorEvent, 'source' | 'kind'>

/** 旧路径内部仍用 kind=done 兼容；对 Codex 这只是协议结束，不是 succeeded。 */
export function isCodexLegacyProtocolComplete(event: AgentTerminalLike): boolean {
  return event.source === 'codex' && event.kind === 'done'
}

/**
 * 终态事件要不要弹气泡 / 出完成音 / 切 celebrating。
 * 只隔离 source=codex 的 done；其他 Agent 与 Codex 的 working/failed/needs_attention 不变。
 */
export function shouldPresentAgentTerminalToUser(event: AgentTerminalLike): boolean {
  if (event.kind === 'working') return false
  if (isCodexLegacyProtocolComplete(event) && !CODEX_LEGACY_COMPLETION_NOTIFICATION_ENABLED) {
    return false
  }
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

const SUCCESS_HINTS = ['任务已完成', '任务完成', '完成了任务', 'celebrat']

export function looksLikeTaskSuccessCopy(text: string): boolean {
  return SUCCESS_HINTS.some((hint) => text.includes(hint))
}
