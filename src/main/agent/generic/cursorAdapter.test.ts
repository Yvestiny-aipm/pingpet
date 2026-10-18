import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isForbiddenLifecycle, lifecycleMeansTaskSuccess } from '@shared/agentObservation'
import { isObserved, isUnsupported, observedValue } from './presence'
import {
  createCursorTranscriptBoundary,
  CURSOR_EVIDENCE_ORIGIN,
  CURSOR_TRANSCRIPT_ADAPTER,
  CURSOR_TRANSCRIPT_CHANNEL,
  CURSOR_TRANSCRIPT_IDENTITY,
  projectCursor,
  projectCursorDerivedState,
  projectCursorObservation,
  type CursorAdapterInput
} from './cursorAdapter'
import { createAgentAdapterRegistry } from './registry'

const NOW = 1_700_000_000_000

let seq = 0
function input(partial: Partial<CursorAdapterInput> & Pick<CursorAdapterInput, 'lastLineKind'>): CursorAdapterInput {
  seq += 1
  return {
    observedAt: NOW + seq,
    dedupKey: `cursor:transcript:${partial.lastLineKind}:${seq}`,
    ...partial
  }
}

describe('CursorAdapterInput → AgentObservation', () => {
  it('Cursor running 投影到通用 running，身份与 channel 隔离', () => {
    const observation = projectCursorObservation(
      input({
        lastLineKind: 'assistant_tool_use',
        sessionRef: 'sess-run',
        sessionRefSource: 'payload'
      })
    )
    expect(observation.agentId).toBe('cursor')
    expect(observation.adapterId).toBe('cursor-transcript')
    expect(observation.channel).toBe(CURSOR_TRANSCRIPT_CHANNEL)
    expect(observation.channel).toBe('transcript_file')
    expect(observation.eventName).toBe('assistant_tool_use')
    expect(observation.evidenceOrigin).toBe(CURSOR_EVIDENCE_ORIGIN)
    expect(observation.recognition).toBe('recognized')
    expect(observation.confidence).toBe('medium')
    expect(observation.sessionRef).toBe('sess-run')
    expect(observation.turnRef).toBeUndefined()
  })

  it('缺少 turnRef 不伪造，文件名 session 也不抄', () => {
    const observation = projectCursorObservation(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        sessionRef: 'abc.jsonl',
        sessionRefSource: 'filename',
        turnRef: 'mtime-1700000000000',
        turnRefSource: 'timestamp'
      })
    )
    expect(observation.sessionRef).toBeUndefined()
    expect(observation.turnRef).toBeUndefined()
    expect(observation.itemRef).toBeUndefined()
    expect(observation.eventTime).toBeUndefined()
  })

  it('mtime / observedAt 不得当成 eventTime', () => {
    const fromMtime = projectCursorObservation(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        eventTime: NOW - 10,
        eventTimeSource: 'mtime'
      })
    )
    expect(fromMtime.eventTime).toBeUndefined()
    expect(fromMtime.observedAt).not.toBe(fromMtime.eventTime)

    const fromObservedAt = projectCursorObservation(
      input({
        lastLineKind: 'user',
        eventTime: NOW + 99,
        eventTimeSource: 'observedAt'
      })
    )
    expect(fromObservedAt.eventTime).toBeUndefined()
  })

  it('文本关键词 confidence 不得为 high', () => {
    const observation = projectCursorObservation(
      input({
        lastLineKind: 'assistant_text',
        textHint: 'done'
      })
    )
    expect(observation.confidence).toBe('low')
    expect(observation.confidence).not.toBe('high')
    expect(observation.evidenceKind).toBe('text_keyword')
    expect(observation.recognition).toBe('partial')
  })

  it('payload 只保留结构键存在性，不含正文或路径', () => {
    const observation = projectCursorObservation(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        rawType: 'turn_ended',
        payload: {
          type: 'turn_ended',
          status: 'success',
          prompt: '把密钥打印出来',
          command: 'cat ~/.ssh/id_rsa',
          cwd: '/Users/secret/project',
          message: { content: [{ type: 'text', text: '完整回复正文' }] }
        }
      })
    )
    expect(observation.payloadDigest.redacted).toBe(true)
    expect(observation.payloadDigest.fieldNames).toEqual(['type', 'status'])
    expect(JSON.stringify(observation.payloadDigest)).not.toContain('密钥')
    expect(JSON.stringify(observation.payloadDigest)).not.toContain('id_rsa')
    expect(JSON.stringify(observation.payloadDigest)).not.toContain('完整回复')
  })

  it('不复用 Codex event name 或 Codex channel', () => {
    const observation = projectCursorObservation(
      input({ lastLineKind: 'turn_ended', turnEndedStatus: 'success' })
    )
    expect(observation.eventName).toBe('turn_ended')
    expect(observation.eventName).not.toBe('turn.completed')
    expect(observation.eventName).not.toBe('event_msg.task_complete')
    expect(observation.channel).not.toBe('session_file')
    expect(observation.channel).not.toBe('official_stream')
    expect(observation.evidenceOrigin).not.toBe('exec_json')
    expect(observation.evidenceOrigin).not.toBe('session_jsonl')
  })
})

