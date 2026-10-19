import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentMonitorEvent } from '@shared/types'
import { buildAgentBubbleHead, buildAgentBubbleText } from '../config'
import { mapCodexDerivedToCandidate } from './codexCandidate'
import { scanCodex, codexSessionsRoot } from './codex'
import { AgentMonitor } from './monitor'
import type { MonitorConfig } from './monitor'
import { emptyCodexDerivedState } from './codexState'
import {
  CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED,
  countPresentableDone,
  isCelebratingPetState,
  isCodexLegacyProtocolComplete,
  looksLikeTaskSuccessCopy,
  petStateForPresentedKind,
  petStateForTerminalBatch,
  petStateForTerminalEvent,
  presentableTerminalEvents,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser
} from './codexLegacyPresentation'

const NOW = 1_700_000_000_000
const OFF = { enabled: false, envs: [] }
const CONFIG: MonitorConfig = {
  codex: { enabled: true, envs: ['terminal'] },
  claude: OFF,
  cursor: OFF,
  grok: OFF
}

function ev(
  source: AgentMonitorEvent['source'],
  kind: AgentMonitorEvent['kind'],
  extra: Partial<AgentMonitorEvent> = {}
): AgentMonitorEvent {
  return {
    id: `${source}:${kind}`,
    source,
    env: 'terminal',
    sessionKey: `${source}-sess`,
    kind,
    message: extra.message ?? `${source} ${kind}`,
    timestampMs: NOW,
    reason: extra.reason ?? (kind === 'done' ? 'completed' : undefined),
    ...extra
  }
}

describe('Codex 旧路径完成提醒隔离', () => {
  it('默认开启 Codex 中性提醒，但仍不把 done 改成 failed/unknown', () => {
    expect(CODEX_LEGACY_NEUTRAL_STOP_NOTIFICATION_ENABLED).toBe(true)
    const done = ev('codex', 'done')
    expect(done.kind).toBe('done')
    expect(isCodexLegacyProtocolComplete(done)).toBe(true)
    expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
    expect(done.kind).not.toBe('failed')
    expect(done.kind).not.toBe('needs_attention')
  })

  it('Codex task_started 仍是 working，且会打扰桌宠思考而不是成功提醒', () => {
    const working = ev('codex', 'working')
    expect(shouldPresentAgentTerminalToUser(working)).toBe(false)
    expect(petStateForPresentedKind('working')).toBe('thinking')
    expect(isCelebratingPetState(petStateForPresentedKind('working'))).toBe(false)
  })

  it('Codex done 弹中性气泡，但不响完成音、不庆祝', () => {
    const done = ev('codex', 'done', { reason: 'completed', message: 'Codex 这一轮结束了' })
    expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
    expect(shouldPlayAgentCompletionSound([done])).toBe(false)
    expect(petStateForTerminalEvent(done)).toBe('idle')
    expect(isCelebratingPetState(petStateForTerminalEvent(done))).toBe(false)
    expect(looksLikeTaskSuccessCopy(buildAgentBubbleHead(done))).toBe(false)
    expect(looksLikeTaskSuccessCopy(buildAgentBubbleText(done))).toBe(false)
    expect(buildAgentBubbleHead(done)).toContain('这一轮结束了')
    expect(buildAgentBubbleHead(done)).not.toContain('任务已完成')
    expect(buildAgentBubbleHead(done)).not.toContain('任务完成')
  })

  it('其他 Agent 的 done 行为完全不变', () => {
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      const done = ev(source, 'done', { reason: 'completed' })
      expect(isCodexLegacyProtocolComplete(done)).toBe(false)
      expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
      expect(shouldPlayAgentCompletionSound([done])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
      expect(looksLikeTaskSuccessCopy(buildAgentBubbleHead(done))).toBe(true)
    }
  })

  it('混合批次：只有非 Codex 的 done 才算完成音和「完成」条数', () => {
    const batch = [ev('codex', 'done'), ev('claude', 'done'), ev('cursor', 'failed')]
    const visible = presentableTerminalEvents(batch)
    expect(visible.map((e) => e.source)).toEqual(['codex', 'claude', 'cursor'])
    expect(countPresentableDone(batch)).toBe(2)
    expect(shouldPlayAgentCompletionSound(batch)).toBe(true)
    expect(shouldPlayAgentCompletionSound([ev('codex', 'done'), ev('claude', 'failed')])).toBe(false)
    expect(petStateForTerminalBatch(batch)).toBe('failed')
    expect(petStateForTerminalBatch([ev('codex', 'done'), ev('claude', 'done')])).toBe('happy')
    expect(petStateForTerminalBatch([ev('codex', 'done')])).toBe('idle')
  })

  it('Codex needs_attention / failed 不被误伤', () => {
    expect(shouldPresentAgentTerminalToUser(ev('codex', 'needs_attention'))).toBe(true)
    expect(shouldPresentAgentTerminalToUser(ev('codex', 'failed'))).toBe(true)
    expect(shouldPlayAgentCompletionSound([ev('codex', 'failed')])).toBe(false)
    expect(petStateForTerminalEvent(ev('codex', 'needs_attention'))).toBe('attention')
    expect(petStateForTerminalEvent(ev('codex', 'failed'))).toBe('failed')
  })

  it('candidate 仍不接入 UI：shouldNotify=false；旧 done 只走中性提醒，不会双通知', () => {
    const completed = mapCodexDerivedToCandidate({
      ...emptyCodexDerivedState(NOW),
      lifecycle: 'completed_signal',
      turn: 'completed',
      taskSemantics: 'not_verified',
      confidence: 'high'
    })
    expect(completed.candidate).toBe('completed_signal')
    expect(completed.shouldNotify).toBe(false)
    expect(completed.reasonCodes).toContain('not_succeeded')
    // 旧 done 现在会弹中性气泡，但 candidate 自己仍不通知；两者不是同一条通道
    expect(shouldPresentAgentTerminalToUser(ev('codex', 'done'))).toBe(true)

    const stale = mapCodexDerivedToCandidate({
      ...emptyCodexDerivedState(NOW),
      lifecycle: 'running',
      connection: 'stale',
      turn: 'in_progress'
    })
    expect(stale.candidate).toBe('unknown')
    expect(stale.shouldNotify).toBe(false)
    expect(stale.reasonCodes).toContain('observation_stale')
    expect(stale.candidate).not.toBe('completed_signal')
  })

  it('completed_signal / 部分失败 / 高 confidence 都不得显示任务已完成', () => {
    const partial = mapCodexDerivedToCandidate({
      ...emptyCodexDerivedState(NOW),
      lifecycle: 'completed_signal',
      cause: 'tool_failed',
      item: 'partial_failure',
      outputIntegrity: 'partial',
      taskSemantics: 'not_verified',
      confidence: 'high'
    })
    expect(partial.candidate).toBe('completed_with_partial_failure')
    expect(partial.shouldNotify).toBe(false)
    expect(partial.reasonCodes).toContain('not_succeeded')
    expect(looksLikeTaskSuccessCopy(buildAgentBubbleHead(ev('codex', 'done')))).toBe(false)
  })
})

