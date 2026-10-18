import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Codex 部分失败 attention/notice 资源。
 * 独立于 playDing 完成音。加载失败只静音，绝不回退完成音。
 */

export const CODEX_ATTENTION_NOTICE_FILENAME = 'codex-attention-notice.wav'
export const CODEX_ATTENTION_NOTICE_SHA256 =
  '338b49bad3848e05b2bf3f38df86c958bfbb54aa85651bf6c8b9c719fbc06a1b'

export interface CodexAttentionSoundInspect {
  ok: boolean
  reason: string
  path: string
  sha256: string | null
  channels: number | null
  sampleRate: number | null
  bitDepth: number | null
  durationMs: number | null
  dataUrl?: string
}

export function resolveCodexAttentionSoundPath(args: {
  packaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  if (args.packaged) {
    return join(args.resourcesPath, 'sounds', CODEX_ATTENTION_NOTICE_FILENAME)
  }
  return join(args.appPath, 'resources', 'sounds', CODEX_ATTENTION_NOTICE_FILENAME)
}

export function projectCodexAttentionSoundPath(cwd = process.cwd()): string {
  return join(cwd, 'resources', 'sounds', CODEX_ATTENTION_NOTICE_FILENAME)
}

export function parsePcmWavHeader(buf: Buffer): {
  ok: boolean
  channels: number | null
  sampleRate: number | null
  bitDepth: number | null
  durationMs: number | null
  reason: string
} {
  if (buf.length < 44) {
    return { ok: false, channels: null, sampleRate: null, bitDepth: null, durationMs: null, reason: 'wav_too_short' }
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, channels: null, sampleRate: null, bitDepth: null, durationMs: null, reason: 'not_pcm_wav' }
  }
  let offset = 12
  let channels: number | null = null
  let sampleRate: number | null = null
  let bitDepth: number | null = null
  let audioFormat: number | null = null
  let dataBytes: number | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ' && size >= 16 && start + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(start)
      channels = buf.readUInt16LE(start + 2)
      sampleRate = buf.readUInt32LE(start + 4)
      bitDepth = buf.readUInt16LE(start + 14)
    }
    if (id === 'data') {
      dataBytes = size
      break
    }
    offset = start + size + (size % 2)
  }
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 44100 || bitDepth !== 16 || !dataBytes) {
    return {
      ok: false,
      channels,
      sampleRate,
      bitDepth,
      durationMs: null,
      reason: 'wav_format_mismatch'
    }
  }
  const durationMs = (dataBytes / (sampleRate * channels * (bitDepth / 8))) * 1000
  return { ok: true, channels, sampleRate, bitDepth, durationMs, reason: 'wav_ok' }
}

export function inspectCodexAttentionSoundFile(filePath: string): CodexAttentionSoundInspect {
  const empty: CodexAttentionSoundInspect = {
    ok: false,
    reason: 'attention_sound_resource_unavailable',
    path: filePath,
    sha256: null,
    channels: null,
    sampleRate: null,
    bitDepth: null,
    durationMs: null
  }
  try {
    if (!existsSync(filePath)) return empty
    const buf = readFileSync(filePath)
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const wav = parsePcmWavHeader(buf)
    if (sha256 !== CODEX_ATTENTION_NOTICE_SHA256 || !wav.ok) {
      return {
        ...empty,
        sha256,
        channels: wav.channels,
        sampleRate: wav.sampleRate,
        bitDepth: wav.bitDepth,
        durationMs: wav.durationMs,
        reason: 'attention_sound_resource_unavailable'
      }
    }
    return {
      ok: true,
      reason: 'codex_attention_notice_ready',
      path: filePath,
      sha256,
      channels: wav.channels,
      sampleRate: wav.sampleRate,
      bitDepth: wav.bitDepth,
      durationMs: wav.durationMs,
      dataUrl: `data:audio/wav;base64,${buf.toString('base64')}`
    }
  } catch {
    return empty
  }
}

export function isCodexAttentionSoundResourceReady(filePath = projectCodexAttentionSoundPath()): boolean {
  return inspectCodexAttentionSoundFile(filePath).ok
}
