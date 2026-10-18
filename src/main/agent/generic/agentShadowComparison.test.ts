import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observed, unknownDimension, unsupportedDimension } from './presence'
import {
  compareShadowBatch,
  compareShadowPair,
  correlationOf,
  redactIdentity,
  renderShadowComparisonMarkdown,
  reportContainsSensitiveText,
  UNMATCHED_CORRELATION,
  type GenericShadowRecord,
  type LegacyShadowRecord,
  type ShadowPairInput
} from './agentShadowComparison'
import { projectCursor, projectCursorDerivedState, projectCursorObservation } from './cursorAdapter'
import { createAgentAdapterRegistry } from './registry'

const NOW = 1_700_000_000_000

function legacy(partial: Partial<LegacyShadowRecord> & Pick<LegacyShadowRecord, 'agentId' | 'kind'>): LegacyShadowRecord {
  return {
    source: partial.agentId,
    observedAt: NOW,
    ...partial
  }
}

function generic(
  partial: Partial<GenericShadowRecord> & Pick<GenericShadowRecord, 'agentId'>
): GenericShadowRecord {
  return {
    source: partial.agentId,
    observedAt: NOW,
    ...partial
  }
}

function pair(input: Omit<ShadowPairInput, 'evidenceGrade'> & { evidenceGrade?: ShadowPairInput['evidenceGrade'] }) {
  return compareShadowPair({ evidenceGrade: 'FIXTURE_ONLY', ...input })
}

describe('旧 kind 与通用 lifecycle', () => {
  it('1. 旧 working 与 generic running 一致', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'working',
        sessionRef: 'sess-run',
        sessionRefSource: 'payload',
        fileIdentity: 'file-run'
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-run',
        sessionRefSource: 'payload',
        fileIdentity: 'file-run',
        candidate: 'working',
        derived: {
          lifecycle: observed('running'),
          cause: unknownDimension(),
          connection: observed('connected'),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('in_progress'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.diffClass).toBe('CONSISTENT')
    expect(row.legacyKind).toBe('working')
    expect(row.derivedLifecycle).toBe('running')
    expect(row.candidate).toBe('working')
    expect(row.canConcludeTaskSemantics).toBe(false)
  })

  it('2. 旧 done 与 completed_signal 的中性映射', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'done',
        reason: 'completed',
        sessionRef: 'sess-done',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-done',
        sessionRefSource: 'payload',
        derived: {
          lifecycle: observed('completed_signal'),
          cause: unknownDimension(),
          connection: observed('connected'),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('completed'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        },
        observation: {
          eventName: 'turn.completed',
          confidence: 'high',
          recognition: 'recognized',
          evidenceOrigin: 'exec_json',
          observedAt: NOW
        }
      })
    })
    expect(row.diffClass).toBe('CONSISTENT')
    expect(row.derivedLifecycle).toBe('completed_signal')
    expect(row.derivedTaskSemantics).toBe('not_verified')
    expect(row.canConcludeTaskSemantics).toBe(false)
    expect(row.reason).toContain('不等于任务成功')
  })

  it('3. Codex tool failure + turn completion 的差异分类', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'done',
        sessionRef: 'sess-partial',
        sessionRefSource: 'payload',
        turnRef: 'turn-1',
        turnRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-partial',
        sessionRefSource: 'payload',
        turnRef: 'turn-1',
        turnRefSource: 'payload',
        candidate: 'completed_with_partial_failure',
        derived: {
          lifecycle: observed('completed_signal'),
          cause: observed('tool_failed'),
          connection: observed('connected'),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('completed'),
          item: observed('partial_failure'),
          outputIntegrity: observed('partial'),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.diffClass).toBe('GENERIC_MORE_INFORMATIVE')
    expect(row.turnCorrelationLevel).toBe('turn')
    expect(row.candidate).toBe('completed_with_partial_failure')
    expect(row.derivedCause).toBe('tool_failed')
    expect(row.canConcludeTaskSemantics).toBe(false)
  })

  it('4. ordinary abort 不被写成 user cancellation', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'failed',
        reason: 'interrupted',
        sessionRef: 'sess-abort',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-abort',
        sessionRefSource: 'payload',
        userCancelled: false,
        derived: {
          lifecycle: unknownDimension(),
          cause: unknownDimension(),
          connection: observed('connected'),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('interrupted'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.diffClass).toBe('GENERIC_MORE_CONSERVATIVE')
    expect(row.derivedLifecycle).toBe('unknown')
    expect(row.derivedCause).not.toBe('user_cancelled')
    expect(row.reason).toContain('不是已确认的用户取消')
  })

  it('5. stale 不被写成 failed', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'working',
        sessionRef: 'sess-stale',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-stale',
        sessionRefSource: 'payload',
        derived: {
          lifecycle: observed('running'),
          cause: unknownDimension(),
          connection: observed('stale'),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('in_progress'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.diffClass).toBe('CONSISTENT')
    expect(row.derivedConnection).toBe('stale')
    expect(row.derivedLifecycle).toBe('running')
    expect(row.derivedLifecycle).not.toBe('failed')
    expect(row.derivedCause).not.toBe('process_exit')
  })
})

