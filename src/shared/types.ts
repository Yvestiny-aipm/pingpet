/** 屏幕上的宠物窗口位置（左上角坐标，单位：pt） */
export interface PetPosition {
  x: number
  y: number
}

/** 气泡相对宠物中心的位置：极坐标（角度 + 距离） */
export interface BubbleAnchor {
  /** 角度（度）：0=正右，90=正下，180=正左，270=正上（屏幕坐标系，y 向下） */
  angleDeg: number
  /** 气泡中心到宠物中心的距离（px），受 min/max 约束 */
  distance: number
}

/**
 * 每家 Agent 在 Settings 里对应的两个字段名，由 AgentSource 自动派生。
 *
 * v0.2 起这两组字段是手写的（codexMonitoringEnabled、claudeMonitoringEnvs…），
 * 结果每加一家 Agent 都要在 8 个地方补字段，漏一个不会报错、只是那家静默失效。
 * 改成映射类型后，AgentSource 里加一项，缺的字段会直接编译不过。
 */
export type MonitoringEnabledKey<S extends AgentSource = AgentSource> = `${S}MonitoringEnabled`
export type MonitoringEnvsKey<S extends AgentSource = AgentSource> = `${S}MonitoringEnvs`

/**
 * Agent 监控相关的设置字段。
 *
 * enabled：是否监控这家。
 * envs   ：监控它的哪些环境（终端 / VS Code / 客户端），可多选。
 *          开关开着但环境是空数组 = 该家实际不监控（等于关）。
 *          每家真正可选的环境见 AGENT_SOURCES 里的 envs——不是「产品有几个入口」，
 *          而是「哪些入口会在本地留下可读的会话文件」。
 *
 * v0.3.3 起没有总开关：全部关掉 = 不监控（纯陪伴桌宠）。
 */
export type AgentMonitoringSettings = {
  [S in AgentSource as MonitoringEnabledKey<S>]: boolean
} & {
  [S in AgentSource as MonitoringEnvsKey<S>]: AgentEnv[]
}

/** 本地持久化的全部设置 */
export interface Settings extends AgentMonitoringSettings {
  selectedPetId: string
  petScale: number
  bubblesEnabled: boolean
  bubbleFrequencySeconds: number
  petPosition: PetPosition | null
  petVisible: boolean
  /** 用户自定义的气泡相对位置（全局一个，点击气泡拖动后记住） */
  bubbleAnchor: BubbleAnchor
  /**
   * v0.3.1：单图导入时自动去掉纯色背景（四角采样 + flood fill 抠图）。
   * 只对「四角是纯色」的图生效；复杂背景会自动跳过不硬抠。默认开。
   */
  autoRemoveBackground: boolean

  /**
   * @deprecated v0.2.1 起 working 不再弹气泡（只切思考视觉），此开关已无效果。
   * 字段保留仅为兼容旧存盘 / 避免 sanitize 丢字段，UI 已移除。
   */
  agentProgressBubblesEnabled: boolean
  /** 完成时是否播放提示音（v0.2 仅留开关，默认关闭，暂不真正播放） */
  agentCompletionSoundEnabled: boolean
  /**
   * Codex candidate 静默桌宠姿态。默认关：用户行为与未接入前一致。
   * 打开后只改 Codex 姿态，不接气泡、声音、shouldNotify；其他 Agent 不受影响。
   */
  codexCandidateVisualEnabled: boolean
  /**
   * Codex candidate 部分失败气泡。默认关：与视觉开关独立，不改用户现有配置。
   * 打开后只允许 completed_with_partial_failure 弹一条中性提醒；不接声音、成功提示、shouldNotify。
   */
  codexCandidateBubbleEnabled: boolean
  /**
   * Codex candidate 部分失败提醒音。默认关：与视觉/气泡开关独立，不改用户现有配置。
   * 打开后也只允许「部分失败气泡已真正发出」时进入判定；不复用完成音，shouldNotify 仍为 false。
   */
  codexCandidateSoundEnabled: boolean

