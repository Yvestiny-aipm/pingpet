import { statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  AGENT_FILE_FRESH_MS,
  AGENT_MAX_FILES_PER_SOURCE,
  AGENT_SCAN_MAX_DEPTH,
  CODEX_OBSERVATION_STALE_AFTER_MS
} from '@shared/defaults'
import type { CodexDerivedState, CodexStateMigration } from '@shared/types'
import { codexSessionsRoot } from './codex'
import {
  CodexObservationJournal,
  emptyCodexJsonlFileCursor,
  observeCodexJsonlFile,
  type CodexJsonlFileCursor
} from './codexObserve'
import { CodexStateDetector } from './codexState'
import { findRecentFiles } from './findFiles'
import { readFileTextFromOffset } from './readJsonl'
import { redactDiagnosticId } from './codexShadowLog'

/**
 * Codex session JSONL 的只读影子观察。
 *
 * 每个会话文件独立维护 cursor / journal / detector。
 * 只记录派生状态，不映射 working/done/failed，不驱动桌宠，
 * 不调用 finalizeIncomplete，不调用 applyProcess。
 */

export interface CodexShadowFileSnapshot {
  filePath: string
  state: CodexDerivedState
  migrations: readonly CodexStateMigration[]
  primed: boolean
}

export interface CodexShadowCallbackMeta {
  observationId: string
  seq: number
  fileAlias: string
}

export interface CodexShadowObserveOptions {
  /** false：只 priming（建立 cursor/journal/detector），不发诊断回调 */
  emitCallbacks: boolean
  onState?: (
    state: CodexDerivedState,
    migration?: CodexStateMigration,
    meta?: CodexShadowCallbackMeta
  ) => void
}

export interface CodexSessionShadowOptions {
  /** 单轮每个文件最多读几片。测试可降到 1，模拟超大文件多轮 priming。 */
  maxSlicesPerFile?: number
  /** 每片最多读多少字节。默认与 observeCodexJsonlFile 一致。 */
  maxBytesPerSlice?: number
  /**
   * 观察失联阈值（毫秒）。PingPet 产品策略，不是 Codex 协议。
   * 默认 CODEX_OBSERVATION_STALE_AFTER_MS。测试必须注入短值，并用外部 clock。
   */
  observationStaleAfterMs?: number
}

interface FileIdentity {
  dev: number
  ino: number
  prefix: string
}

interface SessionFileShadow {
  filePath: string
  cursor: CodexJsonlFileCursor
  journal: CodexObservationJournal
  detector: CodexStateDetector
  primed: boolean
  identity: FileIdentity
  emitSeq: number
  /** priming 或之后是否见过 running / in_progress。没有活动 turn 不得 stale。 */
  hadActiveTurn: boolean
  /** priming 完成后，最近一次真实新增事件的 PingPet observedAt。 */
  lastLiveEventObservedAt: number | null
  /** 本轮失联周期是否已写过 stale 诊断。恢复后清零，允许下一次失联再写一次。 */
  staleEmitted: boolean
  lastStaleObservedAt: number | null
}

const DEFAULT_MAX_SLICES_PER_FILE = 64
const DEFAULT_MAX_BYTES_PER_SLICE = 256_000
const PREFIX_BYTES = 256

export function listCodexSessionFiles(nowMs: number): string[] {
  return findRecentFiles(
    codexSessionsRoot(),
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    AGENT_SCAN_MAX_DEPTH,
    { minMtimeMs: nowMs - AGENT_FILE_FRESH_MS }
  )
}

