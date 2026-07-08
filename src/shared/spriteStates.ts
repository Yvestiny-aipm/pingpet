import type { PetState, SpriteSheetSpec } from './types'

/**
 * v0.4：PetDex / Codex 宠物格式的精灵图规格（兼容层）。
 *
 * PetDex 的标准精灵图是一张 8 列 × 9 行的网格，每帧 192×208 像素，整张 1536×1872。
 * 9 行分别对应 9 种动作（下方 PETDEX_ROWS）。我们把自己的 6 个 PetState
 * 映射到这些行（PET_STATE_TO_ROW），这样社区做的宠物无需改造即可在我们的桌宠里动起来。
 *
 * 参考：PawPause / crafter-station/petdex 的公开格式。
 */

/** PetDex 标准精灵图尺寸 */
export const PETDEX_SPRITE = {
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  sheetWidth: 1536,
  sheetHeight: 1872
} as const

/** PetDex 9 行动作 → { 行号, 该行帧数, 每帧时长(ms) } */
const PETDEX_ROWS = {
  idle: { row: 0, frames: 6, durationMs: 1100 / 6 },
  runningRight: { row: 1, frames: 8, durationMs: 1060 / 8 },
  runningLeft: { row: 2, frames: 8, durationMs: 1060 / 8 },
  waving: { row: 3, frames: 4, durationMs: 700 / 4 },
  jumping: { row: 4, frames: 5, durationMs: 840 / 5 },
  failed: { row: 5, frames: 8, durationMs: 1220 / 8 },
  waiting: { row: 6, frames: 6, durationMs: 1010 / 6 },
  running: { row: 7, frames: 6, durationMs: 820 / 6 },
  review: { row: 8, frames: 6, durationMs: 1030 / 6 }
} as const

/**
 * 我们的 PetState → PetDex 行。
 * idle→idle，happy→jumping（蹦跶=开心），thinking→waiting（等待=思考中），
 * attention→review（审阅=需要你看），failed→failed，sleepy→idle（慢待机）。
 */
export const PET_STATE_TO_ROW: Record<PetState, keyof typeof PETDEX_ROWS> = {
  idle: 'idle',
  happy: 'jumping',
  sleepy: 'idle',
  attention: 'review',
  thinking: 'waiting',
  failed: 'failed'
}

/**
 * 根据一张 PetDex 精灵图的 file:// URL，生成我们 PetDefinition 需要的 SpriteSheetSpec。
 * 把每个 PetState 都映射好行号/帧数/时长，渲染层据此逐帧播放。
 */
export function buildPetdexSpriteSpec(url: string): SpriteSheetSpec {
  const states: SpriteSheetSpec['states'] = {}
  for (const state of Object.keys(PET_STATE_TO_ROW) as PetState[]) {
    const rowKey = PET_STATE_TO_ROW[state]
    const r = PETDEX_ROWS[rowKey]
    states[state] = { row: r.row, frames: r.frames, durationMs: r.durationMs }
  }
  return {
    url,
    frameWidth: PETDEX_SPRITE.frameWidth,
    frameHeight: PETDEX_SPRITE.frameHeight,
    columns: PETDEX_SPRITE.columns,
    states
  }
}