  // ---- v0.5 AI 总结（BYOK：用户自己的 Key，可选联网功能，默认关） ----
  /**
   * 任务停下时用大模型读会话末尾、生成一句人话总结拼进气泡。
   * 开启 = 会话末尾少量文本会发给用户配置的模型服务；关闭 = 该功能完全不联网。
   */
  aiSummaryEnabled: boolean
  /** 用哪家模型服务生成总结 */
  aiProvider: AiProvider
  /** Anthropic (Claude) 的 API Key，只存本机 */
  aiAnthropicApiKey: string
  /** Anthropic 模型 ID */
  aiAnthropicModel: string
  /** OpenAI 兼容接口的 Base URL（也可填 DeepSeek / Ollama 等兼容服务） */
  aiOpenaiBaseUrl: string
  /** OpenAI 兼容接口的 API Key，只存本机 */
  aiOpenaiApiKey: string
  /** OpenAI 兼容接口的模型 ID */
  aiOpenaiModel: string

  // ---- v0.6.2 新版本提醒 ----
  /**
   * 是否定期查一下 GitHub 上有没有新版本。
   * 只取一个版本号，不上传任何用户信息；关掉则完全不发起这个请求。
   */
  updateCheckEnabled: boolean
}

/** v0.5：AI 总结的模型服务。openai = 任意 OpenAI 兼容接口（含 DeepSeek/Ollama 等） */
export type AiProvider = 'anthropic' | 'openai'

/** v0.5：设置台「测试连接」的结果 */
export type AiTestResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * 宠物状态。
 * v0.1：idle / happy / sleepy / attention。
 * v0.2 新增 thinking（working 时的慢脉冲）、failed（失败时垂头）。
 * done 复用 happy，needs_attention 复用 attention，不新建重复视觉。
 */
export type PetState = 'idle' | 'happy' | 'sleepy' | 'attention' | 'thinking' | 'failed'

/** v0.2：Agent 来源。v0.6 新增 cursor，v0.6.1 新增 grok（Grok Bot 客户端） */
export type AgentSource = 'codex' | 'claude' | 'cursor' | 'grok'

/**
 * v0.3.3：Agent 运行环境。会话文件里自报：
 *  - Claude：entrypoint 字段（cli→terminal / claude-vscode→vscode / claude-desktop→desktop）
 *  - Codex ：session_meta 的 source 字段（vscode 等）
 *  - Cursor：会话文件里没有任何环境字段，靠 project 目录的边车文件反推（见 agent/cursor.ts）
 * 读不出来的会话归入 'terminal'（默认档，不静默漏报）。
 */
export type AgentEnv = 'terminal' | 'vscode' | 'desktop'

/** v0.3.3：三个环境的固定顺序 + 展示名（渲染层复用） */
export const AGENT_ENVS: readonly AgentEnv[] = ['terminal', 'vscode', 'desktop'] as const

/** v0.2：Agent 会话状态四分类 */
export type AgentEventKind = 'working' | 'done' | 'needs_attention' | 'failed'

/**
 * v0.2.1：Agent「停下来」的细分原因。
 * 只有终态（done / needs_attention / failed）才带 reason，working 不带。
 * 用于在气泡里说清「为什么停了」。粗分策略：授权/提问/验证统一归到 needs_* 系列。
 * - completed        正常输出结束（任务完成）
 * - needs_input      需要你处理（授权 / 抛问题让你选 / 需要你帮忙验证，统称）
 * - error            出错导致停止
 * - interrupted      被中断 / 中止导致停止
 */
export type AgentStopReason = 'completed' | 'needs_input' | 'error' | 'interrupted'

/** v0.2：归一化后的 Agent 事件 */
export interface AgentMonitorEvent {
  id: string
  source: AgentSource
  /** v0.3.3：会话来自哪个环境（终端 / VS Code / 客户端），用于按环境过滤 */
  env: AgentEnv
  /**
   * 旧路径 session 级关联键。可用于 session 级对照。
   * 不是 threadId / turnId；不得从文件名、sessionKey 或时间戳猜造后两者。
   * 旧路径缺失 threadId / turnId 时保留 unknown。
   */
  sessionKey: string
  kind: AgentEventKind
  message: string
  /**
   * 旧路径事件自身时间（日志/文件时间）。对照时对应 eventTime，不是 PingPet observedAt。
   */
  timestampMs: number
  rawPath?: string
  /** v0.2.1：终态的细分停止原因，working 事件为 undefined */
  reason?: AgentStopReason
  /** v0.2.1：从会话里摘出的原因细节（如报错首句），拼进气泡让用户看到「因为什么停的」 */
  detail?: string
}