describe('scanCodex 内部兼容事件 + 用户文案', () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-present-'))
    mkdirSync(codexSessionsRoot(), { recursive: true })
  })

  function write(name: string, lines: unknown[]): void {
    writeFileSync(
      join(codexSessionsRoot(), `${name}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    )
  }

  it('task_started 仍是 working；task_complete 派发内部 done，弹中性提醒', () => {
    const iso = new Date(NOW).toISOString()
    write('s1', [
      { timestamp: iso, type: 'session_meta', payload: { originator: 'codex_cli', source: 'cli' } },
      { timestamp: iso, type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: iso, type: 'event_msg', payload: { type: 'task_complete' } }
    ])
    const events = scanCodex(NOW)
    expect(events.map((e) => e.kind)).toEqual(['working', 'done'])
    const done = events.find((e) => e.kind === 'done')!
    expect(done.source).toBe('codex')
    expect(done.reason).toBe('completed')
    expect(done.message).toBe('Codex 这一轮结束了')
    expect(looksLikeTaskSuccessCopy(done.message)).toBe(false)
    expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
    expect(shouldPlayAgentCompletionSound([done])).toBe(false)
    expect(petStateForTerminalEvent(done)).toBe('idle')
  })

  it('item/tool 失败后的 task_complete 仍不显示成功', () => {
    const iso = new Date(NOW).toISOString()
    write('fail', [
      { timestamp: iso, type: 'session_meta', payload: { originator: 'codex_cli', source: 'cli' } },
      { timestamp: iso, type: 'event_msg', payload: { type: 'task_started' } },
      {
        timestamp: iso,
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } }
      },
      { timestamp: iso, type: 'event_msg', payload: { type: 'task_complete' } }
    ])
    const done = scanCodex(NOW).find((e) => e.kind === 'done')!
    expect(done.kind).toBe('done')
    expect(shouldPresentAgentTerminalToUser(done)).toBe(true)
    expect(looksLikeTaskSuccessCopy(buildAgentBubbleText(done))).toBe(false)
  })
})

describe('Monitor priming 与旧路径派发', () => {
  let clock = NOW
  let dispatched: AgentMonitorEvent[] = []

  beforeEach(() => {
    clock = NOW
    dispatched = []
    process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-codex-prime-present-'))
    mkdirSync(codexSessionsRoot(), { recursive: true })
  })

  it('启动 priming 不重放历史完成通知；之后 task_complete 派发中性提醒', () => {
    const iso = new Date(clock).toISOString()
    writeFileSync(
      join(codexSessionsRoot(), 'hist.jsonl'),
      [
        { timestamp: iso, type: 'session_meta', payload: { originator: 'codex_cli', source: 'cli' } },
        { timestamp: iso, type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: iso, type: 'event_msg', payload: { type: 'task_complete' } }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    )
    const monitor = new AgentMonitor(CONFIG, { now: () => clock, onEvent: (e) => dispatched.push(e) })
    monitor.start()
    monitor.stop()
    expect(dispatched).toEqual([])
    clock += 1000
    writeFileSync(
      join(codexSessionsRoot(), 'hist.jsonl'),
      [
        { timestamp: iso, type: 'session_meta', payload: { originator: 'codex_cli', source: 'cli' } },
        { timestamp: iso, type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: new Date(clock).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    )
    monitor.scanNow()
    const done = dispatched.find((e) => e.kind === 'done')
    expect(done).toBeTruthy()
    expect(shouldPresentAgentTerminalToUser(done!)).toBe(true)
  })
})