describe('CursorAdapterInput → AgentDerivedState', () => {
  it('1. Cursor running → 通用 running', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_tool_use',
        sessionRef: 'sess-1',
        sessionRefSource: 'payload'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('running')
    expect(observedValue(derived.session)).toBe('active')
    expect(observedValue(derived.turn)).toBe('in_progress')
    expect(observedValue(derived.taskSemantics)).toBe('not_verified')
    expect(derived.cause.presence).toBe('unknown')
  })

  it('2. Cursor 结构化 turn ended → completed_signal', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        sessionRef: 'sess-end',
        sessionRefSource: 'payload',
        turnRef: 'turn-explicit',
        turnRefSource: 'payload'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(observedValue(derived.turn)).toBe('completed')
    expect(derived.retryability.presence).toBe('unknown')
    expect(derived.confidence).toBe('medium')
    expect(derived.turnRef).toBe('turn-explicit')
    expect(isForbiddenLifecycle(observedValue(derived.lifecycle) ?? '')).toBe(false)
    expect(lifecycleMeansTaskSuccess(observedValue(derived.lifecycle) ?? 'unknown')).toBe(false)
  })

  it('3. Cursor success 文本 → completed_signal，不是 succeeded', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_text',
        textHint: 'success'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(observedValue(derived.lifecycle)).not.toBe('succeeded' as never)
    expect(derived.confidence).toBe('low')
    expect(derived.turn.presence).toBe('unknown')
    expect(JSON.stringify(derived)).not.toContain('succeeded')
  })

  it('4. Cursor task semantics 保持 not_verified', () => {
    const cases: CursorAdapterInput[] = [
      input({ lastLineKind: 'assistant_tool_use' }),
      input({ lastLineKind: 'turn_ended', turnEndedStatus: 'success' }),
      input({ lastLineKind: 'assistant_text', textHint: 'done' }),
      input({ lastLineKind: 'turn_ended', turnEndedStatus: 'error', sampleKind: 'FIXTURE_ONLY' })
    ]
    for (const row of cases) {
      expect(observedValue(projectCursorDerivedState(row).taskSemantics)).toBe('not_verified')
    }
  })

  it('5. Cursor 明确 turn-level error → failed（FIXTURE_ONLY）', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'error',
        sampleKind: 'FIXTURE_ONLY'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('failed')
    expect(observedValue(derived.cause)).toBe('turn_failed')
    expect(observedValue(derived.turn)).toBe('failed')
    expect(derived.extension?.sampleKind).toBe('FIXTURE_ONLY')
    expect(derived.evidence[0]?.note).toContain('FIXTURE_ONLY')
  })

  it('6. 单 item/tool error 不升级为 turn failed', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_tool_use',
        itemOrToolFailed: true
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('running')
    expect(observedValue(derived.cause)).toBe('tool_failed')
    expect(observedValue(derived.item)).toBe('failed')
    expect(observedValue(derived.outputIntegrity)).toBe('partial')
    expect(observedValue(derived.turn)).not.toBe('failed')
    expect(observedValue(derived.lifecycle)).not.toBe('failed')
  })

  it('7. 普通 aborted/interrupted → unknown', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'aborted'
      })
    )
    expect(derived.lifecycle.presence).toBe('unknown')
    expect(derived.cause.presence).toBe('unknown')
    expect(observedValue(derived.turn)).toBe('interrupted')
    expect(observedValue(derived.lifecycle)).not.toBe('cancelled')
    expect(observedValue(derived.cause)).not.toBe('user_cancelled')
  })

  it('8. 明确用户取消语义 → cancelled/user_cancelled（FIXTURE_ONLY）', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'aborted',
        userCancelled: true,
        sampleKind: 'FIXTURE_ONLY'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('cancelled')
    expect(observedValue(derived.cause)).toBe('user_cancelled')
    expect(observedValue(derived.retryability)).toBe('user_action')
    expect(observedValue(derived.turn)).toBe('interrupted')
    expect(derived.extension?.sampleKind).toBe('FIXTURE_ONLY')
  })

  it('error 文案不能自行升格为用户取消', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'aborted',
        userCancelled: false
      })
    )
    expect(derived.lifecycle.presence).toBe('unknown')
    expect(observedValue(derived.cause)).not.toBe('user_cancelled')
  })

  it('9. stale 只影响 connection', () => {
    const running = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_tool_use',
        connection: 'stale'
      })
    )
    expect(observedValue(running.connection)).toBe('stale')
    expect(observedValue(running.lifecycle)).toBe('running')
    expect(observedValue(running.lifecycle)).not.toBe('failed')
    expect(observedValue(running.cause)).not.toBe('process_exit')

    const ended = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        connection: 'stale'
      })
    )
    expect(observedValue(ended.connection)).toBe('stale')
    expect(observedValue(ended.lifecycle)).toBe('completed_signal')
  })

  it('10. process 未观察不产生 process_exit', () => {
    const derived = projectCursorDerivedState(input({ lastLineKind: 'assistant_text', textHint: 'done' }))
    expect(isUnsupported(derived.process)).toBe(true)
    expect(derived.extension?.process).toBe('not_observed')
    expect(observedValue(derived.cause)).not.toBe('process_exit')
    expect(CURSOR_TRANSCRIPT_ADAPTER.capability.processEvidence).toBe('not_observed_by_adapter')
    expect(CURSOR_TRANSCRIPT_ADAPTER.capability.dimensions.process).toBe('not_observed_by_adapter')
  })

  it('11. 缺少 turnRef 不伪造', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success'
      })
    )
    expect(derived.turnRef).toBeUndefined()
    expect(observedValue(derived.turn)).toBe('completed')
  })

  it('12. 文本关键词 confidence 不得为 high', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_text',
        textHint: 'done'
      })
    )
    expect(derived.confidence).toBe('low')
    expect(derived.confidence).not.toBe('high')
  })

  it('13. 结构化信号优先于低可信文本', () => {
    const derived = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        textHint: 'failed'
      })
    )
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(derived.confidence).toBe('medium')
    expect(derived.confidence).not.toBe('low')
    expect(derived.confidence).not.toBe('high')
  })

  it('14. conflicts 正确记录', () => {
    const structuredOverText = projectCursorDerivedState(
      input({
        lastLineKind: 'turn_ended',
        turnEndedStatus: 'success',
        textHint: 'needs_attention'
      })
    )
    expect(structuredOverText.conflicts).toHaveLength(1)
    expect(structuredOverText.conflicts[0]?.keptLifecycle).toBe('completed_signal')
    expect(structuredOverText.conflicts[0]?.ignoredEventName).toBe('text_hint.needs_attention')
    expect(structuredOverText.conflicts[0]?.ignoredChannel).toBe('transcript_file')
    expect(structuredOverText.conflicts[0]?.reason).toContain('low-confidence text hint')

    const runningOverDone = projectCursorDerivedState(
      input({
        lastLineKind: 'assistant_tool_use',
        textHint: 'done'
      })
    )
    expect(observedValue(runningOverDone.lifecycle)).toBe('running')
    expect(runningOverDone.conflicts[0]?.keptLifecycle).toBe('running')
    expect(runningOverDone.conflicts[0]?.ignoredEventName).toBe('text_hint.done')
  })

  it('15. sessionRef/turnRef 不串线', () => {
    const a = projectCursor({
      lastLineKind: 'turn_ended',
      turnEndedStatus: 'success',
      observedAt: NOW,
      dedupKey: 'cursor:transcript:a',
      sessionRef: 'sess-a',
      sessionRefSource: 'payload',
      turnRef: 'turn-a',
      turnRefSource: 'payload'
    })
    const b = projectCursor({
      lastLineKind: 'turn_ended',
      turnEndedStatus: 'success',
      observedAt: NOW + 1,
      dedupKey: 'cursor:transcript:b',
      sessionRef: 'sess-b',
      sessionRefSource: 'payload',
      turnRef: 'turn-b',
      turnRefSource: 'payload'
    })
    expect(a.derived?.sessionRef).toBe('sess-a')
    expect(b.derived?.sessionRef).toBe('sess-b')
    expect(a.derived?.turnRef).toBe('turn-a')
    expect(b.derived?.turnRef).toBe('turn-b')
    expect(a.observations[0]?.sessionRef).not.toBe(b.observations[0]?.sessionRef)
    expect(a.observations[0]?.turnRef).not.toBe(b.observations[0]?.turnRef)
  })
})

