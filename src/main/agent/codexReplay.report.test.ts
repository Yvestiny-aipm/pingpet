import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverOfficialExecJsonl } from './codexOfficialDiscover'
import { discoverCodexSessionFiles } from './codexReplay'
import { buildCodexReplayMarkdown, runCodexRealReplay, writeBlockedReplayDocs, writeCodexReplayDocs } from './codexReplayReport'
import { emptyCodexDerivedState } from './codexState'

describe('真实 session 对照文档', () => {
  it('报告明确区分样本未覆盖和协议不支持', () => {
    const official = discoverOfficialExecJsonl({ projectRoot: process.cwd() })
    const md = buildCodexReplayMarkdown({
      projectVersion: '0.6.2',
      investigatedAt: '2026-09-12',
      codexVersionNote: 'test',
      discovery: {
        root: '$HOME/.codex/sessions',
        rootExists: true,
        files: [
          { alias: 'session-001', size: 100, mtimeMs: 1, readable: true },
          { alias: 'session-002', size: 200, mtimeMs: 2, readable: true }
        ]
      },
      results: [
        {
          alias: 'session-001',
          size: 100,
          mtimeMs: 1,
          replayedBytes: 50,
          truncated: true,
          hasSessionId: true,
          hasThreadId: false,
          hasTurnId: false,
          eventTypeCounts: { 'event_msg.task_started': 1 },
          unknownCount: 0,
          malformedCount: 0,
          unsupportedCount: 0,
          itemFailedCount: 0,
          turnStartedCount: 1,
          turnCompletedCount: 0,
          turnFailedCount: 0,
          abortCount: 0,
          officialStructuredCount: 0,
          oldEvents: [],
          newFinal: { ...emptyCodexDerivedState(1), lifecycle: 'running' },
          newRows: [],
          comparisons: [],
          selectionReasons: ['large_incremental']
        }
      ],
      selection: {
        directoryFileCount: 2,
        probedCount: 1,
        skippedProbeCount: 1,
        picks: [],
        notReplayedCount: 1,
        note: '按事件覆盖'
      },
      official
    })
    expect(md).toContain('已检查的文件')
    expect(md).toContain('详细回放的文件')
    expect(md).toContain('只做目录统计')
    expect(md).toContain('因体积跳过探测')
    expect(md).toContain('样本未出现')
    expect(md).toContain('无法确认')
    expect(md).toContain('协议尚未验证')
    expect(md).toContain('当前扫描未找到 ≠ Codex 不支持')
    expect(md).toContain('本地 session 出现 `turn_aborted` ≠ 已确认用户取消协议')
    expect(md).toContain('截断回放停在 running，不能写成 Agent 仍在运行')
    expect(md).toContain('当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。')
    expect(md).toContain('eventTime')
    expect(md).toContain('observedAt')
  })

  it(
    '有真实 JSONL 则写对照报告，否则写 BLOCKED 报告',
    () => {
      const docsDir = resolve(process.cwd(), 'docs')
      mkdirSync(docsDir, { recursive: true })
      const discovery = discoverCodexSessionFiles()
      if (!discovery.rootExists || discovery.files.length === 0) {
        const out = resolve(docsDir, 'codex-shadow-real-comparison-blocked.md')
        writeBlockedReplayDocs(out)
        expect(discovery.files).toHaveLength(0)
        return
      }
      const summary = runCodexRealReplay({ nowMs: Date.now(), detailLimit: 8 })
      const out = resolve(docsDir, 'codex-shadow-real-comparison.md')
      writeCodexReplayDocs(out, summary)
      expect(summary.hasRealSessions).toBe(true)
      expect(summary.fileCount).toBeGreaterThan(0)
      expect(summary.markdown).toContain('## 1. 执行结论')
      expect(summary.markdown).toContain('官方 exec JSONL')
      expect(summary.markdown).toContain('生产不可见')
      expect(summary.markdown).toContain('按事件覆盖')
      expect(summary.markdown).toContain('未回放')
      expect(summary.markdown).toContain('不能据此判断协议是否支持')
      expect(summary.markdown).toContain('官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。')
      expect(summary.markdown).toContain('当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。')
      expect(summary.markdown).toContain('文件检查分层')
      expect(summary.markdown).toContain('已检查的文件')
      expect(summary.markdown).toContain('详细回放的文件')
      expect(summary.markdown).toContain('只做目录统计')
      expect(summary.markdown).toContain('因体积跳过探测')
      expect(summary.markdown).toContain('样本未出现')
      expect(summary.markdown).toContain('协议尚未验证')
      expect(summary.markdown).toContain('当前扫描未找到 ≠ Codex 不支持')
      expect(summary.markdown).toContain('本地 session 出现 `turn_aborted` ≠ 已确认用户取消协议')
      expect(summary.markdown).toContain('截断回放停在 running，不能写成 Agent 仍在运行')
      expect(summary.markdown).toContain('eventTime')
      expect(summary.markdown).toContain('observedAt')
      expect(summary.markdown).toContain('session-')
      expect(summary.markdown).not.toMatch(/\/Users\//)
      expect(summary.markdown).not.toContain('sk-')
      expect(summary.officialVerdict === 'BLOCKED' || summary.officialVerdict === 'PARTIAL').toBe(true)
    },
    180_000
  )
})
