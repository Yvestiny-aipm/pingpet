import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptIdentityRef,
  AGENT_LIFECYCLES,
  capabilityKey,
  digestAllowedFields,
  isForbiddenLifecycle,
  lifecycleMeansTaskSuccess,
  type AgentDerivedState,
  type AgentForbiddenLifecycle,
  type AgentLifecycle,
  type AgentObservation,
  type Dimension
} from './agentObservation'

const NOW = 1_700_000_000_000

type ExpectFalse<T extends false> = T
type SucceededIsLifecycle = 'succeeded' extends AgentLifecycle ? true : false
type CompletedIsSucceeded = 'completed_signal' extends AgentForbiddenLifecycle ? true : false
type _succeeded_is_not_generic_lifecycle = ExpectFalse<SucceededIsLifecycle>
type _completed_signal_is_not_succeeded = ExpectFalse<CompletedIsSucceeded>

const _typeLevel: [_succeeded_is_not_generic_lifecycle, _completed_signal_is_not_succeeded] = [
  false,
  false
]
void _typeLevel

// @ts-expect-error succeeded 不是通用 lifecycle，不能和 completed_signal 混用
const _succeededIsNotLifecycle: AgentLifecycle = 'succeeded'
void _succeededIsNotLifecycle

function observation(partial: Partial<AgentObservation> = {}): AgentObservation {
  return {
    agentId: 'cursor',
    adapterId: 'test-boundary',
    channel: 'session_file',
    eventName: 'turn_ended',
    recognition: 'recognized',
    payloadDigest: { fieldNames: ['type'], redacted: true },
    observedAt: NOW,
    evidenceOrigin: 'test',
    confidence: 'medium',
    dedupKey: 'cursor:test:1',
    ...partial
  }
}

describe('observed / unknown / unsupported', () => {
  it('三种存在性可区分，且不能靠值相等冒充', () => {
    const seen: Dimension<'running'> = { presence: 'observed', value: 'running' }
    const unknown: Dimension<'running'> = { presence: 'unknown' }
    const unsupported: Dimension<'running'> = { presence: 'unsupported' }

    expect(seen.presence).toBe('observed')
    expect(unknown.presence).toBe('unknown')
    expect(unsupported.presence).toBe('unsupported')
    expect(seen).not.toEqual(unknown)
    expect(unknown).not.toEqual(unsupported)
    expect('value' in unknown).toBe(false)
    expect('value' in unsupported).toBe(false)
  })
})

describe('标识不得伪造', () => {
  it('只有 payload 提供的非空字符串才能留下', () => {
    expect(acceptIdentityRef('sess-1', 'payload')).toBe('sess-1')
    expect(acceptIdentityRef('  turn-9  ', 'payload')).toBe('turn-9')
  })

  it('文件名、时间戳、sessionKey、自造字符串一律拒绝', () => {
    expect(acceptIdentityRef('abc.jsonl', 'filename')).toBeUndefined()
    expect(acceptIdentityRef(String(NOW), 'timestamp')).toBeUndefined()
    expect(acceptIdentityRef('cursor:abc.jsonl', 'sessionKey')).toBeUndefined()
    expect(acceptIdentityRef('invented-turn', 'invented')).toBeUndefined()
    expect(acceptIdentityRef('', 'payload')).toBeUndefined()
    expect(acceptIdentityRef(12, 'payload')).toBeUndefined()
  })

  it('缺少 session/turn/item 时观察事件可以不带这些字段', () => {
    const event = observation()
    expect(event.sessionRef).toBeUndefined()
    expect(event.threadRef).toBeUndefined()
    expect(event.turnRef).toBeUndefined()
    expect(event.itemRef).toBeUndefined()
    expect(event.eventTime).toBeUndefined()
  })
})

describe('原始观察可以只带部分字段', () => {
  it('不要求 turn、item、进程或结构化正文', () => {
    const event = observation({
      agentId: 'grok',
      channel: 'roster',
      eventName: 'mtime_changed',
      confidence: 'low',
      evidenceKind: 'file_activity'
    })
    expect(event.payloadDigest.redacted).toBe(true)
    expect(event.payloadDigest).not.toHaveProperty('prompt')
    expect(event.payloadDigest).not.toHaveProperty('content')
  })

  it('摘要只记允许键的存在性，不复制敏感值', () => {
    const digest = digestAllowedFields(
      { type: 'assistant', prompt: '不要出现在摘要里', cwd: '/Users/secret' },
      ['type']
    )
    expect(digest).toEqual({ fieldNames: ['type'], redacted: true })
    expect(JSON.stringify(digest)).not.toContain('不要出现')
    expect(JSON.stringify(digest)).not.toContain('/Users/secret')
  })
})

describe('completed_signal 与 succeeded', () => {
  it('通用 lifecycle 列表不含 succeeded，完成信号也不表示任务成功', () => {
    expect(AGENT_LIFECYCLES).toContain('completed_signal')
    expect((AGENT_LIFECYCLES as readonly string[]).includes('succeeded')).toBe(false)
    expect(lifecycleMeansTaskSuccess('completed_signal')).toBe(false)
    expect(lifecycleMeansTaskSuccess('failed')).toBe(false)
    expect(isForbiddenLifecycle('succeeded')).toBe(true)
    expect(isForbiddenLifecycle('completed_signal')).toBe(false)
  })
})

describe('派生状态缺省', () => {
  it('可以只观察部分维度，其余保持 unknown 而不是伪造终态', () => {
    const state: AgentDerivedState = {
      agentId: 'claude',
      adapterId: 'test-boundary',
      lifecycle: { presence: 'observed', value: 'completed_signal' },
      cause: { presence: 'unknown' },
      connection: { presence: 'unknown' },
      process: { presence: 'unsupported' },
      session: { presence: 'observed', value: 'active' },
      turn: { presence: 'unsupported' },
      item: { presence: 'unsupported' },
      outputIntegrity: { presence: 'unknown' },
      taskSemantics: { presence: 'observed', value: 'not_verified' },
      retryability: { presence: 'unknown' },
      confidence: 'medium',
      evidence: [],
      conflicts: [],
      observedAt: NOW
    }
    expect(state.lifecycle).toEqual({ presence: 'observed', value: 'completed_signal' })
    expect(state.turn.presence).toBe('unsupported')
    expect(state.item.presence).toBe('unsupported')
    expect(state.taskSemantics).toEqual({ presence: 'observed', value: 'not_verified' })
    expect(state).not.toHaveProperty('legacyEquivalent')
    expect(state).not.toHaveProperty('kind')
  })
})

describe('能力键按 agent + adapter/channel + dimension 隔离', () => {
  it('同一维度在不同 Adapter 上得到不同键', () => {
    const shadow = capabilityKey('codex', 'codex-session-shadow', 'session_file', 'process')
    const processHint = capabilityKey('codex', 'codex-process-hint', 'process', 'process')
    const otherAgent = capabilityKey('cursor', 'codex-session-shadow', 'session_file', 'process')
    expect(shadow).not.toBe(processHint)
    expect(shadow).not.toBe(otherAgent)
  })
})

describe('通用类型不依赖 Codex 事件名', () => {
  it('本文件不出现 Codex 专用 type 字符串', () => {
    const text = readFileSync(join(__dirname, 'agentObservation.ts'), 'utf8')
    expect(text).not.toContain('event_msg.task_complete')
    expect(text).not.toContain('CODEX_STRUCTURED_EVENT_TYPES')
    expect(text).not.toContain("'exec_json'")
    expect(text).not.toContain('session_jsonl')
  })
})
