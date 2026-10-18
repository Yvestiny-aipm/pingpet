import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectCoverageSamples, sessionAlias } from './codexReplay'

const NOW = 1_700_000_000_000

function iso(at: number): string {
  return new Date(at).toISOString()
}

function writeJsonl(dir: string, name: string, lines: unknown[], mtimeSec?: number): string {
  const path = join(dir, `${name}.jsonl`)
  const body = lines.map((line) => JSON.stringify(line)).join('\n')
  writeFileSync(path, name.includes('nolf') ? body : `${body}\n`)
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
  return path
}

function session(sessionId: string, extra: unknown[], at = NOW): unknown[] {
  return [
    {
      timestamp: iso(at),
      type: 'session_meta',
      payload: { session_id: sessionId, originator: 'codex_cli', source: 'cli' }
    },
    ...extra
  ]
}

describe('按事件覆盖选择回放样本', () => {
  it('按覆盖桶挑选，而不是只取前几个小文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-cov-'))
    mkdirSync(dir, { recursive: true })
    const oldSec = Math.floor((NOW - 86_400_000) / 1000)
    const recentSec = Math.floor(NOW / 1000)

    const paths: string[] = []
    for (let i = 0; i < 6; i += 1) {
      paths.push(
        writeJsonl(
          dir,
          `tiny-${i}`,
          session(`tiny-${i}`, [
            { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'token_count', info: { n: i } } }
          ]),
          recentSec - 10
        )
      )
    }

    paths.push(
      writeJsonl(
        dir,
        'complete',
        session('sess-complete', [
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }
        ]),
        recentSec - 20
      )
    )
    paths.push(
      writeJsonl(
        dir,
        'toolfail',
        session('sess-fail', [
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
          {
            timestamp: iso(NOW),
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              turn_id: 't1',
              item: { id: 'x', type: 'CommandExecution', status: 'failed' }
            }
          }
        ]),
        recentSec - 15
      )
    )
    paths.push(
      writeJsonl(
        dir,
        'multi',
        session('sess-multi', [
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
          { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }
        ]),
        recentSec - 12
      )
    )
    paths.push(
      writeJsonl(
        dir,
        'oldone',
        session('sess-old', [{ timestamp: iso(NOW - 86_400_000), type: 'event_msg', payload: { type: 'token_count' } }], NOW - 86_400_000),
        oldSec
      )
    )
    paths.push(
      writeJsonl(
        dir,
        'recent',
        session('sess-recent', [{ timestamp: iso(NOW), type: 'event_msg', payload: { type: 'token_count' } }]),
        recentSec
      )
    )
    paths.push(writeJsonl(dir, 'bad', [{ timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started' } }, 'not-json']))
    const leftoverPath = join(dir, 'leftover.jsonl')
    writeFileSync(
      leftoverPath,
      `${JSON.stringify(session('sess-left', [])[0])}\n{"type":"event_msg","payload":{"type":"task_started"`
    )
    utimesSync(leftoverPath, recentSec - 8, recentSec - 8)
    paths.push(leftoverPath)

    const largeLines: unknown[] = session('sess-large', [
      { timestamp: iso(NOW), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', pad: 'x'.repeat(80) } }
    ])
    for (let i = 0; i < 12_000; i += 1) {
      largeLines.push({
        timestamp: iso(NOW),
        type: 'event_msg',
        payload: { type: 'token_count', info: { pad: 'y'.repeat(120), i } }
      })
    }
    paths.push(writeJsonl(dir, 'large', largeLines, recentSec - 5))

    const aliases = paths.map((_, i) => sessionAlias(i))
    const selection = selectCoverageSamples({
      paths,
      aliases,
      nowMs: NOW,
      maxDetail: 8,
      probeBytes: 256_000
    })

    const reasonSet = new Set(selection.picks.flatMap((p) => p.reasons))
    expect(reasonSet.has('completed_session')).toBe(true)
    expect(reasonSet.has('item_or_tool_failure')).toBe(true)
    expect(reasonSet.has('multi_turn')).toBe(true)
    expect(reasonSet.has('recently_active')).toBe(true)
    expect(reasonSet.has('older_history')).toBe(true)
    expect(reasonSet.has('unknown_or_malformed') || reasonSet.has('incomplete_last_line')).toBe(true)
    expect(reasonSet.has('large_incremental')).toBe(true)
    expect(selection.notReplayedCount).toBeGreaterThan(0)
    expect(selection.note).toContain('按事件覆盖')
    expect(selection.directoryFileCount).toBe(paths.length)
    const tinyPicked = selection.picks.filter((p) => p.alias && p.filePath.includes('tiny-')).length
    expect(tinyPicked).toBeLessThan(6)
    const largePick = selection.picks.find((p) => p.reasons.includes('large_incremental'))
    expect(largePick?.maxBytes).toBeLessThanOrEqual(512_000)
  })
})