function safeStat(filePath: string): { size: number; dev: number; ino: number } | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    return { size: stat.size, dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

function readPrefix(filePath: string, length: number): string {
  if (length <= 0) return ''
  return readFileTextFromOffset(filePath, 0, length).text
}

function readIdentity(filePath: string): (FileIdentity & { size: number }) | null {
  const stat = safeStat(filePath)
  if (!stat) return null
  return {
    dev: stat.dev,
    ino: stat.ino,
    prefix: readPrefix(filePath, Math.min(PREFIX_BYTES, stat.size)),
    size: stat.size
  }
}

function fileWasReplaced(track: SessionFileShadow, identity: FileIdentity, size: number): boolean {
  if (track.identity.dev !== identity.dev || track.identity.ino !== identity.ino) return true
  if (track.cursor.byteOffset > size) return true
  if (track.identity.prefix !== identity.prefix.slice(0, track.identity.prefix.length)) return true
  return false
}

export class CodexSessionShadow {
  private readonly files = new Map<string, SessionFileShadow>()
  private readonly maxSlicesPerFile: number
  private readonly maxBytesPerSlice: number
  private readonly observationStaleAfterMs: number

  constructor(options: CodexSessionShadowOptions = {}) {
    this.maxSlicesPerFile = Math.max(1, options.maxSlicesPerFile ?? DEFAULT_MAX_SLICES_PER_FILE)
    this.maxBytesPerSlice = Math.max(1, options.maxBytesPerSlice ?? DEFAULT_MAX_BYTES_PER_SLICE)
    this.observationStaleAfterMs = Math.max(
      1,
      options.observationStaleAfterMs ?? CODEX_OBSERVATION_STALE_AFTER_MS
    )
  }

  clear(): void {
    this.files.clear()
  }

  snapshots(): CodexShadowFileSnapshot[] {
    return [...this.files.values()].map((track) => this.toSnapshot(track))
  }

  snapshotFor(filePath: string): CodexShadowFileSnapshot | undefined {
    const track = this.files.get(filePath)
    return track ? this.toSnapshot(track) : undefined
  }

  /**
   * observedAt 是 PingPet 本轮读取/处理时间，传给观察层和检测器。
   * 不得把它当作 Codex 原始 eventTime。
   */
  observe(filePaths: string[], observedAt: number, options: CodexShadowObserveOptions): void {
    const listed = new Set(filePaths)
    for (const filePath of filePaths) {
      this.observeFile(filePath, observedAt, options)
    }
    this.reapMissingTracks(listed)
  }

  private toSnapshot(track: SessionFileShadow): CodexShadowFileSnapshot {
    return {
      filePath: track.filePath,
      state: track.detector.getState(),
      migrations: track.detector.getMigrations(),
      primed: track.primed
    }
  }

  /**
   * 不在本轮列表里的 track：文件已删除才清掉；
   * 只是 mtime 过旧没被列进来时保留，且不产生 incomplete/failed。
   */
  private reapMissingTracks(listed: Set<string>): void {
    for (const [filePath] of this.files) {
      if (listed.has(filePath)) continue
      if (safeStat(filePath) === null) {
        this.files.delete(filePath)
      }
    }
  }

  private observeFile(
    filePath: string,
    observedAt: number,
    options: CodexShadowObserveOptions
  ): void {
    const identity = readIdentity(filePath)
    if (!identity) {
      this.files.delete(filePath)
      return
    }

    let track = this.files.get(filePath)
    if (!track) {
      track = this.createTrack(filePath, observedAt, identity)
      this.files.set(filePath, track)
    } else if (fileWasReplaced(track, identity, identity.size)) {
      track = this.createTrack(filePath, observedAt, identity)
      this.files.set(filePath, track)
    }

    const emit = options.emitCallbacks && track.primed
    const { eof, acceptedLive } = this.consume(track, observedAt, emit, options.onState)
    if (acceptedLive > 0) {
      track.lastLiveEventObservedAt = observedAt
      track.staleEmitted = false
    }
    if (eof) track.primed = true
    if (emit && eof) this.maybeMarkStale(track, observedAt, options.onState)
  }

  private createTrack(
    filePath: string,
    observedAt: number,
    identity: FileIdentity
  ): SessionFileShadow {
    return {
      filePath,
      cursor: emptyCodexJsonlFileCursor(),
      journal: new CodexObservationJournal(),
      detector: new CodexStateDetector(observedAt),
      primed: false,
      identity,
      emitSeq: 0,
      hadActiveTurn: false,
      lastLiveEventObservedAt: null,
      staleEmitted: false,
      lastStaleObservedAt: null
    }
  }

  /**
   * 产品策略：priming 后见过真实新事件、且 turn 曾活动、超过阈值、无协议终态/process_exit
   * 才标 stale。文件缺席、删除、mtime、轮换、stderr、turn_aborted 都不能单独触发。
   * 不调用 applyProcess。
   */
  private maybeMarkStale(
    track: SessionFileShadow,
    observedAt: number,
    onState: CodexShadowObserveOptions['onState']
  ): void {
    if (track.staleEmitted) return
    if (!track.primed) return
    if (!track.hadActiveTurn) return
    if (track.lastLiveEventObservedAt == null) return
    if (observedAt - track.lastLiveEventObservedAt < this.observationStaleAfterMs) return
    const applied = track.detector.markObservationStale(observedAt)
    if (!applied.applied || !applied.migration) return
    track.staleEmitted = true
    track.lastStaleObservedAt = observedAt
    track.emitSeq += 1
    const fileAlias = redactDiagnosticId(basename(track.filePath), 'file') ?? 'file-unknown'
    const observationId = `shadow:observer:observation_stale:${fileAlias}`
    try {
      onState?.(applied.state, applied.migration, {
        observationId,
        seq: track.emitSeq,
        fileAlias
      })
    } catch {
      /* 诊断回调失败不得影响影子 detector 或旧路径 */
    }
  }

  /** 读到 eof 才返回 eof。未读完保持 cursor，供下一轮继续，且不得回调。 */
  private consume(
    track: SessionFileShadow,
    observedAt: number,
    emit: boolean,
    onState: CodexShadowObserveOptions['onState']
  ): { eof: boolean; acceptedLive: number } {
    let eof = false
    let acceptedLive = 0
    for (let i = 0; i < this.maxSlicesPerFile; i += 1) {
      const previousOffset = track.cursor.byteOffset
      const result = observeCodexJsonlFile(
        track.filePath,
        track.journal,
        track.cursor,
        observedAt,
        this.maxBytesPerSlice
      )
      track.cursor = result.cursor
      eof = result.eof
      for (const item of result.results) {
        if (!item.accepted) continue
        const applied = track.detector.apply(item.event)
        const state = track.detector.getState()
        if (state.lifecycle === 'running' || state.turn === 'in_progress') {
          track.hadActiveTurn = true
        }
        if (emit) acceptedLive += 1
        if (emit && applied.applied && applied.migration) {
          track.emitSeq += 1
          const fileAlias = redactDiagnosticId(basename(track.filePath), 'file') ?? 'file-unknown'
          const observationId = `shadow:${applied.migration.eventDedupKey ?? `${fileAlias}:${track.emitSeq}`}`
          try {
            onState?.(applied.state, applied.migration, {
              observationId,
              seq: track.emitSeq,
              fileAlias
            })
          } catch {
            /* 诊断回调失败不得影响影子 detector 或旧路径 */
          }
        }
      }
      if (eof || track.cursor.byteOffset === previousOffset) break
    }
    return { eof, acceptedLive }
  }
}
