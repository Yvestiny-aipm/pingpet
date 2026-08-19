import type { AgentMonitorEvent, AgentSource } from '@shared/types'
import { scanClaude } from './claude'
import { scanCodex } from './codex'
import { scanCursor } from './cursor'
import { scanGrok } from './grok'

/**
 * 扫描一轮，返回本轮扫到的归一化事件（未去重、未过滤新鲜度，这些由 monitor 统一做）。
 * 约定：任何 IO / 解析异常都在各家扫描器内部吞掉，绝不抛给 monitor。
 */
export type ScanFn = (nowMs: number) => AgentMonitorEvent[]

/**
 * 来源 → 扫描器。这里放在 main 侧而不是 shared 的 AGENT_SOURCES 里，
 * 是因为扫描器要读本地文件系统，渲染进程不能碰。
 *
 * Record<AgentSource, ...> 是刻意的：AgentSource 里加了新家却忘了写扫描器，编译就过不去。
 */
export const AGENT_SCANNERS: Record<AgentSource, ScanFn> = {
  codex: scanCodex,
  claude: scanClaude,
  cursor: scanCursor,
  grok: scanGrok
}
