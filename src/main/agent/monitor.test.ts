import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEventKind, AgentMonitorEvent } from '@shared/types'
import { AgentMonitor } from './monitor'
import type { MonitorConfig } from './monitor'

/**
 * monitor 的派发规则是整个监控链路里最容易被改坏的部分：首轮 prime 只登记不派发、
 * 事件 id 去重、终态必须先见过同会话的 working。这些规则一旦破了，表现是「不提醒」
 * 或「重复提醒」，而不是报错——只能靠测试兜住。
 */

// 扫描器都从 homedir() 读会话目录；指到空目录，tick() 就不会扫到任何真实会话
beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pet-monitor-test-'))
})

const OFF = { enabled: false, envs: [] }

const CONFIG: MonitorConfig = {
  codex: { enabled: true, envs: ['terminal'] },
  claude: OFF,
  cursor: OFF,
  grok: OFF
}

let clock = 1_700_000_000_000
let dispatched: AgentMonitorEvent[] = []
let monitor: AgentMonitor

function event(kind: AgentEventKind, sessionKey = 's1', message = 'msg'): AgentMonitorEvent {
  return {
    id: '',
    source: 'codex',
    env: 'terminal',
    sessionKey,
    kind,
    message,
    timestampMs: clock,
    rawPath: `/tmp/${sessionKey}.jsonl`
  }
}

/** 走一遍首轮扫描，解除 prime（空 HOME 下扫不到东西，只为把 primed 置成 true） */
function endPrime(): void {
  monitor.start()
  monitor.stop()
  dispatched = []
}

beforeEach(() => {
  clock = 1_700_000_000_000
  dispatched = []
  monitor = new AgentMonitor(CONFIG, {
    now: () => clock,
    onEvent: (e) => dispatched.push(e)
  })
})

describe('prime（首轮只登记不派发）', () => {
  it('首轮扫描期间的事件不派发，避免启动时把历史会话刷成一堆提醒', () => {
    monitor.ingest(event('working'), true)
    monitor.ingest(event('done'), true)
    expect(dispatched).toHaveLength(0)
  })

  it('解除 prime 后的新事件才真正派发', () => {
    endPrime()
    monitor.ingest(event('working'), true)
    expect(dispatched.map((e) => e.kind)).toEqual(['working'])
  })
})

describe('去重', () => {
  it('同一条事件重复扫到只派发一次', () => {
    endPrime()
    const e = event('working')
    monitor.ingest({ ...e }, true)
    monitor.ingest({ ...e }, true)
    monitor.ingest({ ...e }, true)
    expect(dispatched).toHaveLength(1)
  })

  it('时间戳变化视为新事件（会话仍在推进）', () => {
    endPrime()
    monitor.ingest(event('working'), true)
    clock += 1000
    monitor.ingest(event('working'), true)
    expect(dispatched).toHaveLength(2)
  })
})

describe('终态需先见过同会话的 working', () => {
  it('没见过 working 的终态被丢弃（防止历史会话补发提醒）', () => {
    endPrime()
    monitor.ingest(event('done'), true)
    expect(dispatched).toHaveLength(0)
  })

  it('见过 working 之后，终态正常派发', () => {
    endPrime()
    monitor.ingest(event('working'), true)
    clock += 1000
    monitor.ingest(event('done'), true)
    expect(dispatched.map((e) => e.kind)).toEqual(['working', 'done'])
  })

  it('另一个会话的 working 不能替本会话的终态开门', () => {
    endPrime()
    monitor.ingest(event('working', 'other-session'), true)
    clock += 1000
    monitor.ingest(event('done', 's1'), true)
    expect(dispatched.map((e) => e.sessionKey)).toEqual(['other-session'])
  })
})

describe('dev 模拟（fromScan=false）', () => {
  it('不受 prime 限制', () => {
    monitor.ingest(event('done'), false)
    expect(dispatched).toHaveLength(1)
  })

  it('不要求先见过 working，方便单独验证终态气泡', () => {
    endPrime()
    monitor.ingest(event('failed'), false)
    expect(dispatched.map((e) => e.kind)).toEqual(['failed'])
  })
})

describe('运行状态', () => {
  it('四家全不监控时 enabled 为 false（纯陪伴模式，不起轮询）', () => {
    const idle = new AgentMonitor(
      { codex: OFF, claude: OFF, cursor: OFF, grok: OFF },
      { now: () => clock, onEvent: () => {} }
    )
    expect(idle.getStatus().enabled).toBe(false)
  })

  it('开关开着但环境集合为空，等于不监控', () => {
    const noEnv = new AgentMonitor(
      { ...CONFIG, codex: { enabled: true, envs: [] } },
      { now: () => clock, onEvent: () => {} }
    )
    expect(noEnv.getStatus().enabled).toBe(false)
  })

  it('活跃会话会随事件登记', () => {
    endPrime()
    monitor.ingest(event('working', 'sess-a'), true)
    monitor.ingest(event('working', 'sess-b'), true)
    expect(monitor.getStatus().activeSessions.map((s) => s.sessionKey).sort()).toEqual([
      'sess-a',
      'sess-b'
    ])
  })
})
