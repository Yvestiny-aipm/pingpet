import type {
  AgentEnv,
  AgentSource,
  MonitoringEnabledKey,
  MonitoringEnvsKey
} from './types'

/**
 * 四家 Agent 的登记处。
 *
 * 为什么要有这个文件：v0.6 加 Cursor、v0.6.1 加 Grok Bot 时，每加一家都要在 9 个地方
 * 补一笔——Settings 两个字段、默认值、store 的 sanitize 白名单、monitor 的开关判断与
 * 环境过滤表、main 的状态汇总与重启条件、dev 模拟的白名单、气泡文案的名字表、
 * AI 提示词的名字表、设置台的行列表。其中大部分漏掉都不会报错，只是那家静默失效
 * （sanitize 漏一个字段 → 用户的选择存不进去；环境过滤表漏一项 → 事件全被滤掉）。
 * 光是「显示名」就在三个文件里各写了一份一模一样的。
 *
 * 现在这些信息只写在这里一处，其余地方遍历它。新增一家 Agent 只剩三件事，
 * 而且三件都由编译器盯着（漏了编译不过，不再静默失效）：
 *   1. AgentSource 里加一项 → 本文件的 AGENT_SOURCES 会缺 key，编译报错
 *   2. 写 src/main/agent/<新家>.ts 扫描器 → 在 agent/scanners.ts 登记，缺了编译报错
 *   3. 本文件里填它的元信息（名字、可监听环境、默认值）
 */
export interface AgentSourceMeta<S extends AgentSource = AgentSource> {
  source: S
  /**
   * 用户看到的名字。气泡文案、设置台、发给模型的提示词共用这一处，
   * 免得三处各写一份、改名时改漏其中一个。
   */
  label: string
  /**
   * 真正**能被监听到**的环境。注意判断标准不是「这个产品有几个入口」，
   * 而是「哪个入口会在本地留下可读的会话文件」——做不出事件的档位不该出现在设置里，
   * 那是个永远不触发的假开关。
   */
  envs: readonly AgentEnv[]
  /** 默认监控哪些环境（通常等于 envs 全选） */
  defaultEnvs: readonly AgentEnv[]
  /** 默认是否开启监控 */
  defaultEnabled: boolean
  /**
   * envs 不是三档全都支持时，设置台会把缺的档位置灰，并显示这句原因。
   * 一定要写清「为什么监听不到」，否则用户只会以为是坏了。
   */
  envLimitReason?: string
  /** 它在 Settings 里的开关字段名（由 source 派生，不用手写） */
  enabledKey: MonitoringEnabledKey<S>
  /** 它在 Settings 里的环境字段名 */
  envsKey: MonitoringEnvsKey<S>
}

const ALL_ENVS: readonly AgentEnv[] = ['terminal', 'vscode', 'desktop']

/**
 * 键必须覆盖 AgentSource 的每一项：AgentSource 里加了新家而这里没补，直接编译不过。
 * 这就是「漏改从静默失效变成编译错误」的那道闸。
 */
export const AGENT_SOURCES: { [S in AgentSource]: AgentSourceMeta<S> } = {
  codex: {
    source: 'codex',
    label: 'Codex',
    envs: ALL_ENVS,
    defaultEnvs: ALL_ENVS,
    defaultEnabled: true,
    enabledKey: 'codexMonitoringEnabled',
    envsKey: 'codexMonitoringEnvs'
  },
  claude: {
    source: 'claude',
    label: 'Claude Code',
    envs: ALL_ENVS,
    defaultEnvs: ALL_ENVS,
    defaultEnabled: true,
    enabledKey: 'claudeMonitoringEnabled',
    envsKey: 'claudeMonitoringEnvs'
  },
  cursor: {
    source: 'cursor',
    label: 'Cursor',
    // 没有 vscode 档：Cursor 官方不出 VS Code 扩展（它自己就是 VS Code 的 fork），
    // 在 VS Code 里用 Cursor 只能走 ACP（agent acp）。实测 ACP 会话只建 project 目录、
    // 写 worker.log / repo.json，完全不写 agent-transcripts JSONL，监听拿不到任何事件。
    envs: ['terminal', 'desktop'],
    defaultEnvs: ['terminal', 'desktop'],
    defaultEnabled: true,
    envLimitReason:
      'Cursor 没有官方 VS Code 插件（它本身就是 VS Code 的分支）。在 VS Code 里用 Cursor 只能走 ACP，而 ACP 会话不会写本地会话文件，无法监听。',
    enabledKey: 'cursorMonitoringEnabled',
    envsKey: 'cursorMonitoringEnvs'
  },
  grok: {
    source: 'grok',
    label: 'Grok Bot',
    // 只有客户端：官方仅 macOS / Windows 桌面端 + iOS App，无 CLI 无 IDE 插件。
    // iOS 上派的活会同步到桌面端的同一份本地文件，所以开着客户端就一并覆盖了。
    envs: ['desktop'],
    defaultEnvs: ['desktop'],
    defaultEnabled: true,
    envLimitReason:
      'Grok Bot 官方只有 macOS / Windows 客户端和 iOS App，没有命令行工具也没有 IDE 插件。手机上派的活会同步到客户端，所以开着客户端就一并覆盖了。',
    enabledKey: 'grokMonitoringEnabled',
    envsKey: 'grokMonitoringEnvs'
  }
}

/** 便于遍历的数组形式。顺序就是设置台里的显示顺序 */
export const AGENT_SOURCE_LIST: readonly AgentSourceMeta[] = Object.values(AGENT_SOURCES)

/** 全部来源标识，用于校验来自 IPC 的不可信入参 */
export const AGENT_SOURCE_IDS: readonly AgentSource[] = AGENT_SOURCE_LIST.map((m) => m.source)
