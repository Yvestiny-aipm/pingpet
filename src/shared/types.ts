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

/** 本地持久化的全部设置 */
export interface Settings {
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

  // ---- v0.2 Agent 监控开关 ----
  // v0.3.3：删除「总开关」。监控能力内置默认开启，靠下面两个子开关决定盯谁；
  // 两个子开关都关 = 不监控（纯陪伴桌宠）。
  /** 是否监控 Codex 会话 */
  codexMonitoringEnabled: boolean
  /** 是否监控 Claude Code 会话 */
  claudeMonitoringEnabled: boolean
  // v0.3.3：每家监控哪些环境（终端 / VS Code / 客户端），可多选；
  // 开关开着但环境空数组 = 该家实际不监控。默认全选三个环境。
  /** Codex 监控的环境集合 */
  codexMonitoringEnvs: AgentEnv[]
  /** Claude Code 监控的环境集合 */
  claudeMonitoringEnvs: AgentEnv[]
  /**
   * @deprecated v0.2.1 起 working 不再弹气泡（只切思考视觉），此开关已无效果。
   * 字段保留仅为兼容旧存盘 / 避免 sanitize 丢字段，UI 已移除。
   */
  agentProgressBubblesEnabled: boolean
  /** 完成时是否播放提示音（v0.2 仅留开关，默认关闭，暂不真正播放） */
  agentCompletionSoundEnabled: boolean
}

/**
 * 宠物状态。
 * v0.1：idle / happy / sleepy / attention。
 * v0.2 新增 thinking（working 时的慢脉冲）、failed（失败时垂头）。
 * done 复用 happy，needs_attention 复用 attention，不新建重复视觉。
 */
export type PetState = 'idle' | 'happy' | 'sleepy' | 'attention' | 'thinking' | 'failed'

/** v0.2：Agent 来源 */
export type AgentSource = 'codex' | 'claude'

/**
 * v0.3.3：Agent 运行环境。会话文件里自报：
 *  - Claude：entrypoint 字段（cli→terminal / claude-vscode→vscode / claude-desktop→desktop）
 *  - Codex ：session_meta 的 source 字段（vscode 等）
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
  sessionKey: string
  kind: AgentEventKind
  message: string
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
  OnHideBubble: 'pet:hide-bubble',
  // v0.2.1：只切宠物状态、不弹气泡（用于 Agent working 时的安静思考视觉）
  OnSetState: 'pet:set-state',
  OnRecheckHover: 'pet:recheck-hover'
} as const

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
  onHideBubble(cb: () => void): () => void
  /** v0.2.1：只切宠物状态、不弹气泡（Agent working 时的思考视觉） */
  onSetState(cb: (payload: PetStatePayload) => void): () => void
  onRecheckHover(cb: (point: WindowPoint) => void): () => void
}
