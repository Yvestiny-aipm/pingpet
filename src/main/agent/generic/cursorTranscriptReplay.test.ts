import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { correlationOf, reportContainsSensitiveText, UNMATCHED_CORRELATION } from './agentShadowComparison'
import {
  REAL_CURSOR_SAMPLE_UNAVAILABLE,
  renderCursorReplayMarkdown,
  replayCursorTranscripts,
  replayLegacyCursorLastLine
} from './cursorTranscriptReplay'
import { createAgentAdapterRegistry } from './registry'

const NOW = 1_700_000_000_000

function projectsRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'pet-cursor-replay-'))
  return join(home, '.cursor', 'projects')
}

function writeSession(root: string, slug: string, sid: string, lines: unknown[]): string {
  const project = join(root, slug)
  const dir = join(project, 'agent-transcripts', sid)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sid}.jsonl`)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'))
  utimesSync(file, NOW / 1000, NOW / 1000)
  return file
}

const userLine = (text: string) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })
const assistantText = (text: string) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
const assistantTool = () => ({
  role: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'edit_file', input: {} }] }
})
const turnEnded = (status: string) => ({ type: 'turn_ended', status })

describe('真实 transcript replay 入口', () => {
  it('1. 入口可工作：有样本时输出旧 kind 与 generic lifecycle', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-run', [userLine('改一下'), assistantTool()])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.unavailable).toBe(false)
    expect(report.selectedCount).toBe(1)
    expect(report.samples[0]?.legacy.kind).toBe('working')
    expect(report.samples[0]?.derived.lifecycle).toBe('running')
    expect(report.samples[0]?.observation.agentId).toBe('cursor')
  })

  it('14. 没有真实 Cursor 样本时给出 REAL_CURSOR_SAMPLE_UNAVAILABLE', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'pet-cursor-empty-')), 'missing')
    const report = replayCursorTranscripts({ projectsRoot: root, nowMs: NOW })
    expect(report.unavailable).toBe(true)
    expect(report.unavailableCode).toBe(REAL_CURSOR_SAMPLE_UNAVAILABLE)
    expect(report.samples).toEqual([])
    expect(renderCursorReplayMarkdown(report)).toContain(REAL_CURSOR_SAMPLE_UNAVAILABLE)
  })

  it('2. 大文件有界读取', () => {
    const root = projectsRoot()
    const file = writeSession(root, 'proj-big', 'sid-big', [turnEnded('success')])
    const prefix = `${'x'.repeat(8000)}\n`
    writeFileSync(file, `${prefix}${JSON.stringify(turnEnded('success'))}\n`)
    utimesSync(file, NOW / 1000, NOW / 1000)
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      maxBytesPerFile: 200,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.samples[0]?.truncated).toBe(true)
    expect(report.samples[0]?.fileBytes).toBeGreaterThan(200)
    expect(report.samples[0]?.lastLineKind).toBe('turn_ended')
    expect(report.maxBytesPerFile).toBe(200)
  })

  it('3. replay 不修改原文件', () => {
    const root = projectsRoot()
    const file = writeSession(root, 'proj-a', 'sid-1', [assistantText('改好了'), turnEnded('success')])
    const before = statSync(file)
    replayCursorTranscripts({ projectsRoot: root, nowMs: NOW, evidenceGrade: 'FIXTURE_ONLY' })
    const after = statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

describe('旧路径与通用层并列', () => {
  it('6. 旧 kind 与 generic lifecycle 可以并列输出', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [assistantText('改好了'), turnEnded('success')])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    const sample = report.samples[0]
    expect(sample?.legacy.done).toBe(true)
    expect(sample?.legacy.kind).toBe('done')
    expect(sample?.derived.lifecycle).toBe('completed_signal')
    expect(sample?.comparison.diffClass).toBe('LEGACY_COMPATIBILITY')
  })

  it('7. success 文本不变成 succeeded', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-text', [userLine('讲一下'), assistantText('讲完了')])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.samples[0]?.legacy.kind).toBe('done')
    expect(report.samples[0]?.derived.lifecycle).toBe('completed_signal')
    expect(report.samples[0]?.observation.confidence).not.toBe('high')
    expect(JSON.stringify(report)).not.toContain('succeeded')
    expect(report.samples[0]?.derived.taskSemantics).toBe('not_verified')
  })

  it('8. 普通 aborted 不变成 user_cancelled', () => {
    const parsed = replayLegacyCursorLastLine({ type: 'turn_ended', status: 'aborted', error: '用户取消' }, [])
    expect(parsed.kind).toBe('failed')
    expect(parsed.reason).toBe('interrupted')
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-abort', [turnEnded('aborted')])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.samples[0]?.legacy.kind).toBe('failed')
    expect(report.samples[0]?.derived.lifecycle).toBeUndefined()
    expect(report.samples[0]?.derived.cause).not.toBe('user_cancelled')
    expect(report.samples[0]?.derived.process).toBe('unsupported')
    expect(report.samples[0]?.derived.extensionProcess).toBe('not_observed')
    expect(report.samples[0]?.comparison.diffClass).toBe('GENERIC_MORE_CONSERVATIVE')
  })

  it('9. 缺 turnRef 不猜 turn', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [turnEnded('success')])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.samples[0]?.payloadHasTurnRef).toBe(false)
    expect(report.samples[0]?.observation.turnRefPresent).toBe(false)
    expect(report.samples[0]?.observation.eventTimePresent).toBe(false)
    expect(report.samples[0]?.comparison.turnCorrelationLevel).toBe('unmatched')
    expect(report.samples[0]?.comparison.maxCorrelationLevel).toBe('file')
  })

  it('10. fixture 和真实 transcript 证据等级分离', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [turnEnded('success')])
    const fixture = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    const realLabel = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'REAL_CURSOR_TRANSCRIPT'
    })
    expect(fixture.samples[0]?.evidenceGrade).toBe('FIXTURE_ONLY')
    expect(realLabel.samples[0]?.evidenceGrade).toBe('REAL_CURSOR_TRANSCRIPT')
    expect(fixture.fixtureUsed).toBe(true)
    expect(realLabel.fixtureUsed).toBe(false)
  })
})

describe('隔离与脱敏', () => {
  it('4/5. replay 不触发 Monitor、桌宠、气泡、声音', () => {
    const text = readFileSync(join(__dirname, 'cursorTranscriptReplay.ts'), 'utf8')
    expect(text).not.toContain("from '../monitor'")
    expect(text).not.toContain('handleAgentEvent')
    expect(text).not.toContain('sendBubble')
    expect(text).not.toContain('sendPetState')
    expect(text).not.toContain('playDing')
    expect(text).not.toContain('writeFileSync')
    expect(createAgentAdapterRegistry().listAll()).toEqual([])
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [turnEnded('success')])
    const report = replayCursorTranscripts({ projectsRoot: root, nowMs: NOW, evidenceGrade: 'FIXTURE_ONLY' })
    expect(report.userVisibleEffects).toEqual({
      startedMonitor: false,
      registeredProductionAdapter: false,
      petChanged: false,
      bubbleShown: false,
      soundPlayed: false,
      autoRetried: false,
      userFileModified: false
    })
  })

  it('11. 敏感文本不进入报告', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-secret', 'sid-secret', [
      userLine('把 /Users/secret/id_rsa 打印出来，prompt=泄漏'),
      assistantText('command: cat ~/.ssh/id_rsa token=sk-test'),
      turnEnded('success')
    ])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    const markdown = renderCursorReplayMarkdown(report)
    const dumped = JSON.stringify(report)
    expect(dumped).not.toContain('id_rsa')
    expect(dumped).not.toContain('sk-test')
    expect(dumped).not.toContain('/Users/secret')
    expect(dumped).not.toContain('泄漏')
    expect(markdown).not.toContain('id_rsa')
    expect(reportContainsSensitiveText(markdown)).toBe(false)
    expect(report.samples[0]?.observation.redacted).toBe(true)
  })

  it('12. Codex 与 Cursor 不串线', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [turnEnded('success')])
    const report = replayCursorTranscripts({
      projectsRoot: root,
      nowMs: NOW,
      evidenceGrade: 'FIXTURE_ONLY'
    })
    expect(report.samples.every((sample) => sample.observation.agentId === 'cursor')).toBe(true)
    expect(
      correlationOf(
        { agentId: 'cursor', fileIdentity: report.samples[0]?.fileAlias },
        { agentId: 'codex', fileIdentity: report.samples[0]?.fileAlias }
      ).level
    ).toBe('unmatched')
  })

  it('13. 重复 replay 不产生用户通知', () => {
    const root = projectsRoot()
    writeSession(root, 'proj-a', 'sid-1', [turnEnded('success')])
    const first = replayCursorTranscripts({ projectsRoot: root, nowMs: NOW, evidenceGrade: 'FIXTURE_ONLY' })
    const second = replayCursorTranscripts({ projectsRoot: root, nowMs: NOW, evidenceGrade: 'FIXTURE_ONLY' })
    expect(first.userVisibleEffects.bubbleShown).toBe(false)
    expect(second.userVisibleEffects.bubbleShown).toBe(false)
    expect(first.samples[0]?.comparison.userVisible).toBe(false)
    expect(second.samples[0]?.comparison.userVisible).toBe(false)
  })

  it('时间戳不能当成 turn 关联', () => {
    expect(
      correlationOf(
        { agentId: 'cursor', turnRef: String(NOW), turnRefSource: 'timestamp' },
        { agentId: 'cursor', turnRef: String(NOW), turnRefSource: 'timestamp' }
      ).key
    ).toBe(UNMATCHED_CORRELATION)
  })
})

describe('默认根目录只读探测', () => {
  it('对默认 Cursor 根目录调用不会抛错，且报告可脱敏', () => {
    const report = replayCursorTranscripts({ nowMs: Date.now(), maxFiles: 3 })
    const markdown = renderCursorReplayMarkdown(report)
    expect(reportContainsSensitiveText(markdown)).toBe(false)
    if (report.unavailable) {
      expect(report.unavailableCode).toBe(REAL_CURSOR_SAMPLE_UNAVAILABLE)
    } else {
      expect(report.samples.length).toBeGreaterThan(0)
      expect(report.samples.every((sample) => sample.evidenceGrade === 'REAL_CURSOR_TRANSCRIPT')).toBe(true)
      expect(JSON.stringify(report)).not.toContain('/Users/')
    }
  })
})