describe('关联与隔离', () => {
  it('6. Codex 和 Cursor 不串线', () => {
    const batch = compareShadowBatch({
      evidenceGrade: 'FIXTURE_ONLY',
      legacy: [
        legacy({
          agentId: 'codex',
          kind: 'working',
          sessionRef: 'shared-looking-id',
          sessionRefSource: 'payload'
        }),
        legacy({
          agentId: 'cursor',
          kind: 'working',
          sessionRef: 'shared-looking-id',
          sessionRefSource: 'payload'
        })
      ],
      generic: [
        generic({
          agentId: 'codex',
          sessionRef: 'shared-looking-id',
          sessionRefSource: 'payload',
          derived: {
            lifecycle: observed('running'),
            cause: unknownDimension(),
            connection: unknownDimension(),
            process: unsupportedDimension(),
            session: observed('active'),
            turn: observed('in_progress'),
            item: unknownDimension(),
            outputIntegrity: unknownDimension(),
            taskSemantics: observed('not_verified'),
            retryability: unknownDimension(),
            conflicts: [],
            observedAt: NOW
          }
        }),
        generic({
          agentId: 'cursor',
          sessionRef: 'shared-looking-id',
          sessionRefSource: 'payload',
          derived: {
            lifecycle: observed('running'),
            cause: unknownDimension(),
            connection: unknownDimension(),
            process: unsupportedDimension(),
            session: observed('active'),
            turn: observed('in_progress'),
            item: unknownDimension(),
            outputIntegrity: unknownDimension(),
            taskSemantics: observed('not_verified'),
            retryability: unknownDimension(),
            conflicts: [],
            observedAt: NOW
          }
        })
      ]
    })
    expect(batch.rows).toHaveLength(2)
    expect(batch.rows.map((row) => row.agentId).sort()).toEqual(['codex', 'cursor'])
    expect(batch.rows.every((row) => row.diffClass === 'CONSISTENT')).toBe(true)
    expect(correlationOf({ agentId: 'codex' }, { agentId: 'cursor' }).level).toBe('unmatched')
  })

  it('7. 多 session 隔离', () => {
    const batch = compareShadowBatch({
      evidenceGrade: 'FIXTURE_ONLY',
      legacy: [
        legacy({ agentId: 'codex', kind: 'working', sessionRef: 'sess-a', sessionRefSource: 'payload' }),
        legacy({ agentId: 'codex', kind: 'done', sessionRef: 'sess-b', sessionRefSource: 'payload' })
      ],
      generic: [
        generic({
          agentId: 'codex',
          sessionRef: 'sess-b',
          sessionRefSource: 'payload',
          derived: {
            lifecycle: observed('completed_signal'),
            cause: unknownDimension(),
            connection: unknownDimension(),
            process: unsupportedDimension(),
            session: observed('active'),
            turn: observed('completed'),
            item: unknownDimension(),
            outputIntegrity: unknownDimension(),
            taskSemantics: observed('not_verified'),
            retryability: unknownDimension(),
            conflicts: [],
            observedAt: NOW
          }
        }),
        generic({
          agentId: 'codex',
          sessionRef: 'sess-a',
          sessionRefSource: 'payload',
          derived: {
            lifecycle: observed('running'),
            cause: unknownDimension(),
            connection: unknownDimension(),
            process: unsupportedDimension(),
            session: observed('active'),
            turn: observed('in_progress'),
            item: unknownDimension(),
            outputIntegrity: unknownDimension(),
            taskSemantics: observed('not_verified'),
            retryability: unknownDimension(),
            conflicts: [],
            observedAt: NOW
          }
        })
      ]
    })
    const bySession = Object.fromEntries(batch.rows.map((row) => [row.correlationKey, row.legacyKind]))
    expect(bySession['session:sess-a']).toBe('working')
    expect(bySession['session:sess-b']).toBe('done')
    expect(batch.rows.find((row) => row.correlationKey === 'session:sess-a')?.derivedLifecycle).toBe('running')
    expect(batch.rows.find((row) => row.correlationKey === 'session:sess-b')?.derivedLifecycle).toBe(
      'completed_signal'
    )
  })

  it('8. 重复 observationId 检测', () => {
    const batch = compareShadowBatch({
      evidenceGrade: 'FIXTURE_ONLY',
      legacy: [
        legacy({
          agentId: 'cursor',
          kind: 'working',
          sessionRef: 'sess-dup',
          sessionRefSource: 'payload',
          observationId: 'obs-1'
        })
      ],
      generic: [
        generic({
          agentId: 'cursor',
          sessionRef: 'sess-dup',
          sessionRefSource: 'payload',
          observationId: 'obs-1',
          derived: {
            lifecycle: observed('running'),
            cause: unknownDimension(),
            connection: unknownDimension(),
            process: unsupportedDimension(),
            session: observed('active'),
            turn: observed('in_progress'),
            item: unknownDimension(),
            outputIntegrity: unknownDimension(),
            taskSemantics: observed('not_verified'),
            retryability: unknownDimension(),
            conflicts: [],
            observedAt: NOW
          }
        })
      ]
    })
    expect(batch.duplicateObservationIds).toEqual(['obs-1'])
    expect(batch.rows[0]?.duplicateObservationId).toBe(true)
  })

  it('9. prime 记录不作为实时事件', () => {
    const row = pair({
      legacy: legacy({
        agentId: 'codex',
        kind: 'done',
        sessionRef: 'sess-prime',
        sessionRefSource: 'payload',
        primed: true,
        userVisible: true
      }),
      generic: generic({
        agentId: 'codex',
        sessionRef: 'sess-prime',
        sessionRefSource: 'payload',
        primed: true,
        derived: {
          lifecycle: observed('completed_signal'),
          cause: unknownDimension(),
          connection: unknownDimension(),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('completed'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.primeReplay).toBe(true)
    expect(row.userVisible).toBe(false)
  })

  it('10. 缺少 turnRef 时输出 UNMATCHED_CORRELATION', () => {
    const row = pair({
      compareAt: 'turn',
      legacy: legacy({
        agentId: 'cursor',
        kind: 'done',
        sessionRef: 'sess-no-turn',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'sess-no-turn',
        sessionRefSource: 'payload',
        derived: {
          lifecycle: observed('completed_signal'),
          cause: unknownDimension(),
          connection: unknownDimension(),
          process: unsupportedDimension(),
          session: observed('active'),
          turn: observed('completed'),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(row.turnCorrelationLevel).toBe('unmatched')
    expect(row.diffClass).toBe(UNMATCHED_CORRELATION)
    expect(row.maxCorrelationLevel).toBe('session')
  })

  it('11. 不用时间戳猜测 turn', () => {
    const linked = correlationOf(
      {
        agentId: 'cursor',
        turnRef: String(NOW),
        turnRefSource: 'timestamp'
      },
      {
        agentId: 'cursor',
        turnRef: String(NOW),
        turnRefSource: 'timestamp'
      }
    )
    expect(linked.level).toBe('unmatched')
    expect(linked.key).toBe(UNMATCHED_CORRELATION)

    const filename = correlationOf(
      { agentId: 'cursor', turnRef: 'abc.jsonl', turnRefSource: 'filename' },
      { agentId: 'cursor', turnRef: 'abc.jsonl', turnRefSource: 'filename' }
    )
    expect(filename.level).toBe('unmatched')
  })

  it('12. fixture 与真实样本证据等级分离', () => {
    const fixture = pair({
      evidenceGrade: 'FIXTURE_ONLY',
      legacy: legacy({ agentId: 'cursor', kind: 'done', fileIdentity: 'fix-1' }),
      generic: generic({
        agentId: 'cursor',
        fileIdentity: 'fix-1',
        derived: {
          lifecycle: observed('completed_signal'),
          cause: unknownDimension(),
          connection: unknownDimension(),
          process: unsupportedDimension(),
          session: unknownDimension(),
          turn: unknownDimension(),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    const uncovered = pair({
      evidenceGrade: 'SAMPLE_NOT_COVERED',
      legacy: legacy({ agentId: 'cursor', kind: 'done', fileIdentity: 'real-1' }),
      generic: generic({
        agentId: 'cursor',
        fileIdentity: 'real-1',
        derived: {
          lifecycle: observed('completed_signal'),
          cause: unknownDimension(),
          connection: unknownDimension(),
          process: unsupportedDimension(),
          session: unknownDimension(),
          turn: unknownDimension(),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW
        }
      })
    })
    expect(fixture.evidenceGrade).toBe('FIXTURE_ONLY')
    expect(uncovered.evidenceGrade).toBe('SAMPLE_NOT_COVERED')
    expect(uncovered.diffClass).toBe('SAMPLE_NOT_COVERED')
    expect(fixture.evidenceGrade).not.toBe(uncovered.evidenceGrade)
  })
})

describe('Cursor 投影对照', () => {
  it('Cursor working/running、done/completed_signal、文本 success 低可信', () => {
    const running = projectCursor({
      lastLineKind: 'assistant_tool_use',
      observedAt: NOW,
      dedupKey: 'cursor:transcript:run',
      sessionRef: 'cursor-sess',
      sessionRefSource: 'payload'
    })
    const textDone = projectCursor({
      lastLineKind: 'assistant_text',
      textHint: 'success',
      observedAt: NOW + 1,
      dedupKey: 'cursor:transcript:text',
      sessionRef: 'cursor-sess',
      sessionRefSource: 'payload'
    })
    const turnEnded = projectCursor({
      lastLineKind: 'turn_ended',
      turnEndedStatus: 'success',
      observedAt: NOW + 2,
      dedupKey: 'cursor:transcript:end',
      sessionRef: 'cursor-sess',
      sessionRefSource: 'payload'
    })

    const runRow = pair({
      legacy: legacy({
        agentId: 'cursor',
        kind: 'working',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        userVisible: false
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        observation: running.observations[0],
        derived: running.derived
      })
    })
    const textRow = pair({
      legacy: legacy({
        agentId: 'cursor',
        kind: 'done',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        userVisible: true
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        observation: textDone.observations[0],
        derived: textDone.derived
      })
    })
    const endedRow = pair({
      legacy: legacy({
        agentId: 'cursor',
        kind: 'done',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        userVisible: true
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'cursor-sess',
        sessionRefSource: 'payload',
        observation: turnEnded.observations[0],
        derived: turnEnded.derived
      })
    })

    expect(runRow.diffClass).toBe('CONSISTENT')
    expect(textRow.diffClass).toBe('GENERIC_MORE_CONSERVATIVE')
    expect(textRow.observationConfidence).toBe('low')
    expect(endedRow.diffClass).toBe('LEGACY_COMPATIBILITY')
    expect(endedRow.derivedTaskSemantics).toBe('not_verified')
    expect(endedRow.turnCorrelationLevel).toBe('unmatched')
  })

  it('item/tool error 与 ordinary abort 区分', () => {
    const item = pair({
      legacy: legacy({
        agentId: 'cursor',
        kind: 'working',
        sessionRef: 'c-item',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'c-item',
        sessionRefSource: 'payload',
        derived: projectCursorDerivedState({
          lastLineKind: 'assistant_tool_use',
          itemOrToolFailed: true,
          observedAt: NOW,
          dedupKey: 'cursor:item'
        })
      })
    })
    const abort = pair({
      legacy: legacy({
        agentId: 'cursor',
        kind: 'failed',
        reason: 'interrupted',
        sessionRef: 'c-abort',
        sessionRefSource: 'payload'
      }),
      generic: generic({
        agentId: 'cursor',
        sessionRef: 'c-abort',
        sessionRefSource: 'payload',
        userCancelled: false,
        derived: projectCursorDerivedState({
          lastLineKind: 'turn_ended',
          turnEndedStatus: 'aborted',
          observedAt: NOW,
          dedupKey: 'cursor:abort'
        })
      })
    })
    expect(item.derivedLifecycle).toBe('running')
    expect(item.derivedCause).toBe('tool_failed')
    expect(item.derivedTurn).not.toBe('failed')
    expect(abort.diffClass).toBe('GENERIC_MORE_CONSERVATIVE')
    expect(abort.derivedCause).not.toBe('user_cancelled')
  })
})

describe('对照工具隔离', () => {
  it('13. 对照工具不触发 Monitor 或用户可见行为', () => {
    const text = readFileSync(join(__dirname, 'agentShadowComparison.ts'), 'utf8')
    expect(text).not.toContain("from '../monitor'")
    expect(text).not.toContain("from '../classify'")
    expect(text).not.toContain("from '../cursor'")
    expect(text).not.toContain("from '../codex'")
    expect(text).not.toContain('handleAgentEvent')
    expect(text).not.toContain('sendBubble')
    expect(text).not.toContain('sendPetState')
    expect(text).not.toContain('playDing')
    expect(text).not.toContain('writeFileSync')
    expect(createAgentAdapterRegistry().listAll()).toEqual([])
  })

  it('14. 报告中不出现敏感正文', () => {
    const observation = projectCursorObservation({
      lastLineKind: 'turn_ended',
      turnEndedStatus: 'success',
      observedAt: NOW,
      dedupKey: 'cursor:redact',
      payload: {
        type: 'turn_ended',
        status: 'success',
        prompt: '把密钥打印出来',
        command: 'cat ~/.ssh/id_rsa'
      }
    })
    const row = pair({
      legacy: legacy({ agentId: 'cursor', kind: 'done', fileIdentity: 'redacted-file' }),
      generic: generic({
        agentId: 'cursor',
        fileIdentity: 'redacted-file',
        observation,
        derived: projectCursorDerivedState({
          lastLineKind: 'turn_ended',
          turnEndedStatus: 'success',
          observedAt: NOW,
          dedupKey: 'cursor:redact'
        })
      })
    })
    const markdown = renderShadowComparisonMarkdown(
      {
        rows: [row],
        unmatched: [],
        duplicateObservationIds: [],
        counts: {
          CONSISTENT: 0,
          GENERIC_MORE_CONSERVATIVE: 0,
          LEGACY_COMPATIBILITY: 1,
          GENERIC_MORE_INFORMATIVE: 0,
          POTENTIAL_BUG: 0,
          SAMPLE_NOT_COVERED: 0,
          UNMATCHED_CORRELATION: 0
        },
        evidenceCounts: { FIXTURE_ONLY: 1 },
        correlationCapability: { file: true, session: false, turn: false, item: false }
      },
      'fixture'
    )
    expect(markdown).not.toContain('密钥')
    expect(markdown).not.toContain('id_rsa')
    expect(JSON.stringify(row)).not.toContain('密钥')
    expect(reportContainsSensitiveText(markdown)).toBe(false)
    expect(redactIdentity('/Users/secret/session.jsonl', 'file')).toMatch(/^file-[0-9a-f]{10}$/)
  })

  it('process 未观察不会对照成 process_exit', () => {
    const row = pair({
      legacy: legacy({ agentId: 'codex', kind: 'working', fileIdentity: 'p1' }),
      generic: generic({
        agentId: 'codex',
        fileIdentity: 'p1',
        derived: {
          lifecycle: observed('running'),
          cause: unknownDimension(),
          connection: unknownDimension(),
          process: unsupportedDimension(),
          session: unknownDimension(),
          turn: unknownDimension(),
          item: unknownDimension(),
          outputIntegrity: unknownDimension(),
          taskSemantics: observed('not_verified'),
          retryability: unknownDimension(),
          conflicts: [],
          observedAt: NOW,
          extension: { process: 'not_observed' }
        }
      })
    })
    expect(row.derivedProcess).toBe('unsupported')
    expect(row.derivedCause).not.toBe('process_exit')
  })
})
