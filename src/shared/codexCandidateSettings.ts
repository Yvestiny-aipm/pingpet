import type { Settings } from './types'

/**
 * Codex candidate 设置页入口。
 *
 * 声音开关保留在 Settings 里（默认 false），本轮不向普通用户展示：
 * 没有独立 attention 音，打开也不会出声。
 */

export type CodexCandidateUiSettingKey =
  | 'codexCandidateVisualEnabled'
  | 'codexCandidateBubbleEnabled'

export interface CodexCandidateSettingItem {
  key: CodexCandidateUiSettingKey
  title: string
  description: string
}

export const CODEX_CANDIDATE_SETTING_ITEMS: readonly CodexCandidateSettingItem[] = [
  {
    key: 'codexCandidateVisualEnabled',
    title: 'Codex 状态感知（实验性）',
    description:
      '让桌宠根据 Codex 的工作状态改变姿态。当前只支持工作中、部分失败和中性结束，不代表任务一定完成。'
  },
  {
    key: 'codexCandidateBubbleEnabled',
    title: 'Codex 部分失败提醒',
    description:
      '当 Codex 的某个工具失败、但这一轮仍然结束时，显示一次提醒。这不代表整轮失败，也不代表任务已经成功。'
  }
]

export const CODEX_CANDIDATE_SETTINGS_CARD_TITLE = 'Codex 实验性提示'

export const CODEX_CANDIDATE_SETTINGS_CARD_HINT =
  '默认关闭。改完立刻生效，只影响 Codex。关闭后不再产生新的姿态或气泡，不会删除已有诊断文件，也不影响现有 Agent 监控。'

/** 声音开关已入库，但本轮不在设置页展示。 */
export const CODEX_CANDIDATE_SOUND_SETTING_VISIBLE = false

export const CODEX_CANDIDATE_SOUND_SETTING_KEY = 'codexCandidateSoundEnabled' as const

export function isCodexCandidateSoundSettingVisible(): boolean {
  return CODEX_CANDIDATE_SOUND_SETTING_VISIBLE
}

export function visibleCodexCandidateSettingKeys(): CodexCandidateUiSettingKey[] {
  return CODEX_CANDIDATE_SETTING_ITEMS.map((item) => item.key)
}

export function sanitizeCodexCandidateSettings(
  partial: Partial<Settings> | Record<string, unknown>
): Partial<
  Pick<
    Settings,
    'codexCandidateVisualEnabled' | 'codexCandidateBubbleEnabled' | 'codexCandidateSoundEnabled'
  >
> {
  const next: Partial<Settings> = {}
  if (typeof partial.codexCandidateVisualEnabled === 'boolean') {
    next.codexCandidateVisualEnabled = partial.codexCandidateVisualEnabled
  }
  if (typeof partial.codexCandidateBubbleEnabled === 'boolean') {
    next.codexCandidateBubbleEnabled = partial.codexCandidateBubbleEnabled
  }
  if (typeof partial.codexCandidateSoundEnabled === 'boolean') {
    next.codexCandidateSoundEnabled = partial.codexCandidateSoundEnabled
  }
  return next
}

/** 磁盘缺失或脏字段一律回落 false。只有合法 boolean 才会覆盖默认值。 */
export function resolveCodexCandidateSettings(
  stored: Partial<Settings> | Record<string, unknown>
): Pick<
  Settings,
  'codexCandidateVisualEnabled' | 'codexCandidateBubbleEnabled' | 'codexCandidateSoundEnabled'
> {
  const sanitized = sanitizeCodexCandidateSettings(stored)
  return {
    codexCandidateVisualEnabled: sanitized.codexCandidateVisualEnabled ?? false,
    codexCandidateBubbleEnabled: sanitized.codexCandidateBubbleEnabled ?? false,
    codexCandidateSoundEnabled: sanitized.codexCandidateSoundEnabled ?? false
  }
}

export function simulateSettingsReload(
  previous: Settings,
  diskPatch: Partial<Settings> | Record<string, unknown>
): Settings {
  return { ...previous, ...sanitizeCodexCandidateSettings(diskPatch) }
}
