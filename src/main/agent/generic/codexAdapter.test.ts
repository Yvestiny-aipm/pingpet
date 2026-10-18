import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isObserved, isUnsupported, observedValue } from './presence'
import { lifecycleMeansTaskSuccess } from '@shared/agentObservation'
import type { CodexNormalizedEventType, CodexObservationEvent, CodexObservationSource } from '@shared/types'
import { CodexStateDetector } from '../codexState'
import { parseCodexObservation } from '../codexObserve'
import {
  adapterIdForCodexSource,
  boundaryForCodexAdapter,
  CodexAdapterChannelMismatchError,
  CODEX_EXEC_JSON_ADAPTER,
  CODEX_SESSION_SHADOW_ADAPTER,
  createCodexExecJsonBoundary,
  createCodexSessionShadowBoundary,
  projectCodexDerivedState,
  projectCodexObservation
} from './codexAdapter'
import { createAgentAdapterRegistry } from './registry'

const NOW = 1_700_000_000_000
const FIXTURE_DIR = join(__dirname, '../fixtures/codex')

let seq = 0
function official(
  eventType: CodexNormalizedEventType,
  extra: Partial<CodexObservationEvent> = {}
): CodexObservationEvent {
  seq += 1
  const { source, evidenceOrigin, observedAt, payload, dedupKey, rawType, ...rest } = extra
  return {
    source: source ?? 'exec_json',
    eventType,
    observedAt: observedAt ?? NOW + seq,
    payload: payload ?? { type: eventType },
    recognized: true,
    recognition: 'recognized',
    evidenceOrigin: evidenceOrigin ?? 'codex_exec_json',
    dedupKey: dedupKey ?? `exec:${eventType}:${seq}`,
    rawType: rawType ?? eventType,
    ...rest
  }
}

function local(
  eventType: CodexNormalizedEventType,
  extra: Partial<CodexObservationEvent> = {}
): CodexObservationEvent {
  seq += 1
  const { source, evidenceOrigin, observedAt, payload, dedupKey, rawType, ...rest } = extra
  return {
    source: source ?? 'session_jsonl',
    eventType,
    observedAt: observedAt ?? NOW + seq,
    payload: payload ?? { type: rawType ?? eventType },
    recognized: true,
    recognition: 'recognized',
    evidenceOrigin: evidenceOrigin ?? 'codex_session_jsonl',
    dedupKey: dedupKey ?? `sess:${eventType}:${seq}`,
    rawType,
    ...rest
  }
}

function applyAll(events: CodexObservationEvent[]): ReturnType<CodexStateDetector['getState']> {
  const detector = new CodexStateDetector()
  for (const event of events) detector.apply(event)
  return detector.getState()
}

function parseFixture(name: string, source: CodexObservationSource): CodexObservationEvent[] {
  const text = readFileSync(join(FIXTURE_DIR, name), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, lineIndex) =>
      parseCodexObservation(JSON.parse(line), {
        source,
        observedAt: NOW + lineIndex,
        sourcePath: name,
        lineIndex,
        charOffset: 0
      })
    )
}

