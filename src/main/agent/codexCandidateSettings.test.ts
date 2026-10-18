import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  CODEX_CANDIDATE_SETTING_ITEMS,
  CODEX_CANDIDATE_SETTINGS_CARD_HINT,
  CODEX_CANDIDATE_SOUND_SETTING_KEY,
  isCodexCandidateSoundSettingVisible,
  resolveCodexCandidateSettings,
  sanitizeCodexCandidateSettings,
  simulateSettingsReload,
  visibleCodexCandidateSettingKeys
} from '@shared/codexCandidateSettings'
import type { CodexDerivedState, Settings } from '@shared/types'
import { CodexPartialFailureBubbleGate, planCodexPartialFailureBubble } from './codexBubblePresentation'
import {
  petStateForPresentedKind,
  shouldPlayAgentCompletionSound,
  shouldPresentAgentTerminalToUser
} from './codexLegacyPresentation'
import { CodexPartialFailureSoundGate, planCodexPartialFailureSound } from './codexSoundPresentation'
import { emptyCodexDerivedState } from './codexState'
import {
  CodexSilentVisualGate,
  planCodexSilentVisual,
  shouldLegacyCodexDrivePetVisual
} from './codexVisiblePresentation'

const NOW = 1_700_000_000_000

function derived(partial: Partial<CodexDerivedState> = {}): CodexDerivedState {
  return {
    ...emptyCodexDerivedState(NOW),
    confidence: 'high',
    sessionId: partial.sessionId ?? 'sess-a',
    ...partial
  }
}

function working(): CodexDerivedState {
  return derived({
    lifecycle: 'running',
    turn: 'in_progress',
    item: 'running',
    connection: 'connected'
  })
}

function partialFailure(): CodexDerivedState {
  return derived({
    lifecycle: 'completed_signal',
    turn: 'completed',
    cause: 'tool_failed',
    item: 'partial_failure',
    outputIntegrity: 'partial',
    taskSemantics: 'not_verified',
    connection: 'connected'
  })
}

describe('Codex candidate 设置默认值与入口', () => {
  it('1. 两个开关默认 false，声音开关也默认 false 且不展示', () => {
    expect(DEFAULT_SETTINGS.codexCandidateVisualEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateBubbleEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.codexCandidateSoundEnabled).toBe(false)
    expect(isCodexCandidateSoundSettingVisible()).toBe(false)
  })

  it('2. 设置页能显示两个开关，且不含声音开关', () => {
    expect(CODEX_CANDIDATE_SETTING_ITEMS).toHaveLength(2)
    expect(visibleCodexCandidateSettingKeys()).toEqual([
      'codexCandidateVisualEnabled',
      'codexCandidateBubbleEnabled'
    ])
    expect(CODEX_CANDIDATE_SETTING_ITEMS.map((item) => item.title)).toEqual([
      'Codex 状态感知（实验性）',
      'Codex 部分失败提醒'
    ])
    expect(visibleCodexCandidateSettingKeys()).not.toContain(CODEX_CANDIDATE_SOUND_SETTING_KEY)
    expect(CODEX_CANDIDATE_SETTING_ITEMS.map((item) => item.title).join(' ')).not.toMatch(/声音|提示音/)
    expect(CODEX_CANDIDATE_SETTINGS_CARD_HINT).toContain('立刻生效')
    expect(CODEX_CANDIDATE_SETTINGS_CARD_HINT).toContain('不会删除已有诊断')
    expect(CODEX_CANDIDATE_SETTINGS_CARD_HINT).not.toContain('声音')
  })

  it('3-4. 用户打开视觉或气泡开关后，只有该字段被写入', () => {
    expect(sanitizeCodexCandidateSettings({ codexCandidateVisualEnabled: true })).toEqual({
      codexCandidateVisualEnabled: true
    })
    expect(sanitizeCodexCandidateSettings({ codexCandidateBubbleEnabled: true })).toEqual({
      codexCandidateBubbleEnabled: true
    })
  })

  it('5. 重启后配置保持：磁盘上的合法 boolean 会合并回来', () => {
    const afterVisual = simulateSettingsReload(DEFAULT_SETTINGS, {
      codexCandidateVisualEnabled: true
    })
    const afterBoth = simulateSettingsReload(afterVisual, {
      codexCandidateBubbleEnabled: true
    })
    expect(afterVisual.codexCandidateVisualEnabled).toBe(true)
    expect(afterVisual.codexCandidateBubbleEnabled).toBe(false)
    expect(afterBoth.codexCandidateVisualEnabled).toBe(true)
    expect(afterBoth.codexCandidateBubbleEnabled).toBe(true)
    expect(afterBoth.codexCandidateSoundEnabled).toBe(false)
  })

  it('6. 缺失字段回退 false', () => {
    expect(resolveCodexCandidateSettings({})).toEqual({
      codexCandidateVisualEnabled: false,
      codexCandidateBubbleEnabled: false,
      codexCandidateSoundEnabled: false
    })
    expect(resolveCodexCandidateSettings({ petScale: 1.2 })).toEqual({
      codexCandidateVisualEnabled: false,
      codexCandidateBubbleEnabled: false,
      codexCandidateSoundEnabled: false
    })
  })

  it('7. 非法值回退 false，不写入', () => {
    expect(
      sanitizeCodexCandidateSettings({
        codexCandidateVisualEnabled: 'true',
        codexCandidateBubbleEnabled: 1,
        codexCandidateSoundEnabled: null
      } as unknown as Partial<Settings>)
    ).toEqual({})
    expect(
      resolveCodexCandidateSettings({
        codexCandidateVisualEnabled: 'yes',
        codexCandidateBubbleEnabled: 0
      })
    ).toEqual({
      codexCandidateVisualEnabled: false,
      codexCandidateBubbleEnabled: false,
      codexCandidateSoundEnabled: false
    })
  })

  it('14. 用户长期配置只在显式修改时变化', () => {
    expect(sanitizeCodexCandidateSettings({})).toEqual({})
    expect(sanitizeCodexCandidateSettings({ petScale: 1.4, bubblesEnabled: false })).toEqual({})
    const untouched = simulateSettingsReload(DEFAULT_SETTINGS, { petScale: 1.4 })
    expect(untouched.codexCandidateVisualEnabled).toBe(false)
    expect(untouched.codexCandidateBubbleEnabled).toBe(false)
    expect(untouched.codexCandidateSoundEnabled).toBe(false)
  })
})

