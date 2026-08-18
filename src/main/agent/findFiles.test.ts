import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { findRecentFiles, findRecentFilesAcross } from './findFiles'

const NOW = 1_700_000_000_000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pet-findfiles-test-'))
})

/** 写一个文件并把 mtime 精确设到「NOW 之前 ageMs 毫秒」 */
function file(relPath: string, ageMs: number): string {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x')
  const sec = (NOW - ageMs) / 1000
  utimesSync(full, sec, sec)
  return full
}

function names(paths: string[]): string[] {
  return paths.map((p) => basename(p))
}

describe('新鲜度闸门（minMtimeMs）', () => {
  it('挡掉 mtime 过老的文件——它们不可能产出新鲜事件，读了纯白费', () => {
    file('fresh.jsonl', 10_000)
    file('stale.jsonl', 10 * 60_000)
    const got = findRecentFiles(root, ['.jsonl'], 12, 5, { minMtimeMs: NOW - 240_000 })
    expect(names(got)).toEqual(['fresh.jsonl'])
  })

  it('刚好在边界上的文件保留（用 >= 而不是 >，避免边界抖动漏事件）', () => {
    file('edge.jsonl', 240_000)
    const got = findRecentFiles(root, ['.jsonl'], 12, 5, { minMtimeMs: NOW - 240_000 })
    expect(names(got)).toEqual(['edge.jsonl'])
  })

  it('不传 minMtimeMs 时行为不变，多老的文件也照样返回', () => {
    file('ancient.jsonl', 400 * 24 * 3600_000)
    expect(names(findRecentFiles(root, ['.jsonl'], 12, 5))).toEqual(['ancient.jsonl'])
  })
})

describe('基本扫描行为', () => {
  it('按 mtime 从新到旧排序', () => {
    file('old.jsonl', 30_000)
    file('new.jsonl', 1_000)
    file('mid.jsonl', 10_000)
    expect(names(findRecentFiles(root, ['.jsonl'], 12, 5))).toEqual([
      'new.jsonl',
      'mid.jsonl',
      'old.jsonl'
    ])
  })

  it('只取最近的 maxFiles 个', () => {
    for (let i = 0; i < 5; i++) file(`f${i}.jsonl`, i * 1000)
    expect(findRecentFiles(root, ['.jsonl'], 2, 5)).toHaveLength(2)
  })

  it('只匹配指定后缀', () => {
    file('a.jsonl', 1000)
    file('b.log', 1000)
    file('c.json', 1000)
    expect(names(findRecentFiles(root, ['.jsonl'], 12, 5))).toEqual(['a.jsonl'])
  })

  it('跳过隐藏文件与隐藏目录', () => {
    file('.hidden.jsonl', 1000)
    file('.git/inside.jsonl', 1000)
    file('visible.jsonl', 1000)
    expect(names(findRecentFiles(root, ['.jsonl'], 12, 5))).toEqual(['visible.jsonl'])
  })

  it('递归深度超过上限的不再深入', () => {
    file('a/b/c/deep.jsonl', 1000)
    expect(findRecentFiles(root, ['.jsonl'], 12, 1)).toEqual([])
    expect(names(findRecentFiles(root, ['.jsonl'], 12, 5))).toEqual(['deep.jsonl'])
  })

  it('目录不存在时安静返回空，不抛错', () => {
    expect(findRecentFiles(join(root, 'nope'), ['.jsonl'], 12, 5)).toEqual([])
  })
})

describe('多根扫描（Cursor 用）', () => {
  it('跨多个根统一按 mtime 排序取最近的', () => {
    const a = join(root, 'ws-a')
    const b = join(root, 'ws-b')
    file('ws-a/older.jsonl', 20_000)
    file('ws-b/newer.jsonl', 5_000)
    expect(names(findRecentFilesAcross([a, b], ['.jsonl'], 12, 5))).toEqual([
      'newer.jsonl',
      'older.jsonl'
    ])
  })

  it('其中一个根不存在时不影响其它根', () => {
    file('ws-a/ok.jsonl', 1000)
    const got = findRecentFilesAcross([join(root, 'ws-a'), join(root, 'missing')], ['.jsonl'], 12, 5)
    expect(names(got)).toEqual(['ok.jsonl'])
  })
})
