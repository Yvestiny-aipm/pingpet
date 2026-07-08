import type { PetDefinition } from './types'

/** v0.1 内置的 3 只原创宠物（纯 SVG + CSS 动画，无第三方素材）。v0.3 起标记 source:'official' */
export const PETS: PetDefinition[] = [
  {
    id: 'dango',
    name: '团子',
    kind: 'svg',
    source: 'official',
    accentColor: '#F0B27E',
    description: '软乎乎的奶油小猫'
  },
  {
    id: 'pudding',
    name: '布丁',
    kind: 'svg',
    source: 'official',
    accentColor: '#F5B942',
    description: '圆滚滚的小鸡'
  },
  {
    id: 'momo',
    name: '墨墨',
    kind: 'svg',
    source: 'official',
    accentColor: '#7C8DB0',
    description: '安安静静的小墨团'
  }
]

/** 兜底宠物 id：任何找不到宠物的场景都回落到它 */
export const FALLBACK_PET_ID = 'dango'

export function getPetById(id: string): PetDefinition {
  return PETS.find((pet) => pet.id === id) ?? PETS[0]
}