describe('关闭设置后的用户行为', () => {
  it('8. 关闭视觉开关后 Codex candidate 不改变姿态', () => {
    const planned = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: false,
      derived: working(),
      fileAlias: 'file-a'
    })
    expect(planned.applied).toBe(false)
    expect(planned.presentation.applyPetState).toBe(false)
    expect(planned.presentation.petState).toBeNull()
    expect(planned.presentation.reason).toBe('codex_candidate_visual_disabled')
  })

  it('9. 关闭气泡开关后 Codex candidate 不弹气泡', () => {
    const planned = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: false,
      derived: partialFailure(),
      fileAlias: 'file-a'
    })
    expect(planned.presentation.showBubble).toBe(false)
    expect(planned.presentation.reason).toBe('codex_candidate_bubble_disabled')
  })

  it('10. 其他 Agent 不受影响', () => {
    for (const source of ['claude', 'cursor', 'grok'] as const) {
      expect(shouldLegacyCodexDrivePetVisual(true, { source, kind: 'done' })).toBe(true)
      expect(shouldPresentAgentTerminalToUser({ source, kind: 'done' })).toBe(true)
      expect(shouldPlayAgentCompletionSound([{ source, kind: 'done' }])).toBe(true)
      expect(petStateForPresentedKind('done')).toBe('happy')
    }
  })

  it('11. shouldNotify 仍为 false', () => {
    const visual = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: partialFailure(),
      fileAlias: 'file-a'
    })
    const bubble = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: partialFailure(),
      fileAlias: 'file-a'
    })
    expect(visual.candidate.shouldNotify).toBe(false)
    expect(visual.presentation.shouldNotify).toBe(false)
    expect(bubble.presentation.shouldNotify).toBe(false)
  })

  it('12. 默认声音关闭且设置页不展示；打开后只走独立 attention，不走完成音', () => {
    expect(DEFAULT_SETTINGS.codexCandidateSoundEnabled).toBe(false)
    expect(isCodexCandidateSoundSettingVisible()).toBe(false)
    const off = planCodexPartialFailureSound(new CodexPartialFailureSoundGate(), {
      enabled: DEFAULT_SETTINGS.codexCandidateSoundEnabled,
      derived: partialFailure(),
      fileAlias: 'file-a',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(off.presentation.playSound).toBe(false)
    const on = planCodexPartialFailureSound(new CodexPartialFailureSoundGate(), {
      enabled: true,
      derived: partialFailure(),
      fileAlias: 'file-a',
      bubbleActuallyPresented: true,
      attentionAcknowledged: true
    })
    expect(on.presentation.playSound).toBe(true)
    expect(on.presentation.soundType).toBe('attention')
    expect(on.presentation.shouldNotify).toBe(false)
  })

  it('13. priming/history 不触发用户可见行为', () => {
    const visual = planCodexSilentVisual(new CodexSilentVisualGate(), {
      enabled: true,
      derived: working(),
      fileAlias: 'file-hist',
      live: false
    })
    const bubble = planCodexPartialFailureBubble(new CodexPartialFailureBubbleGate(), {
      enabled: true,
      derived: partialFailure(),
      fileAlias: 'file-hist',
      live: false
    })
    expect(visual.applied).toBe(false)
    expect(visual.presentation.reason).toBe('priming_not_arbitrated')
    expect(bubble.presentation.showBubble).toBe(false)
    expect(bubble.presentation.reason).toBe('priming_not_bubbled')
  })
})
