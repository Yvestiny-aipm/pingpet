import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIVE_REPORT_BLOCKED,
  UNMATCHED_CORRELATION,
  buildCodexLiveShadowReport,
  runCodexLiveShadowReportFromDefaultDirs,
  writeCodexLiveShadowDocs
} from './codexLiveShadowReport'

const NOW = 1_700_000_000_000

function writeDir(lines: { legacy?: string[]; shadow?: string[]; candidate?: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-live-report-'))
  if (lines.legacy) writeFileSync(join(dir, 'codex-legacy.jsonl'), lines.legacy.join('\n') + '\n')
  if (lines.shadow) writeFileSync(join(dir, 'codex-shadow.jsonl'), lines.shadow.join('\n') + '\n')
  if (lines.candidate) writeFileSync(join(dir, 'codex-candidate.jsonl'), lines.candidate.join('\n') + '\n')
  return dir
}

function pick<T>(extra: Record<string, unknown>, key: string, fallback: T): T | undefined {
  if (Object.prototype.hasOwnProperty.call(extra, key)) return extra[key] as T | undefined
  return fallback
}

function legacy(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'codex_legacy_diagnostic',
    userVisible: false,
    track: 'legacy_monitor',
    observationId: extra.observationId ?? 'legacy:1',
    seq: 1,
    fileAlias: pick(extra, 'fileAlias', 'file-aaaa'),
    sessionKey: pick(extra, 'sessionKey', 'sess-aaaa'),
    threadId: 'unknown',
    turnId: 'unknown',
    legacyKind: extra.legacyKind ?? 'working',
    observedAt: extra.observedAt ?? NOW,
    eventTime: extra.eventTime ?? NOW,
    dispatched: extra.dispatched ?? true,
    ignoredBy: extra.ignoredBy ?? [],
    productionVisible: extra.productionVisible ?? true
  })
}

function shadow(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'codex_shadow_diagnostic',
    userVisible: false,
    track: 'codex_shadow',
    observationId: extra.observationId ?? 'shadow:1',
    seq: 1,
    fileAlias: pick(extra, 'fileAlias', 'file-aaaa'),
    sessionId: pick(extra, 'sessionId', 'sess-aaaa'),
    threadId: extra.threadId ?? 'unknown',
    turnId: extra.turnId ?? 'unknown',
    lifecycle: extra.lifecycle ?? 'running',
    cause: extra.cause ?? 'unknown',
    process: extra.process ?? 'not_observed',
    connection: extra.connection ?? 'connected',
    item: extra.item ?? 'none',
    outputIntegrity: extra.outputIntegrity ?? 'unknown',
    confidence: extra.confidence ?? 'high',
    observedAt: extra.observedAt ?? NOW,
    eventTime: extra.eventTime ?? null,
    migrationObservedAt: extra.migrationObservedAt ?? NOW,
    source: extra.source ?? 'session_jsonl',
    ignoredBy: [],
    productionVisible: false
  })
}

function candidate(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'codex_candidate_diagnostic',
    userVisible: false,
    track: 'codex_candidate',
    observationId: extra.observationId ?? 'shadow:1',
    seq: 1,
    fileAlias: pick(extra, 'fileAlias', 'file-aaaa'),
    sessionId: pick(extra, 'sessionId', 'sess-aaaa'),
    threadId: 'unknown',
    turnId: 'unknown',
    derived: {
      lifecycle: extra.lifecycle ?? 'completed_signal',
      cause: extra.cause ?? 'tool_failed',
      process: 'not_observed',
      connection: 'connected',
      session: 'active',
      turn: extra.turn ?? 'completed',
      item: extra.item ?? 'partial_failure',
      outputIntegrity: extra.outputIntegrity ?? 'partial',
      taskSemantics: 'not_verified',
      retryability: extra.retryability ?? 'unknown',
      confidence: 'high'
    },
    candidate: extra.candidate ?? 'completed_with_partial_failure',
    legacyEquivalent: extra.legacyEquivalent ?? 'needs_attention',
    candidatePetState: extra.candidatePetState ?? 'cautious',
    notificationCandidate: 'candidate_attention',
    shouldNotify: extra.shouldNotify ?? false,
    requiresUserAction: true,
    retryRecommendation: 'user_decision',
    reasonCodes: extra.reasonCodes ?? ['turn_completed_with_item_failure'],
    confidence: 'high',
    observedAt: extra.observedAt ?? NOW,
    eventTime: null,
    migrationObservedAt: NOW,
    source: extra.source ?? 'session_jsonl',
    observationSource: extra.observationSource ?? 'session_jsonl',
    productionVisible: false
  })
}