/** v0.2：Agent 监控运行状态（推给渲染层做诊断展示） */
export interface AgentMonitorStatus {
  enabled: boolean
  lastEvent: AgentMonitorEvent | null
  activeSessions: Array<{
    source: AgentSource
    sessionKey: string
    lastSeenAt: number
  }>
  lastCheckedAt: number | null
  error: string | null
}

/** v0.3：宠物来源。official=随 App 打包发布，imported=用户本地导入的皮肤包 */
export type PetSource = 'official' | 'imported'

/**
 * 宠物渲染类型。
 * - svg：v0.1 的内置 React SVG 组件（团子/布丁/墨墨）
 * - image-pack：v0.3 皮肤包，用 <img> 渲染各状态对应的图片素材
 * - spritesheet：v0.4 兼容 PetDex / Codex 宠物格式，一张精灵图切帧逐帧动画
 */
export type PetKind = 'svg' | 'image-pack' | 'spritesheet'

/**
 * v0.4：spritesheet 宠物的帧规格 + 状态→行映射（兼容 PetDex / Codex 宠物格式）。
 * 一张精灵图排成网格，每行是一个动作的连续帧；播放时切换同一行的多帧即成动画。
 */
export interface SpriteSheetSpec {
  /** 精灵图的 file:// URL */
  url: string
  /** 单帧像素宽高 */
  frameWidth: number
  frameHeight: number
  /** 每行帧数（列数） */
  columns: number
  /** 我们的 PetState → 精灵图行号 + 该行帧数 + 每帧时长(ms) */
  states: Partial<Record<PetState, { row: number; frames: number; durationMs: number }>>
}

/**
 * 宠物元数据。
 * v0.1 只有 `kind:'svg'` 的内置宠物；v0.3 起兼容 `kind:'image-pack'` 皮肤包。
 * 对 image-pack：`thumbnailUrl`/`states` 里存的是主进程用 pathToFileURL 生成的 file:// URL，
 * 不是裸文件路径（渲染进程不得接触真实路径）。states 至少含 idle，其余可缺、按规则 fallback。
 */
export interface PetDefinition {
  id: string
  name: string
  kind: PetKind
  /** v0.1 内置宠物默认视为 official；v0.3 起显式区分 official / imported */
  source: PetSource
  accentColor: string
  description: string
  /** image-pack 的缩略图 file:// URL（svg 内置宠物为 undefined，用组件自渲染） */
  thumbnailUrl?: string
  /** image-pack 各状态素材的 file:// URL 映射（svg 内置宠物为 undefined） */
  states?: Partial<Record<PetState, string>>
  /** v0.4：spritesheet 宠物的帧规格（仅 kind==='spritesheet' 时存在） */
  sprite?: SpriteSheetSpec
}

/** v0.3：导入皮肤包的结果。canceled=用户主动取消（UI 不显示红色错误） */
export type ImportPetPackResult =
  | { ok: true; snapshot: Snapshot; petId: string }
  | { ok: false; error: string; canceled?: boolean }

/**
 * v0.3.1：单图导入第一步「选图」的结果。
 * 只负责把用户选的图读成 dataUrl 交回渲染进程（在那抠图），不落盘。
 */
export type PickPetImageResult =
  | { ok: true; dataUrl: string; ext: string; name: string }
  | { ok: false; error: string; canceled?: boolean }

/**
 * v0.3.3：合并后的「导入皮肤」入口结果。一个对话框同时接受图片或皮肤包文件夹。
 *  - kind:'image'：选了图片 → 交渲染进程（可选抠背景）再 savePetImage
 *  - kind:'pack' ：选了皮肤包文件夹 → 已在 main 侧导入完成，附带新快照
 *  - kind:'canceled' / kind:'error'
 */
export type PickSkinResult =
  | { kind: 'image'; dataUrl: string; ext: string; name: string }
  | { kind: 'pack'; snapshot: Snapshot; petId: string }
  | { kind: 'petdex'; snapshot: Snapshot; slug: string; name: string }
  | { kind: 'canceled' }
  | { kind: 'error'; error: string }

/**
 * v0.4：在线形象库（PetDex）。这是唯一联网的功能，用户主动触发；核心监控始终纯本地。
 */
export interface PetdexListItem {
  slug: string
  displayName: string
  kind: string // 'creature' | 'character' | …
  author: string
  spritesheetUrl: string // 预览图（一张 8×9 精灵图，渲染层截首帧当缩略图）
  zipUrl: string
}

