import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  selectedPetId: 'dango',
  petScale: 1,
  bubblesEnabled: true,
  bubbleFrequencySeconds: 180,
  petPosition: null,
  petVisible: true,
  bubbleAnchor: { angleDeg: 270, distance: 110 },
  // v0.3.1：单图导入默认自动去纯色背景
  autoRemoveBackground: true,
  // v0.2 Agent 监控：子开关默认开启，提示音默认关闭
  codexMonitoringEnabled: true,
  claudeMonitoringEnabled: true,
  // v0.6：Cursor 同样默认开启
  cursorMonitoringEnabled: true,
  // v0.6.1：Grok Bot 同样默认开启
  grokMonitoringEnabled: true,
  // v0.3.3：默认监控全部三个环境
  codexMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
  claudeMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
  // v0.6：Cursor 只有终端 / 客户端两档可监听（ACP 不落盘）
  cursorMonitoringEnvs: ['terminal', 'desktop'],
  // v0.6.1：Grok Bot 只有客户端一档（无 CLI / 无 IDE 插件）
  grokMonitoringEnvs: ['desktop'],
  agentProgressBubblesEnabled: true,
  agentCompletionSoundEnabled: false,
  // v0.5 AI 总结：默认关（保持「默认不联网」），Key 留空由用户自己填
  aiSummaryEnabled: false,
  aiProvider: 'anthropic',
  aiAnthropicApiKey: '',
  aiAnthropicModel: 'claude-opus-4-8',
  aiOpenaiBaseUrl: 'https://api.openai.com/v1',
  aiOpenaiApiKey: '',
  aiOpenaiModel: '',
  // v0.6.2：默认开。它和「默认不联网」的原则不冲突——只取一个版本号，不上传任何用户数据；
  // 关掉更新检查的代价是用户永远停在装机那版，收不到修复。
  updateCheckEnabled: true
}

// ---------- v0.6.2 新版本提醒常量 ----------

/** 启动后延迟这么久再查更新：别和冷启动抢资源，也别让用户开机就被弹窗打扰 */
export const UPDATE_CHECK_STARTUP_DELAY_MS = 20_000
/** 之后每隔这么久查一次（常驻应用可能好几天不重启） */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3600_000
/** 发现新版本时气泡展示时长：比普通气泡长一些，用户要有时间点它 */
export const UPDATE_BUBBLE_MS = 12_000

// ---------- v0.5 AI 总结常量 ----------

/** 单次总结请求的超时（毫秒）。超时/失败一律回落规则文案，不影响气泡 */
export const AI_SUMMARY_TIMEOUT_MS = 12_000
/** 发给模型的会话末尾文本上限（字符）。只取末尾这一小段，控制隐私面和成本 */
export const AI_TRANSCRIPT_MAX_CHARS = 6_000
/** 总结回复的输出 token 上限（一句话足够） */
export const AI_SUMMARY_MAX_TOKENS = 300
/** 带 AI 总结的终态气泡展示时长（比纯规则文案略长，两行要多读一会儿） */
export const AGENT_AI_BUBBLE_MS = 9_000

// ---------- v0.2 Agent 监控常量 ----------

/**
 * 轮询周期（毫秒）。v0.3.3：5s → 1s，追求「任务停下来」的即时反馈——
 * 3s 下常出现「提醒姗姗来迟、已经派了下一个任务才弹上一个完成」的马后炮。
 * 派生常量 AGENT_THINKING_STATE_MS 自动跟随（= 本值 + 3000 = 4000），仍远大于
 * 一个轮询周期，持续干活时每轮都被续期、保持思考态，停下后 4s 回落 idle。
 */
export const AGENT_POLL_INTERVAL_MS = 1_000
/**
 * 每类来源单次最多扫描的文件数（取最近修改的）。
 * v0.3.3：6 → 12。终端 / VS Code / 桌面客户端跑的会话都汇进同一目录树
 * （Claude → ~/.claude/projects，Codex → ~/.codex/sessions），三环境并发时
 * 活跃会话更多，放宽上限避免漏掉某个环境正在跑的会话。
 */
