import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 皮肤包路径计算（v0.3）。
 *
 * - 官方内置皮肤包：随 App 打包发布。
 *   - dev：项目里的 `resources/pet-packs/official/`
 *   - packaged：`process.resourcesPath/pet-packs/official/`（由 electron-builder extraResources 打入）
 * - 用户导入皮肤包：`userData/pet-packs/imported/`（跨环境一致，可读写）。
 */

/** 官方内置皮肤包根目录 */
export function officialPacksRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'pet-packs', 'official')
  }
  // dev：从项目根找。app.getAppPath() 在 dev 指向项目根（含 package.json）
  return join(app.getAppPath(), 'resources', 'pet-packs', 'official')
}

/** 用户导入皮肤包根目录（可读写，跨 dev/packaged 一致） */
export function importedPacksRoot(): string {
  return join(app.getPath('userData'), 'pet-packs', 'imported')
}

/**
 * v0.4：PetDex / Codex 宠物库目录（`~/.codex/pets`）。
 * 用户用 `npx petdex install <名字>` 装的宠物会落在这里；我们只读扫描、自动纳入 catalog，
 * 从而免费复用整个 PetDex 社区生态（几千只 spritesheet 宠物）。
 */
export function codexPetsRoot(): string {
  return join(homedir(), '.codex', 'pets')
}

/**
 * v0.4：我们自己管理的 PetDex 格式宠物目录（userData/pet-packs/petdex）。
 * 用户在 App 内导入 zip/文件夹、或从在线库一键安装的 spritesheet 宠物落在这里
 * （不往 ~/.codex/pets 里写——那是 PetDex CLI 的地盘，我们只读它）。
 */
export function petdexImportedRoot(): string {
  return join(app.getPath('userData'), 'pet-packs', 'petdex')
}

/** 某个已导入 PetDex 宠物的目录 */
export function petdexImportedDir(slug: string): string {
  return join(petdexImportedRoot(), slug)
}

/** 某个已导入皮肤包的目录 */
export function importedPackDir(petId: string): string {
  return join(importedPacksRoot(), petId)
}