export type PetdexListResult =
  | { ok: true; total: number; pets: PetdexListItem[] }
  | { ok: false; error: string }

/** 一键安装 PetDex 宠物的结果；成功后附最新快照供 UI 刷新 */
export type PetdexInstallResult =
  | { ok: true; slug: string; name: string }
  | { ok: false; error: string }

/** 主进程推给渲染进程的完整快照 */
export interface Snapshot {
  settings: Settings
  pets: PetDefinition[]
  appVersion: string
  /** v0.2：Agent 监控运行状态 */
  agent: AgentMonitorStatus
  /** 是否为打包环境（渲染层据此决定是否显示 dev 模拟按钮） */
  isPackaged: boolean
}

/** 屏幕/窗口矩形（屏幕绝对坐标，px） */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** 气泡消息载荷 */
export interface BubblePayload {
  text: string
  state: PetState
  durationMs: number
  /** 展示时窗口在屏幕上的矩形，供渲染进程做气泡越界收拢 */
  windowRect: ScreenRect
  /** 窗口所在显示器的可视范围（bounds），气泡不得越过 */
  displayBounds: ScreenRect
  /** v0.3.3：是否随气泡播放一声完成提示音（仅 Agent 完成事件且用户开了提示音时为 true） */
  sound?: boolean
  /**
   * v0.3.3：是否用户手动触发的互动气泡（点击桌宠）。
   * 这类气泡不该被后台 Agent 的 working「思考态」清掉——否则一边跑 Agent
   * 一边点桌宠时，气泡会被每秒轮询的 working 事件秒杀，没法拖动调位置。
   */
  interactive?: boolean
}

/** 拖拽时上报的指针屏幕坐标 */
export interface DragPoint {
  screenX: number
  screenY: number
}

/** 窗口内坐标，用于主进程要求宠物页重新判断 hover 命中 */
export interface WindowPoint {
  x: number
  y: number
}

/** IPC 通道名统一定义，main / preload 共用 */
export const IPC = {
  GetSnapshot: 'pet:get-snapshot',
  UpdateSettings: 'pet:update-settings',
  SelectPet: 'pet:select-pet',
  ResetPetPosition: 'pet:reset-position',
  ShowPet: 'pet:show',
  HidePet: 'pet:hide',
  QuitApp: 'pet:quit',
  PetClicked: 'pet:clicked',
  DragStart: 'pet:drag-start',
  DragMove: 'pet:drag-move',
  DragStop: 'pet:drag-stop',
  SetInteractive: 'pet:set-interactive',
  // v0.2：dev 模拟 Agent 事件（走真实事件同一处理链路）
  AgentSimulate: 'pet:agent-simulate',
  // v0.5：测试 AI 总结配置（用当前设置发一次真实请求，验证 Key/模型可用）
  TestAiSummary: 'pet:test-ai-summary',
  // v0.3.3：合并后的「导入皮肤」——一个入口同时接受图片 / 皮肤包文件夹
  PickSkin: 'pet:pick-skin',
  // v0.4：在线形象库（PetDex）——拉列表 + 一键安装
  FetchPetdexList: 'pet:petdex-list',
  InstallPetdexPet: 'pet:petdex-install',
  // v0.3：皮肤包导入 / 删除 / 打开导入目录
  ImportPetPack: 'pet:import-pack',
  // v0.3.1：单图导入两段式（渲染进程中间抠图）——先选图拿数据，再存抠好的图
  PickPetImage: 'pet:pick-image',
  SavePetImage: 'pet:save-image',
  DeleteImportedPetPack: 'pet:delete-pack',
  // v0.3.3：重命名一个已导入皮肤包的显示名
  RenameImportedPetPack: 'pet:rename-pack',
  RevealPetPacksFolder: 'pet:reveal-packs-folder',
  OnSnapshot: 'pet:snapshot',
  OnShowBubble: 'pet:show-bubble',
  OnPlayCodexAttentionSound: 'pet:play-codex-attention-sound',
  OnHideBubble: 'pet:hide-bubble',
  // v0.2.1：只切宠物状态、不弹气泡（用于 Agent working 时的安静思考视觉）
  OnSetState: 'pet:set-state',
  OnRecheckHover: 'pet:recheck-hover'
} as const

