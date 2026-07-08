import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPetdexSpriteSpec } from '@shared/spriteStates'
import type { PetDefinition, PetSource } from '@shared/types'

/**
 * v0.4：解析 PetDex / Codex 宠物格式（一个目录 = pet.json + spritesheet.webp/png）。
 *
 * 兼容 crafter-station/petdex 与 PawPause 的公开格式：
 *   pet.json → { id, displayName/name, description, author, spritesheetPath? }
 *   spritesheet.webp（或 .png）→ 8×9 网格精灵图
 *
 * 全防御式：任何目录/文件/JSON 读不了就返回 null，绝不抛错、不让一只坏宠物毁掉整个列表。
 */

/** 从 pet.json 里安全取字符串字段 */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 在包目录里找精灵图文件（优先 pet.json 指定的，其次 spritesheet.webp/png） */
function findSpritesheet(packDir: string, manifest: Record<string, unknown>): string | null {
  const declared = str(manifest.spritesheetPath) || str(manifest.spritesheet)
  const candidates = [
    ...(declared ? [declared] : []),
    'spritesheet.webp',
    'spritesheet.png'
  ]
  for (const rel of candidates) {
    const p = join(packDir, rel)
    try {
      if (existsSync(p) && statSync(p).isFile()) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * 把一个 PetDex 宠物目录解析成 PetDefinition（kind:'spritesheet'）。
 * 解析失败返回 null。
 */
export function readPetdexPack(
  packDir: string,
  fallbackId: string,
  source: PetSource
): PetDefinition | null {
  const manifestPath = join(packDir, 'pet.json')
  let manifest: Record<string, unknown> = {}
  try {
    if (existsSync(manifestPath)) {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>
      }
    }
  } catch {
    // pet.json 坏了：仍尝试仅凭 spritesheet + 目录名兜底，不直接放弃
    manifest = {}
  }

  const spritePath = findSpritesheet(packDir, manifest)
  if (!spritePath) return null // 没有精灵图 = 不是一个可渲染的 PetDex 包

  const id = str(manifest.id) || fallbackId
  if (!/^[a-z0-9_-]{1,64}$/i.test(id)) return null // id 不合法，跳过

  const name = str(manifest.displayName) || str(manifest.name) || id
  const description = str(manifest.description) || '来自 PetDex 社区的桌宠'
  const spriteUrl = pathToFileURL(spritePath).href

  return {
    id,
    name,
    kind: 'spritesheet',
    source,
    accentColor: '#7aa7ff',
    description,
    thumbnailUrl: spriteUrl, // 缩略图先用精灵图本身（渲染层会截取第一帧展示）
    sprite: buildPetdexSpriteSpec(spriteUrl)
  }
}

/** 扫一个根目录下所有子目录，逐个当 PetDex 包解析（坏的安静跳过） */
export function loadPetdexPacksFrom(root: string, source: PetSource): PetDefinition[] {
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const pets: PetDefinition[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const packDir = join(root, entry)
    try {
      if (!statSync(packDir).isDirectory()) continue
    } catch {
      continue
    }
    const pet = readPetdexPack(packDir, entry, source)
    if (pet) pets.push(pet)
  }
  return pets
}
