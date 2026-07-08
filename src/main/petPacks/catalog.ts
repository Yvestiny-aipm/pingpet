import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PETS } from '@shared/pets'
import type { PetDefinition, PetSource, PetState } from '@shared/types'
import { readAndValidateManifest, type ValidatedManifest } from './manifest'
import { loadPetdexPacksFrom } from './petdexPack'
import {
  codexPetsRoot,
  importedPacksRoot,
  officialPacksRoot,
  petdexImportedRoot
} from './paths'

/**
 * 宠物目录（catalog，v0.3）：把三类来源合成一份 PetDefinition[] 供 snapshot 用。
 *   1. legacy 内置 SVG（团子/布丁/墨墨，来自 shared/pets.ts）
 *   2. 官方 image-pack（resources/pet-packs/official/*）
 *   3. 用户导入 image-pack（userData/pet-packs/imported/*）
 *
 * 渲染进程不自己扫文件系统，只消费这份 catalog（手册要求）。
 * image-pack 的素材路径一律转成 file:// URL（pathToFileURL），不把裸路径给 renderer。
 */

/** 把一个校验通过的 manifest + 包目录，转成渲染层可用的 PetDefinition */
function manifestToPet(
  manifest: ValidatedManifest,
  packDir: string,
  source: PetSource
): PetDefinition {
  const states: Partial<Record<PetState, string>> = {}
  for (const [state, rel] of Object.entries(manifest.states)) {
    if (rel) states[state as PetState] = pathToFileURL(join(packDir, rel)).href
  }
  const thumbnailUrl = manifest.thumbnail
    ? pathToFileURL(join(packDir, manifest.thumbnail)).href
    : states.idle // 没缩略图就用 idle 素材当预览
  return {
    id: manifest.id,
    name: manifest.name,
    kind: 'image-pack',
    source,
    accentColor: manifest.accentColor,
    description: manifest.description,
    thumbnailUrl,
    states
  }
}

/** 扫一个根目录下的所有子目录皮肤包，校验通过的转成 PetDefinition */
function loadPacksFrom(root: string, source: PetSource): PetDefinition[] {
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const pets: PetDefinition[] = []
  for (const entry of entries) {
    const packDir = join(root, entry)
    try {
      if (!statSync(packDir).isDirectory()) continue
    } catch {
      continue
    }
    const res = readAndValidateManifest(packDir)
    if (!res.ok) continue // 坏包安静跳过，不让一个坏包毁掉整个列表
    pets.push(manifestToPet(res.manifest, packDir, source))
  }
  return pets
}

/**
 * 构建完整 catalog。去重规则：legacy SVG 优先，官方次之，导入最后；
 * 同 id 冲突时保留先出现的（避免导入包冒充内置 id）。
 */
export function getPetCatalog(): PetDefinition[] {
  const result: PetDefinition[] = []
  const seen = new Set<string>()
  const push = (pets: PetDefinition[]): void => {
    for (const p of pets) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      result.push(p)
    }
  }
  push(PETS) // legacy SVG（已带 source:'official'）
  push(loadPacksFrom(officialPacksRoot(), 'official'))
  push(loadPacksFrom(importedPacksRoot(), 'imported'))
  // v0.4：我们自己导入/在线库装的 PetDex 宠物（userData/pet-packs/petdex）
  push(loadPetdexPacksFrom(petdexImportedRoot(), 'imported'))
  // v0.4：PetDex CLI 装的宠物（~/.codex/pets），只读纳入——复用整个社区生态
  push(loadPetdexPacksFrom(codexPetsRoot(), 'imported'))
  return result
}

/** 按 id 取宠物；找不到返回 undefined（调用方负责 fallback） */
export function findPetInCatalog(id: string): PetDefinition | undefined {
  return getPetCatalog().find((p) => p.id === id)
}
