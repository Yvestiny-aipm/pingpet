import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  CODEX_CANDIDATE_SOUND_SETTING_KEY,
  isCodexCandidateSoundSettingVisible,
  visibleCodexCandidateSettingKeys
} from '@shared/codexCandidateSettings'
import {
  CODEX_ATTENTION_NOTICE_FILENAME,
  CODEX_ATTENTION_NOTICE_SHA256,
  inspectCodexAttentionSoundFile,
  parsePcmWavHeader,
  projectCodexAttentionSoundPath,
  resolveCodexAttentionSoundPath
} from './codexAttentionSoundResource'
import { CODEX_ATTENTION_SOUND_AVAILABLE } from './codexSoundPresentation'

describe('Codex attention 方案 A 资源', () => {
  it('1-3. 方案 A 文件存在，格式和 SHA-256 与确认值一致', () => {
    const path = projectCodexAttentionSoundPath()
    expect(path.endsWith(`resources/sounds/${CODEX_ATTENTION_NOTICE_FILENAME}`)).toBe(true)
    expect(CODEX_ATTENTION_NOTICE_FILENAME).toBe('codex-attention-notice.wav')
    expect(CODEX_ATTENTION_NOTICE_FILENAME).not.toMatch(/success|complete|ding|error/i)
    const inspect = inspectCodexAttentionSoundFile(path)
    expect(inspect.ok).toBe(true)
    expect(inspect.sha256).toBe(CODEX_ATTENTION_NOTICE_SHA256)
    expect(inspect.sha256).toBe('338b49bad3848e05b2bf3f38df86c958bfbb54aa85651bf6c8b9c719fbc06a1b')
    expect(inspect.channels).toBe(1)
    expect(inspect.sampleRate).toBe(44100)
    expect(inspect.bitDepth).toBe(16)
    expect(inspect.durationMs).toBeGreaterThan(140)
    expect(inspect.durationMs).toBeLessThan(160)
    expect(CODEX_ATTENTION_SOUND_AVAILABLE).toBe(true)
    const header = parsePcmWavHeader(
      Buffer.from((inspect.dataUrl ?? '').replace(/^data:audio\/wav;base64,/, ''), 'base64')
    )
    expect(header.ok).toBe(true)
  })

  it('打包路径走 extraResources/sounds，开发路径走仓库 resources/sounds', () => {
    expect(
      resolveCodexAttentionSoundPath({
        packaged: true,
        appPath: '/app',
        resourcesPath: '/Contents/Resources'
      })
    ).toBe(`/Contents/Resources/sounds/${CODEX_ATTENTION_NOTICE_FILENAME}`)
    expect(
      resolveCodexAttentionSoundPath({
        packaged: false,
        appPath: '/project',
        resourcesPath: '/unused'
      })
    ).toBe(`/project/resources/sounds/${CODEX_ATTENTION_NOTICE_FILENAME}`)
  })

  it('损坏或缺失文件不得假装资源可用', () => {
    const missing = inspectCodexAttentionSoundFile(join(tmpdir(), 'pingpet-missing-attention.wav'))
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('attention_sound_resource_unavailable')
    const dir = join(tmpdir(), `pingpet-bad-attention-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const badPath = join(dir, 'codex-attention-notice.wav')
    writeFileSync(badPath, 'not a wav')
    const bad = inspectCodexAttentionSoundFile(badPath)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe('attention_sound_resource_unavailable')
  })

  it('4. 默认声音开关关闭，设置页不展示', () => {
    expect(DEFAULT_SETTINGS.codexCandidateSoundEnabled).toBe(false)
    expect(isCodexCandidateSoundSettingVisible()).toBe(false)
    expect(visibleCodexCandidateSettingKeys()).not.toContain(CODEX_CANDIDATE_SOUND_SETTING_KEY)
  })
})