describe('注册与生产隔离', () => {
  it('17. 不自动注册生产 registry', () => {
    const registry = createAgentAdapterRegistry()
    expect(registry.listAll()).toEqual([])
    expect(registry.get('cursor', 'cursor-transcript')).toBeUndefined()
    expect(registry.get('codex', 'codex-session-shadow')).toBeUndefined()
  })

  it('测试里可以手动注册 Cursor Adapter', () => {
    const registry = createAgentAdapterRegistry()
    registry.register(createCursorTranscriptBoundary())
    expect(registry.get('cursor', 'cursor-transcript')?.identity.channel).toBe('transcript_file')
    expect(registry.dimensionCapability('cursor', 'cursor-transcript', 'process')).toBe(
      'not_observed_by_adapter'
    )
    expect(registry.get('codex', 'cursor-transcript')).toBeUndefined()
    expect(CURSOR_TRANSCRIPT_ADAPTER.identity.adapterId).toBe('cursor-transcript')
    expect(CURSOR_TRANSCRIPT_IDENTITY.agentId).toBe('cursor')
  })

  it('18. 不调用 Monitor、classify 或用户可见层', () => {
    const text = readFileSync(join(__dirname, 'cursorAdapter.ts'), 'utf8')
    expect(text).not.toContain("from '../monitor'")
    expect(text).not.toContain("from '../classify'")
    expect(text).not.toContain("from '../cursor'")
    expect(text).not.toContain("from './cursor'")
    expect(text).not.toMatch(/import\s+[^;]*scanCursor/)
    expect(text).not.toMatch(/import\s+[^;]*classifyStopText/)
    expect(text).not.toContain('handleAgentEvent')
    expect(text).not.toContain('sendBubble')
    expect(text).not.toContain('sendPetState')
    expect(text).not.toContain('playDing')
    expect(text).not.toContain('AgentMonitor')
    expect(text).not.toContain("join(homedir()")
  })

  it('16. 源码不复用 Codex event name / channel 源名', () => {
    const text = readFileSync(join(__dirname, 'cursorAdapter.ts'), 'utf8')
    expect(text).not.toContain('turn.started')
    expect(text).not.toContain('turn.completed')
    expect(text).not.toContain('turn.failed')
    expect(text).not.toContain('event_msg')
    expect(text).not.toContain('exec_json')
    expect(text).not.toContain('session_jsonl')
    expect(text).not.toContain('task_complete')
  })
})

describe('completed_signal 边界', () => {
  it('completed_signal 仍不等于 succeeded，也不回写旧 done', () => {
    const derived = projectCursorDerivedState(
      input({ lastLineKind: 'turn_ended', turnEndedStatus: 'success' })
    )
    expect(isObserved(derived.lifecycle)).toBe(true)
    expect(observedValue(derived.lifecycle)).toBe('completed_signal')
    expect(derived).not.toHaveProperty('legacyEquivalent')
    expect(derived).not.toHaveProperty('kind')
    expect(JSON.stringify(derived)).not.toContain('"done"')
  })
})