/** Codex 部分失败独立 attention 音。不得走 playDing / 完成音。 */
export interface CodexAttentionSoundPayload {
  sound: true
  soundType: 'attention'
  shouldNotify: false
  dataUrl: string
}

/** v0.2.1：只切宠物状态的载荷（不带气泡） */
export interface PetStatePayload {
  state: PetState
  durationMs: number
}

/** preload 暴露给渲染进程的安全 API（挂在 window.petApi 上） */
export interface PetApi {
  getSnapshot(): Promise<Snapshot>
  updateSettings(partial: Partial<Settings>): Promise<Snapshot>
  selectPet(petId: string): Promise<Snapshot>
  resetPetPosition(): Promise<void>
  showPet(): Promise<void>
  hidePet(): Promise<void>
  quitApp(): Promise<void>
  petClicked(): void
  petDragStart(point: DragPoint): void
  petDragMove(point: DragPoint): void
  petDragStop(): void
  setInteractive(interactive: boolean): void
  /** v0.2 dev-only：模拟一条 Agent 事件，走和真实事件相同的处理链路 */
  agentSimulate(source: AgentSource, kind: AgentEventKind): void
  /** v0.5：用当前 AI 设置发一次真实请求验证 Key/模型（设置台「测试」按钮） */
  testAiSummary(): Promise<AiTestResult>
  /** v0.3.3：合并入口——一个对话框选图片或皮肤包文件夹，按类型自动分流 */
  pickSkin(): Promise<PickSkinResult>
  /** v0.4：拉取在线形象库（PetDex）全量列表；联网、用户主动触发 */
  fetchPetdexList(): Promise<PetdexListResult>
  /** v0.4：从在线库一键下载安装某只宠物；返回结果 + 新快照 */
  installPetdexPet(
    zipUrl: string,
    displayName: string
  ): Promise<{ result: PetdexInstallResult; snapshot: Snapshot }>
  /** v0.3：弹目录选择框导入皮肤包文件夹；取消返回 { ok:false, canceled:true } */
  importPetPack(): Promise<ImportPetPackResult>
  /** v0.3.1：单图导入第一步——弹框选图，返回 dataUrl 给渲染进程抠图；不落盘 */
  pickPetImage(): Promise<PickPetImageResult>
  /** v0.3.1：单图导入第二步——把（可能已抠好背景的）图 dataUrl 存成皮肤包 */
  savePetImage(dataUrl: string, name: string): Promise<ImportPetPackResult>
  /** v0.3：删除一个已导入的皮肤包（只允许 source==='imported'），返回新快照 */
  deleteImportedPetPack(petId: string): Promise<Snapshot>
  /** v0.3.3：重命名一个已导入皮肤包的显示名，返回新快照 */
  renameImportedPetPack(petId: string, name: string): Promise<Snapshot>
  /** v0.3：在 Finder 里打开用户导入皮肤包目录 */
  revealPetPacksFolder(): Promise<void>
  onSnapshot(cb: (snapshot: Snapshot) => void): () => void
  onShowBubble(cb: (bubble: BubblePayload) => void): () => void
  onPlayCodexAttentionSound(cb: (payload: CodexAttentionSoundPayload) => void): () => void
  onHideBubble(cb: () => void): () => void
  /** v0.2.1：只切宠物状态、不弹气泡（Agent working 时的思考视觉） */
  onSetState(cb: (payload: PetStatePayload) => void): () => void
  onRecheckHover(cb: (point: WindowPoint) => void): () => void
}

// ---------------------------------------------------------------------------
// Codex 观察事件（阶段 1：只记录原始信号，不接入 Monitor / 桌宠）
// ---------------------------------------------------------------------------

/**
 * 信号来源。阶段 1 只区分两类已确认能读到的 Codex 输出：
 * - exec_json：`codex exec --json` 的顶层点号事件
 * - session_jsonl：`~/.codex/sessions` 本地会话行
 *
 * App Server 的 JSON-RPC 外层尚未确认，不能当成已支持；见到 jsonrpc 信封记 unsupported。
 */
export type CodexObservationSource = 'exec_json' | 'session_jsonl'

/** 解析器对这一行的识别结果。unknown/unsupported/malformed/partial 都不得当成成功。 */
export type CodexParserRecognition = 'recognized' | 'unknown' | 'unsupported' | 'malformed' | 'partial'

