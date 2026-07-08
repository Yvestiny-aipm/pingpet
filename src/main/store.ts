import Store from 'electron-store'
import {
  BUBBLE_FREQ_MAX_SECONDS,
  BUBBLE_FREQ_MIN_SECONDS,
  BUBBLE_MAX_DISTANCE,
  BUBBLE_MIN_DISTANCE,
  DEFAULT_SETTINGS,
  PET_SCALE_MAX,
  PET_SCALE_MIN
} from '@shared/defaults'
import { AGENT_ENVS } from '@shared/types'
import type { AgentEnv, BubbleAnchor, PetPosition, Settings } from '@shared/types'

/** 把任意输入过滤成合法的环境集合（去重、只留 terminal/vscode/desktop） */
function sanitizeEnvs(input: unknown): AgentEnv[] | null {
  if (!Array.isArray(input)) return null
  const out: AgentEnv[] = []
  for (const v of input) {
    if (typeof v === 'string' && (AGENT_ENVS as readonly string[]).includes(v)) {
      const env = v as AgentEnv
      if (!out.includes(env)) out.push(env)
    }
  }
  return out
}

const store = new Store<Settings>({ defaults: DEFAULT_SETTINGS })

export function getSettings(): Settings {
  // 与默认值合并，并清洗磁盘上可能存在的旧字段/脏数据
  return { ...DEFAULT_SETTINGS, ...sanitize(store.store) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isValidPosition(value: unknown): value is PetPosition {
  if (typeof value !== 'object' || value === null) return false
  const pos = value as Record<string, unknown>
  return Number.isFinite(pos.x) && Number.isFinite(pos.y)
}

function sanitizeBubbleAnchor(value: unknown): BubbleAnchor | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const a = value as Record<string, unknown>
  if (!Number.isFinite(a.angleDeg) || !Number.isFinite(a.distance)) return undefined
  // 角度归一化到 [0,360)，距离夹到 [MIN,MAX]
  const angleDeg = ((((a.angleDeg as number) % 360) + 360) % 360)
  const distance = clamp(a.distance as number, BUBBLE_MIN_DISTANCE, BUBBLE_MAX_DISTANCE)
  return { angleDeg, distance }
}

/**
 * selectedPetId 只做“字符串安全”校验（v0.3）。
 * 不再检查是否存在于静态 PETS——否则用户导入的皮肤包 id 永远存不进去。
 * 是否真实存在，由 main.ts 的 catalog + getSelectedPet fallback 负责（找不到回落 dango）。
 */
function isSafePetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9:_-]{2,80}$/.test(value)
}

/** IPC 入参不可信，逐字段校验后才落盘 */
function sanitize(partial: Partial<Settings>): Partial<Settings> {
  const next: Partial<Settings> = {}
  if (isSafePetId(partial.selectedPetId)) {
    next.selectedPetId = partial.selectedPetId
  }
  if (typeof partial.petScale === 'number' && Number.isFinite(partial.petScale)) {
    next.petScale = clamp(partial.petScale, PET_SCALE_MIN, PET_SCALE_MAX)
  }
  if (typeof partial.bubblesEnabled === 'boolean') {
    next.bubblesEnabled = partial.bubblesEnabled
  }
  if (typeof partial.bubbleFrequencySeconds === 'number' && Number.isFinite(partial.bubbleFrequencySeconds)) {
    next.bubbleFrequencySeconds = clamp(
      Math.round(partial.bubbleFrequencySeconds),
      BUBBLE_FREQ_MIN_SECONDS,
      BUBBLE_FREQ_MAX_SECONDS
    )
  }
  if ('petPosition' in partial) {
    if (partial.petPosition === null) next.petPosition = null
    else if (isValidPosition(partial.petPosition)) {
      next.petPosition = { x: Math.round(partial.petPosition.x), y: Math.round(partial.petPosition.y) }
    }
  }
  if (typeof partial.petVisible === 'boolean') {
    next.petVisible = partial.petVisible
  }
  if ('bubbleAnchor' in partial) {
    const anchor = sanitizeBubbleAnchor(partial.bubbleAnchor)
    if (anchor) next.bubbleAnchor = anchor
  }
  // v0.2 Agent 监控开关：逐个白名单校验，漏一个就会静默丢盘。
  // v0.3.3：总开关 agentMonitoringEnabled 已删除；旧存盘里若还残留该字段，
  // 这里不再放行，合并时被自动丢弃，监控回到「看两个子开关」。
  if (typeof partial.codexMonitoringEnabled === 'boolean') {
    next.codexMonitoringEnabled = partial.codexMonitoringEnabled
  }
  if (typeof partial.claudeMonitoringEnabled === 'boolean') {
    next.claudeMonitoringEnabled = partial.claudeMonitoringEnabled
  }
  // v0.3.3：每家监控的环境集合（过滤成合法值）
  {
    const codexEnvs = sanitizeEnvs(partial.codexMonitoringEnvs)
    if (codexEnvs) next.codexMonitoringEnvs = codexEnvs
    const claudeEnvs = sanitizeEnvs(partial.claudeMonitoringEnvs)
    if (claudeEnvs) next.claudeMonitoringEnvs = claudeEnvs
  }
  if (typeof partial.agentProgressBubblesEnabled === 'boolean') {
    next.agentProgressBubblesEnabled = partial.agentProgressBubblesEnabled
  }
  if (typeof partial.agentCompletionSoundEnabled === 'boolean') {
    next.agentCompletionSoundEnabled = partial.agentCompletionSoundEnabled
  }
  if (typeof partial.autoRemoveBackground === 'boolean') {
    next.autoRemoveBackground = partial.autoRemoveBackground
  }
  return next
}

export function patchSettings(partial: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...sanitize(partial) }
  store.set(next)
  return next
}

export function getStorePath(): string {
  return store.path
}