describe('真实运行影子对照报告（测试数据，不是真实运行）', () => {
  it('三个诊断文件都存在时生成对照报告', () => {
    const dir = writeDir({
      legacy: [legacy({ legacyKind: 'done' })],
      shadow: [shadow({ lifecycle: 'completed_signal', item: 'partial_failure', cause: 'tool_failed' })],
      candidate: [candidate()]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: NOW - 1000 })
    expect(report.conclusion).toBe('PARTIAL')
    expect(report.present).toEqual(['codex-legacy.jsonl', 'codex-shadow.jsonl', 'codex-candidate.jsonl'])
    expect(report.markdown).toContain('三个诊断文件均存在')
    expect(report.markdown).toContain('session 级对照')
    expect(report.markdown).toContain('不能做完整 turn 级一一对应')
  })

  it('只有一个或两个诊断文件存在时生成 PARTIAL', () => {
    const one = writeDir({ legacy: [legacy()] })
    const two = writeDir({ legacy: [legacy()], shadow: [shadow()] })
    const r1 = buildCodexLiveShadowReport({ diagnosticsDir: one, nowMs: NOW, sinceMs: 0 })
    const r2 = buildCodexLiveShadowReport({ diagnosticsDir: two, nowMs: NOW, sinceMs: 0 })
    expect(r1.conclusion).toBe('PARTIAL')
    expect(r2.conclusion).toBe('PARTIAL')
    expect(r1.missing).toContain('codex-shadow.jsonl')
    expect(r1.markdown).toContain('缺失路径不计入状态不一致')
  })

  it('三个文件都不存在时输出 BLOCKED_NO_LIVE_DATA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-live-empty-'))
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.conclusion).toBe(LIVE_REPORT_BLOCKED)
    expect(report.markdown).toContain(LIVE_REPORT_BLOCKED)
    expect(report.markdown).toContain('不能用单元测试或 fixture 冒充真实运行')
    expect(report.missing).toHaveLength(3)
  })

  it('session 级关联成功', () => {
    const dir = writeDir({
      legacy: [legacy({ sessionKey: 'sess-same', legacyKind: 'working' })],
      shadow: [shadow({ sessionId: 'sess-same', lifecycle: 'running' })],
      candidate: [candidate({ sessionId: 'sess-same', candidate: 'working', lifecycle: 'running', item: 'none', cause: 'unknown' })]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('一致')
    expect(report.markdown).toContain('session:sess-same')
    expect(report.markdown).not.toContain(`| ${UNMATCHED_CORRELATION} |`)
  })

  it('无法可靠关联时标记 UNMATCHED_CORRELATION', () => {
    const dir = writeDir({
      legacy: [legacy({ sessionKey: undefined, fileAlias: undefined, observationId: 'legacy:x' })],
      shadow: [shadow({ sessionId: undefined, fileAlias: undefined, observationId: 'shadow:y' })],
      candidate: [candidate({ sessionId: undefined, fileAlias: undefined, observationId: 'shadow:z' })]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain(UNMATCHED_CORRELATION)
    expect(report.markdown).toContain('关联失败')
    expect(report.markdown).toContain('不能按时间或顺序猜 turn')
  })

  it('fileAlias 一致但 session 哈希不同时仍可关联，不按时间猜', () => {
    const dir = writeDir({
      legacy: [legacy({ sessionKey: 'sess-legacy', fileAlias: 'file-shared', legacyKind: 'done' })],
      shadow: [
        shadow({
          sessionId: 'sess-shadow',
          fileAlias: 'file-shared',
          lifecycle: 'completed_signal',
          item: 'unknown',
          cause: 'unknown'
        })
      ],
      candidate: [
        candidate({
          sessionId: 'sess-shadow',
          fileAlias: 'file-shared',
          candidate: 'completed_signal',
          lifecycle: 'completed_signal',
          item: 'unknown',
          cause: 'unknown'
        })
      ]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('fileAlias=`file-shared`')
    expect(report.markdown).toContain('session 哈希不一致')
    expect(report.markdown).toContain('一致')
    expect(report.markdown).not.toContain(`| ${UNMATCHED_CORRELATION} |`)
  })

  it('不会根据时间和顺序猜造 turnId', () => {
    const dir = writeDir({
      legacy: [legacy({ sessionKey: 'sess-a', fileAlias: 'file-a', eventTime: NOW, observedAt: NOW })],
      shadow: [
        shadow({
          sessionId: 'sess-b',
          fileAlias: 'file-b',
          eventTime: NOW,
          observedAt: NOW + 1,
          threadId: 'unknown',
          turnId: 'unknown'
        })
      ]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).not.toMatch(/turn-[a-z0-9]+/)
    expect(report.markdown).toContain('不是完整 turn 级对照')
  })

  it('completed_signal + partial_failure 被识别为 completed_with_partial_failure', () => {
    const dir = writeDir({
      legacy: [legacy({ legacyKind: 'done' })],
      shadow: [shadow({ lifecycle: 'completed_signal', item: 'partial_failure', cause: 'tool_failed' })],
      candidate: [candidate()]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('completed_with_partial_failure')
    expect(report.markdown).toContain('候选状态更谨慎')
    expect(report.markdown).toContain('普通 0，partial_failure 1')
  })

  it('incomplete/process_exit 不被识别为 cancelled', () => {
    const dir = writeDir({
      shadow: [shadow({ lifecycle: 'incomplete', cause: 'process_exit', item: 'running' })],
      candidate: [
        candidate({
          candidate: 'incomplete',
          lifecycle: 'incomplete',
          cause: 'process_exit',
          item: 'running',
          reasonCodes: ['process_exit']
        })
      ]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('incomplete/process_exit 未变成 cancelled：是')
    expect(report.markdown).not.toContain('candidate=cancelled')
  })

  it('unknown 不被识别为 failed/succeeded', () => {
    const dir = writeDir({
      shadow: [shadow({ lifecycle: 'unknown', cause: 'unknown' })],
      candidate: [
        candidate({
          candidate: 'unknown',
          legacyEquivalent: 'unknown',
          lifecycle: 'unknown',
          cause: 'unknown',
          item: 'none'
        })
      ]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('unknown 未被猜成 failed/succeeded：是')
    expect(report.markdown).toContain('不等于任务成功')
    expect(report.markdown).not.toMatch(/(?<!不等于)任务成功/)
    expect(report.markdown).not.toContain('新检测器错误')
  })

  it('shouldNotify 始终为 false', () => {
    const dir = writeDir({
      candidate: [candidate({ shouldNotify: false }), candidate({ observationId: 'shadow:2', shouldNotify: false })]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('shouldNotify 始终 false：是')
    expect(report.markdown).toContain('shouldNotify=true：0')
  })

  it('敏感字段不会出现在报告中', () => {
    const dir = writeDir({
      legacy: [legacy()],
      shadow: [shadow()],
      candidate: [candidate()]
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).not.toMatch(/prompt|assistant 正文|sk-|api_key|\/Users\//i)
    expect(report.markdown).not.toContain(dir)
  })

  it('重复 observationId 不重复统计', () => {
    const line = shadow({ observationId: 'shadow:dup' })
    const dir = writeDir({ shadow: [line, line, line] })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.markdown).toContain('解析 3')
    expect(report.markdown).toContain('去重后 1')
    expect(report.markdown).toContain('重复 observationId 2')
  })

  it('malformed 行不会导致报告失败', () => {
    const dir = writeDir({
      shadow: ['{not json', shadow(), '']
    })
    const report = buildCodexLiveShadowReport({ diagnosticsDir: dir, nowMs: NOW, sinceMs: 0 })
    expect(report.conclusion).toBe('PARTIAL')
    expect(report.markdown).toContain('malformed 1')
  })

  it('字节上限截断时报告明确标记', () => {
    const dir = writeDir({
      shadow: [shadow({ observationId: 'shadow:a' }), shadow({ observationId: 'shadow:b' })]
    })
    const report = buildCodexLiveShadowReport({
      diagnosticsDir: dir,
      nowMs: NOW,
      sinceMs: 0,
      maxBytesPerFile: 80
    })
    expect(report.markdown).toContain('因字节上限截断')
  })
})

describe('真实诊断目录写文档', () => {
  it('有真实诊断则写对照报告，否则写 BLOCKED 报告；不用 fixture 冒充', () => {
    const docsDir = resolve(process.cwd(), 'docs')
    mkdirSync(docsDir, { recursive: true })
    const { report } = runCodexLiveShadowReportFromDefaultDirs(Date.now())
    const out = writeCodexLiveShadowDocs(docsDir, report)
    if (report.conclusion === LIVE_REPORT_BLOCKED) {
      expect(out).toContain('codex-live-shadow-comparison-blocked.md')
      expect(report.markdown).toContain('不能用单元测试或 fixture 冒充真实运行')
    } else {
      expect(out).toContain('codex-live-shadow-comparison.md')
      expect(report.present.length).toBeGreaterThan(0)
    }
    expect(report.markdown).toContain('仍不能替换正式 Monitor')
    expect(report.markdown).toContain('真实运行数据')
    expect(report.markdown).toContain('fixture')
    expect(report.markdown).not.toMatch(/\/Users\//)
  })
})