/**
 * 归一化后的事件名。
 * 点号官方顶层事件只表示 `codex exec --json`。
 * `event_msg.*` / `session_meta` 等只表示本地 session JSONL，即使名字看起来像官方事件也不得混用。
 * `turn.cancelled` 与本地 `event_msg.turn_aborted` 是两类原始事件，不得合并。
 */
export type CodexNormalizedEventType =
  | 'thread.started'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'item.started'
  | 'item.updated'
  | 'item.completed'
  | 'error'
  | 'session_meta'
  | 'event_msg.task_started'
  | 'event_msg.task_complete'
  | 'event_msg.turn_aborted'
  | 'event_msg.item_started'
  | 'event_msg.item_updated'
  | 'event_msg.item_completed'
  | 'event_msg.other'
  | 'response_item'
  | 'turn_context'
  | 'token_usage_record'
  | 'world_state'
  | 'compacted'
  | 'unknown'
  | 'unsupported'
  | 'malformed'
  | 'partial_line'

/** 这条观察记录的证据从哪来。比 source 更细，半行/坏行单独记账。 */
export type CodexEvidenceOrigin =
  | 'codex_exec_json'
  | 'codex_session_jsonl'
  | 'jsonl_malformed'
  | 'jsonl_partial'

/**
 * Codex 统一观察事件。只描述「看到了什么」，不描述桌宠该做什么。
 * 未接入 AgentMonitor；缺字段保持可选，不得补造官方协议里不存在的 id。
 */
export interface CodexObservationEvent {
  source: CodexObservationSource
  eventType: CodexNormalizedEventType
  /**
   * 明确的 session_id（payload 优先）。
   * 文件名只作 fallback；此时 parseNote 会标明，sourcePath 仍指向原文件。
   */
  sessionId?: string
  /** 读到该行时的文件路径或 fixture 名，不是 session id */
  sourcePath?: string
  /**
   * 官方 thread.started.thread_id，或本地 payload.thread_id。
   * 只有原始事件确实提供时才记录；不得从文件名、sessionKey 或时间戳猜造。
   */
  threadId?: string
  /**
   * 官方 turn 事件通常无此字段；本地 event_msg.task_* 常带 turn_id。
   * 只有原始事件确实提供时才记录；缺失保持 unknown / undefined，不得猜造。
   */
  turnId?: string
  itemId?: string
  /**
   * 原始 Codex 事件自身携带的时间（毫秒）。
   * 解析自 timestamp / ts / started_at 等；缺则 undefined，不得用 observedAt 填入。
   */
  eventTime?: number
  /**
   * PingPet 读取和处理该事件的时间（毫秒）。
   * 不得写成 eventTime。
   */
  observedAt: number
  /** 原始 payload 的安全摘要（截断大字段），不是完整原文 */
  payload: unknown
  /** 解析器是否把该行识别成已知事件家族 */
  recognized: boolean
  recognition: CodexParserRecognition
  evidenceOrigin: CodexEvidenceOrigin
  /** 稳定去重键；同一条事件重放必须得到同一值 */
  dedupKey: string
  /** 原始 type 字符串（event_msg 则记 payload.type） */
  rawType?: string
  itemKind?: string
  itemStatus?: string
  /** 本地 session 行上的 ordinal，适合做去重辅助 */
  ordinal?: number
  parseNote?: string
}

/**
 * 官方 `codex exec --json` 顶层 type。
 * 列入此表只表示解析器/检测器已准备识别，不等于真实协议已验证。
 * `turn.cancelled` 尚未被真实 exec 样本覆盖。
 */
export const CODEX_STRUCTURED_EVENT_TYPES = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.updated',
  'item.completed',
  'error'
] as const

export type CodexStructuredEventType = (typeof CODEX_STRUCTURED_EVENT_TYPES)[number]

// ---------------------------------------------------------------------------
// Codex 派生状态（阶段 2：只判断和记录，不接入 Monitor / 桌宠）
// ---------------------------------------------------------------------------

/**
 * 生命周期。succeeded 留在模型里是为了以后任务语义验收，阶段 2 检测器不得产出它。
 * completed_signal ≠ succeeded。
 *
 * incomplete 是观察终态（见方案 §5.1）：整轮没有终态且输出/观察已无法完整确认。
 * 单个 item/tool 失败且 turn 仍在进行时，生命周期保持 running，不得进入 incomplete。
 */
export type CodexLifecycleState =
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'completed_signal'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'incomplete'
  | 'unknown'

