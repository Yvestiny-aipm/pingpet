import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_CANDIDATE_DISCLAIMER,
  OFFICIAL_DISCOVER_MAX_PEEK_BYTES,
  classifyOfficialJsonlSample,
  discoverOfficialExecJsonl,
  officialExecMarkdown,
  peekOfficialJsonlHead
} from './codexOfficialDiscover'

describe('官方 exec JSONL 可用性', () => {
  it('仓库 fixture 不算真实官方流，无真实文件时输出 BLOCKED', () => {
    const projectRoot = process.cwd()
    const info = discoverOfficialExecJsonl({ projectRoot })
    expect(info.realOfficialFileCount).toBe(0)
    expect(info.fixtureFileCount).toBeGreaterThan(0)
    expect(info.verdict).toBe('BLOCKED')
    expect(info.summary).toContain('官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。')
    expect(info.cannotObtainBecause.some((line) => line.includes('fixture'))).toBe(true)
    expect(info.cannotObtainBecause.some((line) => line.includes('当前扫描未找到 ≠ Codex 不支持'))).toBe(
      true
    )
    expect(info.checkedLocations.some((loc) => loc.label.includes('.codex/sessions'))).toBe(true)
    expect(info.checkedLocations.some((loc) => loc.label.includes('codex') && loc.label.includes('可执行'))).toBe(
      true
    )
    expect(info.unverifiedOfficialEvents).toContain('thread.started')
    expect(info.unverifiedOfficialEvents).toContain('turn.failed')
    expect(info.scanBounds.maxFilesPerDir).toBeGreaterThan(0)
    expect(info.scanBounds.maxBytesPerFile).toBe(OFFICIAL_DISCOVER_MAX_PEEK_BYTES)
    expect(info.scanBounds.maxLinesPerFile).toBeGreaterThan(0)
    const md = officialExecMarkdown(info).join('\n')
    expect(md).toContain('BLOCKED')
    expect(md).not.toMatch(/\/Users\/czy/)
    expect(md).toContain('不能据此判断协议是否支持')
    expect(md).toContain('扫描边界')
    expect(md).toContain('每个目录最多检查')
    expect(md).toContain('每个文件最多读取')
    expect(md).toContain('当前扫描未找到 ≠ Codex 不支持')
    expect(md).toContain('发现候选 ≠ 协议已验证')
  })

  it('额外 fixture 根不会把结论抬成真实官方流', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-official-fix-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fake-exec.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n`)
    const info = discoverOfficialExecJsonl({
      extraRoots: [{ abs: dir, label: 'test-fixture-root', fixture: true }]
    })
    expect(info.realOfficialFileCount).toBe(0)
    expect(info.verdict).toBe('BLOCKED')
  })

  it('只有 turn.failed 的官方 JSONL 也能被发现器识别', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-official-failed-'))
    writeFileSync(join(dir, 'only-failed.jsonl'), `${JSON.stringify({ error: { message: 'x' }, type: 'turn.failed' })}\n`)
    const info = discoverOfficialExecJsonl({
      extraRoots: [{ abs: dir, label: 'only-turn-failed', fixture: false }]
    })
    expect(info.realOfficialFileCount).toBe(1)
    expect(info.verdict).toBe('PARTIAL')
    expect(info.candidateNote).toBe(OFFICIAL_CANDIDATE_DISCLAIMER)
    expect(info.summary).toContain(OFFICIAL_CANDIDATE_DISCLAIMER)
    expect(info.summary).not.toContain('协议已验证')
    expect(info.unverifiedOfficialEvents).toContain('turn.failed')
  })

  it('只有 error 的官方 JSONL 也能被发现器识别', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-official-err-'))
    writeFileSync(join(dir, 'only-error.jsonl'), `${JSON.stringify({ message: 'boom', type: 'error' })}\n`)
    const info = discoverOfficialExecJsonl({
      extraRoots: [{ abs: dir, label: 'only-error', fixture: false }]
    })
    expect(info.realOfficialFileCount).toBe(1)
    expect(info.verdict).toBe('PARTIAL')
    expect(info.candidateNote).toBe(OFFICIAL_CANDIDATE_DISCLAIMER)
  })

  it('不同 JSON 空格和字段顺序不会影响发现', () => {
    expect(classifyOfficialJsonlSample('{ "type" : "turn.failed" , "error" : {} }').isCandidate).toBe(true)
    expect(classifyOfficialJsonlSample('{"error":{"message":"x"},"type":"turn.failed"}').isCandidate).toBe(
      true
    )
    expect(
      classifyOfficialJsonlSample(`{
  "id": "e1",
  "type": "error"
}`)
    ).toMatchObject({ isCandidate: true, officialTypes: ['error'] })
    expect(classifyOfficialJsonlSample('{"type":"session_meta"}').isCandidate).toBe(false)
  })

  it('大文件不会一次性加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-official-big-'))
    const file = join(dir, 'huge.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'error' })}\n${'x'.repeat(2_000_000)}`)
    const peek = peekOfficialJsonlHead(file)
    expect(peek.bytesRead).toBeLessThanOrEqual(OFFICIAL_DISCOVER_MAX_PEEK_BYTES)
    expect(peek.bytesRead).toBeLessThan(2_000_000)
    expect(peek.truncatedByBytes).toBe(true)
    expect(classifyOfficialJsonlSample(peek.text).isCandidate).toBe(true)
    const info = discoverOfficialExecJsonl({
      extraRoots: [{ abs: dir, label: 'huge-root', fixture: true }]
    })
    expect(info.scanBounds.anyHitByteCap).toBe(true)
    expect(info.verdict).toBe('BLOCKED')
  })
})