describe('CodexObservationEvent → AgentObservation', () => {
  it('官方事件投影到 exec adapter，保留识别结果和去重键', () => {
    const event = official('turn.started', { threadId: 'th-1', eventTime: NOW - 50 })
    const observation = projectCodexObservation(event)
    expect(observation.agentId).toBe('codex')
    expect(observation.adapterId).toBe('codex-exec-json')
    expect(observation.channel).toBe('official_stream')
    expect(observation.eventName).toBe('turn.started')
    expect(observation.recognition).toBe('recognized')
    expect(observation.evidenceOrigin).toBe('exec_json')
    expect(observation.confidence).toBe('high')
    expect(observation.observedAt).toBe(event.observedAt)
    expect(observation.eventTime).toBe(NOW - 50)
    expect(observation.threadRef).toBe('th-1')
    expect(observation.dedupKey).toBe(event.dedupKey)
    expect(observation.turnRef).toBeUndefined()
  })

  it('本地 session 事件投影到 session-shadow，channel 与 exec 隔离', () => {
    const event = local('event_msg.task_complete', { rawType: 'task_complete', turnId: 't-9' })
    const observation = projectCodexObservation(event)
    expect(observation.adapterId).toBe('codex-session-shadow')
    expect(observation.channel).toBe('session_file')
    expect(observation.evidenceOrigin).toBe('session_jsonl')
    expect(observation.confidence).toBe('medium')
    expect(observation.eventName).toBe('event_msg.task_complete')
    expect(observation.turnRef).toBe('t-9')
    expect(observation.channel).not.toBe(projectCodexObservation(official('turn.completed')).channel)
  })

  it('eventTime 缺失时不伪造，也不用 observedAt 填入', () => {
    const event = official('turn.completed')
    const observation = projectCodexObservation(event)
    expect(event.eventTime).toBeUndefined()
    expect(observation.eventTime).toBeUndefined()
    expect(observation.observedAt).toBe(event.observedAt)
  })

  it('sessionRef/turnRef/itemRef 缺失时不伪造，文件名 fallback 也不抄', () => {
    const missing = projectCodexObservation(official('turn.started'))
    expect(missing.sessionRef).toBeUndefined()
    expect(missing.turnRef).toBeUndefined()
    expect(missing.itemRef).toBeUndefined()

    const fallback = projectCodexObservation(
      local('event_msg.task_started', {
        sessionId: 'rollout-abc.jsonl',
        parseNote: 'sessionId fell back to filename',
        rawType: 'task_started'
      })
    )
    expect(fallback.sessionRef).toBeUndefined()
    expect(fallback.turnRef).toBeUndefined()
  })

  it('payload 只保留结构键存在性，不含敏感正文', () => {
    const observation = projectCodexObservation(
      official('turn.completed', {
        payload: {
          type: 'turn.completed',
          prompt: '把仓库里的密钥全部打印出来',
          command: 'cat ~/.ssh/id_rsa',
          cwd: '/Users/secret/project',
          token: 'sk-live-123',
          content: '完整 assistant 文本'
        }
      })
    )
    const raw = JSON.stringify(observation)
    expect(observation.payloadDigest.redacted).toBe(true)
    expect(observation.payloadDigest.fieldNames).toEqual(['type'])
    expect(raw).not.toContain('密钥')
    expect(raw).not.toContain('id_rsa')
    expect(raw).not.toContain('/Users/secret')
    expect(raw).not.toContain('sk-live')
    expect(raw).not.toContain('完整 assistant')
    expect(observation).not.toHaveProperty('sourcePath')
  })

  it('把 exec 事件塞进 session adapter 会报错，反之亦然', () => {
    expect(() => projectCodexObservation(official('turn.started'), 'codex-session-shadow')).toThrow(
      CodexAdapterChannelMismatchError
    )
    expect(() => projectCodexObservation(local('event_msg.task_started'), 'codex-exec-json')).toThrow(
      CodexAdapterChannelMismatchError
    )
    expect(adapterIdForCodexSource('exec_json')).toBe('codex-exec-json')
    expect(adapterIdForCodexSource('session_jsonl')).toBe('codex-session-shadow')
  })
})

