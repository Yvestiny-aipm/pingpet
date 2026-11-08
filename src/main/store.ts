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
import { AGENT_SOURCE_LIST } from '@shared/agents'
import { sanitizeCodexCandidateSettings } from '@shared/codexCandidateSettings'
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

/**
 * 已下线功能留在磁盘上的旧字段。store.set 只合并不删除，sanitize 虽然不放行它们，
 * 但不显式删掉就会一直躺在 config.json 里——AI 总结的 API Key（密文）也在其中。
 */
const LEGACY_KEYS = [
  'aiSummaryEnabled',
  'aiProvider',
  'aiAnthropicApiKey',
  'aiAnthropicModel',
  'aiOpenaiBaseUrl',
  'aiOpenaiApiKey',
  'aiOpenaiModel',
  'updateCheckEnabled'
] as const

export function getSettings(): Settings {
  // 与默认值合并，并清洗磁盘上可能存在的旧字段/脏数据
  return { ...DEFAULT_SETTINGS, ...sanitize(store.store as Partial<Settings>) }
}

/** 启动时调用一次：把 LEGACY_KEYS 从磁盘上删掉；没有就什么都不写 */
export function purgeLegacySettings(): void {
  const raw = store.store as unknown as Record<string, unknown>
  for (const key of LEGACY_KEYS) {
    if (key in raw) store.delete(key as keyof Settings)
  }
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
  // Agent 监控的开关与环境集合：遍历 AGENT_SOURCES 登记处，加一家不用改这里。
  // 以前是逐个手写白名单，漏一个不会报错、只是那家的选择静默存不进去。
  // v0.3.3：总开关 agentMonitoringEnabled 已删除；旧存盘里若还残留该字段，
  // 这里不放行，合并时被自动丢弃。
  for (const meta of AGENT_SOURCE_LIST) {
    const enabled = partial[meta.enabledKey]
    if (typeof enabled === 'boolean') next[meta.enabledKey] = enabled
    const envs = sanitizeEnvs(partial[meta.envsKey])
    if (envs) next[meta.envsKey] = envs
  }
  if (typeof partial.agentProgressBubblesEnabled === 'boolean') {
    next.agentProgressBubblesEnabled = partial.agentProgressBubblesEnabled
  }
  if (typeof partial.agentCompletionSoundEnabled === 'boolean') {
    next.agentCompletionSoundEnabled = partial.agentCompletionSoundEnabled
  }
  Object.assign(next, sanitizeCodexCandidateSettings(partial))
  if (typeof partial.autoRemoveBackground === 'boolean') {
    next.autoRemoveBackground = partial.autoRemoveBackground
  }
  if (partial.theme === 'light' || partial.theme === 'dark') {
    next.theme = partial.theme
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