export const AGENT_MAX_FILES_PER_SOURCE = 12
/** 每个文件只读 tail 的字节数 */
export const AGENT_TAIL_BYTES = 96_000
/** 只处理最近这段时间内的事件（毫秒），避免读到老日志 */
export const AGENT_EVENT_FRESH_MS = 120_000
/**
 * 会话文件的新鲜度上限（毫秒）：mtime 早于这个时间的文件直接跳过，连打开都不打开。
 *
 * 依据：一个文件若这么久没被写过，它里面不可能有落在 AGENT_EVENT_FRESH_MS 窗口内的新事件，
 * 生成出来也会被 monitor 原样丢弃。不加这道闸时，重度用户目录下每秒都要把十几个历史会话
 * 各读 96KB 尾部、逐行 JSON.parse、产出上百个事件再全部丢掉——纯白烧 CPU。
 *
 * 取 AGENT_EVENT_FRESH_MS 的 2 倍作安全余量：文件 mtime 与行内时间戳之间可能有偏差
 * （落盘延迟、时钟微调），留一倍冗余确保不会因为边界误差漏掉真正新鲜的事件。
 */
export const AGENT_FILE_FRESH_MS = AGENT_EVENT_FRESH_MS * 2
/** seenEventIds 最多保留条数（超过后丢最旧的） */
export const AGENT_SEEN_IDS_MAX = 500
/** activeSession 超过这段时间未更新即过期（毫秒） */
export const AGENT_SESSION_EXPIRE_MS = 120_000
/**
 * v0.2.1：Agent working 时「思考视觉」的持续时间（毫秒）。
 * 略长于一个轮询周期，这样持续干活时会被下一轮 working 续期、保持思考态；
 * 一旦 Agent 停下不再有 working 事件，思考态会在这段时间后自动回落 idle。
 */
export const AGENT_THINKING_STATE_MS = AGENT_POLL_INTERVAL_MS + 3_000
/** 终态（done/needs_attention/failed）气泡展示时长（毫秒） */
export const AGENT_TERMINAL_BUBBLE_MS = 6_000
/**
 * v0.3.3：终态事件合并窗口（毫秒）。秒级监控 + 多环境下，短时间内可能有多个
 * 会话接连停下；收到第一个终态后等这段时间收集同批事件，到期一次性弹：
 * 单个照常显示原因，多个合并成「N 个任务完成/需要你」，避免气泡接连炸屏。
 */
export const AGENT_TERMINAL_COALESCE_MS = 900
/** 扫描会话目录时的递归深度上限 */
export const AGENT_SCAN_MAX_DEPTH = 5

/**
 * 宠物窗口固定尺寸（pt）。
 * 放大到 600×600，宠物居中，四周留出足够空间让气泡在最大距离处 360° 自由定位
 * （气泡最远 = BUBBLE_MAX_DISTANCE + 半个气泡宽 ≈ 180+110 = 290，需 ≥290 半径）；
 * 缩放只在窗口内部用 CSS 完成，避免气泡出现时窗口尺寸抖动。
 */
export const PET_WINDOW = { width: 600, height: 600 } as const

/** 宠物本体（缩放前 140×140）在窗口内的中心点，居中 */
export const PET_CENTER = { x: PET_WINDOW.width / 2, y: PET_WINDOW.height / 2 } as const

/** 宠物本体基准尺寸（缩放前，方形）*/
export const PET_BODY_SIZE = 140

export const PET_SCALE_MIN = 0.7
export const PET_SCALE_MAX = 1.5

/**
 * 气泡相对宠物中心的定位：极坐标（角度 + 距离）。
 * angleDeg：0=正右，90=正下，180=正左，270=正上（屏幕坐标系，y 向下）。
 * distance：气泡中心到宠物中心的像素距离，受下面 MIN/MAX 约束。
 */
export const BUBBLE_DEFAULT_ANGLE_DEG = 270 // 默认在正上方（与旧版头顶气泡一致）
/** 气泡与宠物"两个球"的最小间距：宠物半径 + 气泡半高 + 一点缝，避免重叠 */
export const BUBBLE_MIN_DISTANCE = 96
/** 气泡离宠物的最大距离上限，不能拖太远 */
export const BUBBLE_MAX_DISTANCE = 180
export const BUBBLE_DEFAULT_DISTANCE = 110

/** 气泡频率允许范围（秒） */
export const BUBBLE_FREQ_MIN_SECONDS = 30
export const BUBBLE_FREQ_MAX_SECONDS = 3600

/** 默认落位时与屏幕边缘的留白（pt） */
export const SCREEN_EDGE_MARGIN = 24