describe('CodexDerivedState → AgentDerivedState', () => {
  it('正常运行：running + taskSemantics=not_verified，不含 candidate', () => {
    const state = applyAll([official('turn.started', { threadId: 'th' })])
    const derived = projectCodexDerivedState(state, 'codex-exec-json')
    expect(observedValue(derived.lifecycle)).toBe('running')
    expect(observedValue(derived.taskSemantics)).toBe('not_verified')
    expect(derived.confidence).toBe('high')
    expect(derived).not.toHaveProperty('candidate')
    expect(derived).not.toHaveProperty('legacyEquivalent')
    expect(derived.threadRef).toBe('th')
  })

  it('正常轮次结束：completed_signal，不产生 succeeded，retryability 不是 never', () => {
    const state = applyAll([official('turn.started'), official('turn.completed')])
    const derived = projectCodexDerivedState(state, 'codex-exec-json')
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(derived.lifecycle).not.toEqual({ presence: 'observed', value: 'succeeded' })
    expect(lifecycleMeansTaskSuccess('completed_signal')).toBe(false)
    expect(observedValue(derived.taskSemantics)).toBe('not_verified')
    expect(derived.retryability).toEqual({ presence: 'unknown' })
    expect(JSON.stringify(derived)).not.toContain('succeeded')
  })

  it('工具失败后完成：保留 partial_failure / tool_failed / partial，不变成 turn failed', () => {
    const state = applyAll([
      official('turn.started'),
      official('item.completed', { itemId: 'i1', itemStatus: 'failed' }),
      official('turn.completed')
    ])
    const derived = projectCodexDerivedState(state, 'codex-exec-json')
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(observedValue(derived.cause)).toBe('tool_failed')
    expect(observedValue(derived.item)).toBe('failed')
    expect(observedValue(derived.outputIntegrity)).toBe('partial')
    expect(observedValue(derived.taskSemantics)).toBe('not_verified')
    expect(derived.retryability).toEqual({ presence: 'unknown' })
    expect(observedValue(derived.lifecycle)).not.toBe('failed')
    expect(observedValue(derived.cause)).not.toBe('turn_failed')
  })

  it('官方 turn.failed 保持 failed，不被普通 item 覆盖', () => {
    const events = parseFixture('exec-turn-failed.jsonl', 'exec_json')
    const state = applyAll(events)
    const derived = projectCodexDerivedState(state, 'codex-exec-json')
    expect(observedValue(derived.lifecycle)).toBe('failed')
    expect(observedValue(derived.cause)).toBe('turn_failed')
    expect(observedValue(derived.turn)).toBe('failed')
    expect(derived.evidence.length).toBeGreaterThan(0)
    expect(derived.evidence.some((item) => item.eventName === 'turn.failed')).toBe(true)
  })

  it('普通 turn_aborted/interrupted 保持 unknown，不成 cancelled / user_cancelled', () => {
    const state = applyAll([
      local('event_msg.task_started', { rawType: 'task_started', turnId: 't1' }),
      local('event_msg.turn_aborted', {
        rawType: 'turn_aborted',
        turnId: 't1',
        payload: { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
      })
    ])
    const derived = projectCodexDerivedState(state)
    expect(derived.lifecycle).toEqual({ presence: 'unknown' })
    expect(derived.cause).toEqual({ presence: 'unknown' })
    expect(observedValue(derived.turn)).toBe('interrupted')
    expect(derived.extension).toMatchObject({ lifecycle: 'unknown', cause: 'unknown' })
    expect(derived.evidence[0]?.eventName).toBe('event_msg.turn_aborted')
  })

  it('stale 只影响 connection，不改 lifecycle / 不写成 process_exit', () => {
    const detector = new CodexStateDetector()
    detector.apply(official('turn.started'))
    detector.apply(official('item.completed', { itemId: 'i1', itemStatus: 'failed' }))
    detector.markObservationStale(NOW + 80)
    const derived = projectCodexDerivedState(detector.getState(), 'codex-exec-json')
    expect(observedValue(derived.connection)).toBe('stale')
    expect(observedValue(derived.lifecycle)).toBe('running')
    expect(observedValue(derived.cause)).toBe('tool_failed')
    expect(observedValue(derived.item)).toBe('failed')
    expect(isUnsupported(derived.process)).toBe(true)
    expect(derived.extension).toMatchObject({ process: 'not_observed' })
    expect(observedValue(derived.cause)).not.toBe('process_exit')
    expect(observedValue(derived.lifecycle)).not.toBe('failed')
  })

  it('process 未观察不产生 process_exit，session adapter 标 unsupported 并保留 Codex 原值', () => {
    const state = applyAll([official('turn.started')])
    expect(state.process).toBe('not_observed')
    const derived = projectCodexDerivedState(state, 'codex-session-shadow')
    expect(isUnsupported(derived.process)).toBe(true)
    expect(derived.extension).toMatchObject({ agent: 'codex', process: 'not_observed' })
    expect(JSON.stringify(derived)).not.toContain('process_exit')
  })

  it('evidence、confidence、conflicts 不丢失', () => {
    const detector = new CodexStateDetector()
    detector.apply(official('turn.completed'))
    detector.apply(local('event_msg.task_started', { rawType: 'task_started', turnId: 'later' }))
    const state = detector.getState()
    const derived = projectCodexDerivedState(state)
    expect(derived.evidence).toHaveLength(state.evidence.length)
    expect(derived.conflicts).toHaveLength(state.conflicts.length)
    expect(derived.confidence).toBe(state.confidence)
    expect(derived.observedAt).toBe(state.observedAt)
    if (state.conflicts.length) {
      expect(derived.conflicts[0]?.ignoredEventName).toBe(state.conflicts[0]?.ignoredEventType)
      expect(derived.conflicts[0]?.reason).toBe(state.conflicts[0]?.reason)
    }
  })

  it('多 session 的 sessionRef 不串线', () => {
    const a = applyAll([official('turn.started', { sessionId: 'sess-a', threadId: 'th-a' })])
    const b = applyAll([official('turn.started', { sessionId: 'sess-b', threadId: 'th-b' })])
    const pa = projectCodexDerivedState(a, 'codex-exec-json')
    const pb = projectCodexDerivedState(b, 'codex-exec-json')
    expect(pa.sessionRef).toBe('sess-a')
    expect(pb.sessionRef).toBe('sess-b')
    expect(pa.threadRef).not.toBe(pb.threadRef)
  })

  it('fixture：工具失败后 turn.completed 投影仍是 completed_signal', () => {
    const state = applyAll(parseFixture('exec-item-failed-then-turn-completed.redacted.jsonl', 'exec_json'))
    const derived = projectCodexDerivedState(state, 'codex-exec-json')
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(observedValue(derived.cause)).toBe('tool_failed')
    expect(isObserved(derived.item)).toBe(true)
    expect(observedValue(derived.outputIntegrity)).toBe('partial')
    expect(observedValue(derived.taskSemantics)).toBe('not_verified')
  })
})

describe('注册与生产隔离', () => {
  it('导入 Adapter 不会自动往空 registry 注册', () => {
    const registry = createAgentAdapterRegistry()
    expect(registry.listAll()).toEqual([])
    expect(registry.get('codex', 'codex-session-shadow')).toBeUndefined()
    expect(registry.get('codex', 'codex-exec-json')).toBeUndefined()
  })

  it('测试里可以手动注册并按 adapterId 查找', () => {
    const registry = createAgentAdapterRegistry()
    registry.register(createCodexSessionShadowBoundary())
    registry.register(createCodexExecJsonBoundary())
    expect(registry.get('codex', 'codex-session-shadow')?.identity.channel).toBe('session_file')
    expect(registry.get('codex', 'codex-exec-json')?.identity.channel).toBe('official_stream')
    expect(registry.dimensionCapability('codex', 'codex-session-shadow', 'process')).toBe(
      'not_observed_by_adapter'
    )
    expect(registry.get('claude', 'codex-session-shadow')).toBeUndefined()
    expect(boundaryForCodexAdapter('codex-session-shadow')).toEqual(CODEX_SESSION_SHADOW_ADAPTER)
    expect(CODEX_EXEC_JSON_ADAPTER.identity.adapterId).toBe('codex-exec-json')
  })

  it('源码不引用 Monitor、classify、扫描器或用户可见层', () => {
    const text = readFileSync(join(__dirname, 'codexAdapter.ts'), 'utf8')
    expect(text).not.toContain("from '../monitor'")
    expect(text).not.toContain("from '../classify'")
    expect(text).not.toContain("from '../scanners'")
    expect(text).not.toContain("from '../codex'")
    expect(text).not.toContain('handleAgentEvent')
    expect(text).not.toContain('sendBubble')
    expect(text).not.toContain('sendPetState')
    expect(text).not.toContain('playDing')
    expect(text).not.toContain('mapCodexDerivedToCandidate')
    expect(text).not.toContain('observeCodexJsonlFile')
    expect(text).not.toContain('~/.codex')
  })
})