/** 观察终态。incomplete 在此集合内；running / waiting / unknown 不是终态。 */
export const CODEX_LIFECYCLE_TERMINALS: readonly CodexLifecycleState[] = [
  'completed_signal',
  'succeeded',
  'cancelled',
  'failed',
  'incomplete'
]

export type CodexCause =
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'user_cancelled'
  | 'network_error'
  | 'stream_disconnected'
  | 'rate_limited'
  | 'usage_limit'
  | 'session_budget_exceeded'
  | 'auth_failed'
  | 'permission_denied'
  | 'sandbox_denied'
  | 'tool_failed'
  | 'turn_failed'
  | 'context_window_exceeded'
  | 'timeout'
  | 'process_exit'
  | 'output_truncated'
  | 'monitor_disconnected'
  | 'unknown'

export type CodexProcessDimension = 'not_observed' | 'alive' | 'exited' | 'unknown'
export type CodexConnectionDimension = 'connected' | 'stale' | 'disconnected' | 'unknown'
export type CodexSessionDimension = 'not_loaded' | 'idle' | 'active' | 'system_error' | 'unknown'
export type CodexTurnDimension =
  | 'not_started'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'unknown'
export type CodexItemDimension =
  | 'none'
  | 'running'
  | 'succeeded'
  | 'partial_failure'
  | 'failed'
  | 'declined'
  | 'unknown'
export type CodexOutputIntegrity = 'complete' | 'partial' | 'none' | 'unknown'
/** 阶段 2 固定 not_verified，不做任务是否真正完成的判断。 */
export type CodexTaskSemantics =
  | 'completed'
  | 'partially_completed'
  | 'blocked'
  | 'cancelled'
  | 'not_verified'
  | 'unknown'
/**
 * 是否允许自动重试。
 * `never` 只表示产品明确禁止自动重试，不是“任务已完成所以不必重试”。
 * `turn.completed` / `taskSemantics=not_verified` 时用 `unknown`，不得写成 `never`。
 */
export type CodexRetryability = 'never' | 'safe_retry' | 'backoff' | 'user_action' | 'reauth' | 'unknown'
/**
 * 对结构化事件/状态迁移是否成立的置信度。
 * 不是“任务已经成功完成”的置信度。confidence=high 不得被上层当成 succeeded。
 */
export type CodexConfidence = 'high' | 'medium' | 'low'

export interface CodexStateEvidence {
  id: string
  eventDedupKey: string
  source: CodexObservationSource
  rawType?: string
  evidenceOrigin: CodexEvidenceOrigin
  eventType: CodexNormalizedEventType
  observedAt: number
  note?: string
}

export interface CodexStateConflict {
  observedAt: number
  keptLifecycle: CodexLifecycleState
  ignoredEventType: CodexNormalizedEventType
  ignoredSource: CodexObservationSource
  reason: string
}

/** 多维派生状态。不得压成单个 enum。 */
export interface CodexDerivedState {
  lifecycle: CodexLifecycleState
  cause: CodexCause
  process: CodexProcessDimension
  connection: CodexConnectionDimension
  session: CodexSessionDimension
  turn: CodexTurnDimension
  item: CodexItemDimension
  outputIntegrity: CodexOutputIntegrity
  taskSemantics: CodexTaskSemantics
  retryability: CodexRetryability
  confidence: CodexConfidence
  evidence: CodexStateEvidence[]
  conflicts: CodexStateConflict[]
  /**
   * 检测器最近一次应用事件的时间（PingPet）。
   * 不是原始 Codex eventTime。
   */
  observedAt: number
  sessionId?: string
  /** 只有原始事件提供时才有；缺失不得猜造 */
  threadId?: string
  /** 只有原始事件提供时才有；缺失不得猜造 */
  turnId?: string
}

export interface CodexStateMigration {
  previousState: CodexDerivedState
  nextState: CodexDerivedState
  cause: CodexCause
  evidenceIds: string[]
  source: CodexObservationSource | 'observer' | 'process'
  /**
   * 检测器应用该事件的时间（PingPet）。
   * 不是原始 Codex 事件时间。
   */
  observedAt: number
  /**
   * 原始 Codex 事件自身携带的时间。
   * 未知则为 null，不得用 observedAt 或时间戳猜造。
   */
  eventTime?: number | null
  confidence: CodexConfidence
  reason: string
  eventDedupKey?: string
}
