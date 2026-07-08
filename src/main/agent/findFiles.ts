import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface FoundFile {
  path: string
  mtimeMs: number
}

/**
 * 递归找出某个根目录下最近修改的 .jsonl / .json 文件。
 * 全部本地、防御式：任何目录读不了都静默跳过，绝不抛错。
 *
 * @param root      根目录（如 ~/.codex/sessions）
 * @param exts      要匹配的后缀（含点，如 ['.jsonl']）
 * @param maxFiles  最多返回几个（按 mtime 倒序取最近的）
 * @param maxDepth  递归深度上限
 */
export function findRecentFiles(
  root: string,
  exts: string[],
  maxFiles: number,
  maxDepth: number
): string[] {
  const found: FoundFile[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // 目录不存在 / 无权限：安静跳过
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue // 跳过隐藏文件/目录
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
      } else if (stat.isFile() && exts.some((e) => name.endsWith(e))) {
        found.push({ path: full, mtimeMs: stat.mtimeMs })
      }
    }
  }

  walk(root, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, maxFiles).map((f) => f.path)
}
