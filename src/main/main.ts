import { appendFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { FALLBACK_PET_ID } from '@shared/pets'
import { getPetCatalog, findPetInCatalog } from './petPacks/catalog'
import {
  deleteImportedPack,
  importPetPackFromDialog,
  pickPetImageFromDialog,
  pickSkinFromDialog,
  renameImportedPack,
  revealImportedPacksFolder,
  savePetImageFromDataUrl
} from './petPacks/importPetPack'
import { fetchPetdexList, installPetdexPet } from './petPacks/petdexApi'
import type {
  AgentEventKind,
  AgentMonitorEvent,
  AgentMonitorStatus,
  AgentSource,
  BubblePayload,
  ImportPetPackResult,
  PickPetImageResult,
  PickSkinResult,
  PetState,
  PetStatePayload,
  Settings,
  Snapshot,
  WindowPoint
} from '@shared/types'
import { IPC } from '@shared/types'
import {
  AGENT_AI_BUBBLE_MS,
  AGENT_TERMINAL_BUBBLE_MS,
  AGENT_TERMINAL_COALESCE_MS,
  AGENT_THINKING_STATE_MS
} from '@shared/defaults'
import {
  buildAgentBubbleHead,
  buildAgentBubbleText,
  BUBBLE_DURATION_MS,
  BUBBLE_JITTER,
  BUBBLE_MIN_INTERVAL_MS,
  CLICK_BUBBLE_LINES,
  IDLE_BUBBLE_LINES
} from './config'
import { AgentMonitor } from './agent/monitor'
import { summarizeAgentStop, testAiSummary } from './ai/summarize'
import { getSettings, patchSettings } from './store'
import { clampToWorkArea, createPetWindow, createSettingsWindow, defaultPetPosition } from './windows'
import { createTray, refreshTrayMenu } from './tray'

let petWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let bubbleTimer: ReturnType<typeof setTimeout> | null = null
let dragOrigin: { winX: number; winY: number; cursorX: number; cursorY: number } | null = null
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
let activationCanOpenSettings = false

function debugLaunch(message: string): void {
  if (process.env['DESKTOP_PET_DEBUG_LAUNCH'] !== '1') return
  appendFileSync('/tmp/desktoppet-launch.log', `[${new Date().toISOString()}] ${message}\n`)
}

debugLaunch(`main loaded argv=${JSON.stringify(process.argv)}`)

process.on('uncaughtException', (err) => {
  debugLaunch(`UNCAUGHT: ${err && err.stack ? err.stack : String(err)}`)
  throw err
})

/**
 * 统一的安全落位。两道防线：
 * 1) 非有限数（NaN/Infinity）直接丢弃；
 * 2) clampToWorkArea 把坐标钳进屏幕合理范围——这既防"拖到屏幕外几千像素"，
 *    也防快速拖拽偶发的超大坐标（>32 位 int 上限，Number.isInteger 放行但原生
 *    setPosition 会 "conversion failure at index 0" 崩主进程，正是 app 突然消失的真因）。
 */
function safeSetPetPosition(x: number, y: number, from: string): void {
  if (!petWindow || petWindow.isDestroyed()) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    debugLaunch(`SKIP setPosition from ${from}: non-finite (${x},${y})`)
    return
  }
  const safe = clampToWorkArea({ x, y }, getSettings().petScale)
  // 最终硬底线：任何非整数或超出 32 位 int 范围的坐标都不喂给原生 setPosition，
  // 否则会 "conversion failure" 直接崩主进程（app 突然消失的真因）。
  const INT32_MAX = 2147483647
  if (
    !Number.isInteger(safe.x) ||
    !Number.isInteger(safe.y) ||
    safe.x > INT32_MAX ||
    safe.x < -INT32_MAX ||
    safe.y > INT32_MAX ||
    safe.y < -INT32_MAX
  ) {
    debugLaunch(`SKIP setPosition from ${from}: in=(${x},${y}) safe=(${safe.x},${safe.y})`)
    return
  }
  // 终极保险：即便上面全过了，原生 setPosition 万一仍抛错（极端/竞态），
  // 也只吞掉这一次移动，绝不让主进程崩溃、app 消失。
  try {
    petWindow.setPosition(safe.x, safe.y)
  } catch (err) {
    debugLaunch(`setPosition threw from ${from} safe=(${safe.x},${safe.y}): ${String(err)}`)
  }
}

// ---------- 导航与 IPC 边界 ----------

function isAllowedRendererUrl(url: string): boolean {
  if (!url) return false
  try {
    const actual = new URL(url)
    if (rendererDevUrl) {
      return actual.origin === new URL(rendererDevUrl).origin
    }
    return actual.protocol === 'file:' && actual.pathname.endsWith('/renderer/index.html')
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? event.sender.getURL()
  return isAllowedRendererUrl(url)
}

function requireTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) {
    throw new Error('Blocked IPC from an untrusted renderer')
  }
}

function registerNavigationGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedRendererUrl(url)) event.preventDefault()
    })
  })
}

// ---------- 快照 ----------

function buildSnapshot(): Snapshot {
  return {
    settings: getSettings(),
    pets: getPetCatalog(),
    appVersion: app.getVersion(),
    agent: agentStatus(),
    isPackaged: app.isPackaged
  }
}

function broadcastSnapshot(): void {
  const snapshot = buildSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.OnSnapshot, snapshot)
  }
}

// ---------- 气泡 ----------

function pickRandom(lines: readonly string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]
}

function sendBubble(
  text: string,
  state: PetState,
  durationMs = BUBBLE_DURATION_MS,
  sound = false,
  interactive = false
): void {
  // 宠物被隐藏时不弹气泡：用户主动隐藏 = 明确表达"别打扰"，尊重它。
  // Agent 事件仍会被 monitor 记为已处理，不会因这次没弹而重复触发。
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return
  const bounds = petWindow.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const payload: BubblePayload = {
    text,
    state,
    durationMs,
    windowRect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    // 用 workArea 而不是整屏 bounds：气泡被收拢到菜单栏/Dock 后面等于没收拢
    displayBounds: display.workArea,
    sound,
    interactive
  }
  petWindow.webContents.send(IPC.OnShowBubble, payload)
}

/**
 * v0.2.1：只切换宠物状态、不弹气泡。用于 Agent working 时的安静思考视觉。
 * 与 sendBubble 一样尊重「隐藏 = 别打扰」，隐藏时什么都不做。
 */
function sendPetState(state: PetState, durationMs: number): void {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return
  const payload: PetStatePayload = { state, durationMs }
  petWindow.webContents.send(IPC.OnSetState, payload)
}

function setPetInteractive(interactive: boolean): void {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

function recheckPetInteractivity(): void {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return
  const cursor = screen.getCursorScreenPoint()
  const bounds = petWindow.getBounds()
  const inside =
    cursor.x >= bounds.x &&
    cursor.x < bounds.x + bounds.width &&
    cursor.y >= bounds.y &&
    cursor.y < bounds.y + bounds.height

  if (!inside) {
    setPetInteractive(false)
    return
  }

  const point: WindowPoint = {
    x: Math.round(cursor.x - bounds.x),
    y: Math.round(cursor.y - bounds.y)
  }
  petWindow.webContents.send(IPC.OnRecheckHover, point)
}

function isCursorOverPetWindow(): boolean {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return false
  const cursor = screen.getCursorScreenPoint()
  const bounds = petWindow.getBounds()
  return (
    cursor.x >= bounds.x &&
    cursor.x < bounds.x + bounds.width &&
    cursor.y >= bounds.y &&
    cursor.y < bounds.y + bounds.height
  )
}

/** 按设置的频率（带抖动）调度下一条闲时陪伴气泡 */
function scheduleIdleBubble(): void {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  const settings = getSettings()
  if (!settings.bubblesEnabled || !settings.petVisible) return
  const jitter = 1 - BUBBLE_JITTER + Math.random() * BUBBLE_JITTER * 2
  const delay = Math.max(BUBBLE_MIN_INTERVAL_MS, settings.bubbleFrequencySeconds * 1000 * jitter)
  bubbleTimer = setTimeout(() => {
    sendBubble(pickRandom(IDLE_BUBBLE_LINES), 'attention')
    scheduleIdleBubble()
  }, delay)
}

// ---------- Agent 监控（v0.2） ----------

let agentMonitor: AgentMonitor | null = null

/** Agent 状态 → 宠物状态。done 复用 happy，needs_attention 复用 attention */
function agentKindToPetState(kind: AgentEventKind): PetState {
  switch (kind) {
    case 'working':
      return 'thinking'
    case 'done':
      return 'happy'
    case 'needs_attention':
      return 'attention'
    case 'failed':
      return 'failed'
  }
}

/**
 * 统一处理一条 Agent 事件。
 * v0.2.1 行为（用户要求）：只有 Agent「停下来」时才弹气泡，且气泡说清停下的原因。
 *   - working：Agent 正在干活。只切宠物为 thinking（安静的思考视觉），绝不弹气泡。
 *   - done / needs_attention / failed：Agent 停止输出了，弹一条说明「为什么停」的气泡。
 */
function handleAgentEvent(event: AgentMonitorEvent): void {
  // v0.3.3：无总开关。两个子开关都关时 monitor 根本不 tick，这里无需再挡。
  if (event.kind === 'working') {
    // 正在干活：只让宠物切 thinking（保留思考视觉），不打扰、不弹气泡。
    sendPetState('thinking', AGENT_THINKING_STATE_MS)
    // 诊断区（活跃会话/最近事件）也可能变了，广播刷新设置页
    broadcastSnapshot()
    return
  }

  // 停下来了：进合并缓冲，短窗口内的多个终态一次性弹（防炸屏）
  pendingTerminals.push(event)
  if (!terminalFlushTimer) {
    terminalFlushTimer = setTimeout(() => void flushTerminalBubbles(), AGENT_TERMINAL_COALESCE_MS)
  }
  // 诊断信息变了，实时刷新设置页
  broadcastSnapshot()
}

// v0.3.3：终态事件合并缓冲。收第一个终态后等 COALESCE 窗口，到期一次弹。
let pendingTerminals: AgentMonitorEvent[] = []
let terminalFlushTimer: ReturnType<typeof setTimeout> | null = null

async function flushTerminalBubbles(): Promise<void> {
  terminalFlushTimer = null
  const batch = pendingTerminals
  pendingTerminals = []
  if (batch.length === 0) return

  // 提示音：这批里只要有「完成」事件、且用户开了提示音，就随气泡响一声
  const soundOn = getSettings().agentCompletionSoundEnabled
  const hasDone = batch.some((e) => e.kind === 'done')
  const sound = soundOn && hasDone

  if (batch.length === 1) {
    const e = batch[0]
    // v0.5 AI 总结（可选）：读会话末尾生成一句人话细节，拼在规则首行下面。
    // 关着 / 没配 Key / 失败 / 超时都返回 null → 原样回落纯规则文案，提醒永不缺席。
    const ai = await summarizeAgentStop(e, getSettings())
    const text = ai ? `${buildAgentBubbleHead(e)}\n${ai}` : buildAgentBubbleText(e)
    const durationMs = ai ? AGENT_AI_BUBBLE_MS : AGENT_TERMINAL_BUBBLE_MS
    sendBubble(text, agentKindToPetState(e.kind), durationMs, sound)
    return
  }

  // 多个：合并成一句摘要。宠物状态优先级 failed > needs_attention > done
  const kinds = new Set(batch.map((e) => e.kind))
  const worst: AgentEventKind = kinds.has('failed')
    ? 'failed'
    : kinds.has('needs_attention')
      ? 'needs_attention'
      : 'done'
  const doneN = batch.filter((e) => e.kind === 'done').length
  const needN = batch.filter((e) => e.kind === 'needs_attention').length
  const failN = batch.filter((e) => e.kind === 'failed').length
  const parts: string[] = []
  if (doneN) parts.push(`${doneN} 个完成`)
  if (needN) parts.push(`${needN} 个需要你`)
  if (failN) parts.push(`${failN} 个出错/中断`)
  const text = `${batch.length} 个任务停下来了：${parts.join('，')}`
  sendBubble(text, agentKindToPetState(worst), AGENT_TERMINAL_BUBBLE_MS, sound)
}

function agentStatus(): AgentMonitorStatus {
  if (agentMonitor) return agentMonitor.getStatus()
  const s = getSettings()
  return {
    enabled: s.codexMonitoringEnabled || s.claudeMonitoringEnabled,
    lastEvent: null,
    activeSessions: [],
    lastCheckedAt: null,
    error: null
  }
}

/** 按当前设置启动 / 重启 monitor */
function syncAgentMonitor(): void {
  const s = getSettings()
  const config = {
    codexEnabled: s.codexMonitoringEnabled,
    claudeEnabled: s.claudeMonitoringEnabled,
    codexEnvs: s.codexMonitoringEnvs,
    claudeEnvs: s.claudeMonitoringEnvs
  }
  if (!agentMonitor) {
    agentMonitor = new AgentMonitor(config, {
      now: () => Date.now(),
      onEvent: handleAgentEvent
      // 需要排查 Agent 监控链路时，这里注入一个 log 回调即可（MonitorDeps.log）。
      // 正式版不注入 → 监控不写任何诊断日志。
    })
  } else {
    agentMonitor.updateConfig(config)
  }
}

// ---------- 设置与副作用 ----------

function applySettings(partial: Partial<Settings>): Snapshot {
  const before = getSettings()
  const next = patchSettings(partial)
  if (petWindow && !petWindow.isDestroyed() && before.petVisible !== next.petVisible) {
    if (next.petVisible) {
      petWindow.showInactive()
      recheckPetInteractivity()
    } else {
      setPetInteractive(false)
      petWindow.hide()
      petWindow.webContents.send(IPC.OnHideBubble)
    }
  }
  if (
    before.bubblesEnabled !== next.bubblesEnabled ||
    before.bubbleFrequencySeconds !== next.bubbleFrequencySeconds ||
    before.petVisible !== next.petVisible
  ) {
    scheduleIdleBubble()
  }
  if (before.petVisible !== next.petVisible) {
    refreshTrayMenu()
    refreshDockMenu()
    installApplicationMenu()
  }
  // 调大宠物后，原位置可能让放大的本体越界，按新缩放重新钳一次
  if (before.petScale !== next.petScale && petWindow && !petWindow.isDestroyed()) {
    const [x, y] = petWindow.getPosition()
    const clamped = clampToWorkArea({ x, y }, next.petScale)
    if (clamped.x !== x || clamped.y !== y) {
      safeSetPetPosition(clamped.x, clamped.y, 'scaleChanged')
      patchSettings({ petPosition: clamped })
    }
  }
  // Agent 监控子开关 / 环境集合变化时重启 monitor
  if (
    before.codexMonitoringEnabled !== next.codexMonitoringEnabled ||
    before.claudeMonitoringEnabled !== next.claudeMonitoringEnabled ||
    JSON.stringify(before.codexMonitoringEnvs) !== JSON.stringify(next.codexMonitoringEnvs) ||
    JSON.stringify(before.claudeMonitoringEnvs) !== JSON.stringify(next.claudeMonitoringEnvs)
  ) {
    syncAgentMonitor()
  }
  broadcastSnapshot()
  return buildSnapshot()
}

function savePetPosition(recheckInteractive = true): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const [x, y] = petWindow.getPosition()
  const clamped = clampToWorkArea({ x, y }, getSettings().petScale)
  if (clamped.x !== x || clamped.y !== y) safeSetPetPosition(clamped.x, clamped.y, 'savePetPosition')
  patchSettings({ petPosition: clamped })
  if (recheckInteractive) recheckPetInteractivity()
}

function resetPetPosition(): void {
  const pos = defaultPetPosition()
  safeSetPetPosition(pos.x, pos.y, 'resetPetPosition')
  patchSettings({ petPosition: pos })
  recheckPetInteractivity()
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    revealSettingsWindow(settingsWindow)
    return
  }
  settingsWindow = createSettingsWindow()
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  revealSettingsWindow(settingsWindow)
  settingsWindow.webContents.once('did-finish-load', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) revealSettingsWindow(settingsWindow)
  })
}

function revealSettingsWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (win.isMinimized()) win.restore()
  win.show()
  win.moveTop()
  win.focus()
}

function quit(): void {
  app.quit()
}

/**
 * v0.4：处理 deskpet:// 协议唤起。支持 deskpet://install?url=<zip>&name=<显示名>
 * —— 网页点「导入到 DeskPet」时触发，唤起本 App 后台下载安装那只宠物。
 * 安全：只接受 https 的 zip 地址；只处理 install 动作，其余静默忽略。
 */
function handleDeskpetUrl(rawUrl: string): void {
  debugLaunch(`deskpet url: ${rawUrl}`)
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (parsed.protocol !== 'deskpet:') return
  // host 或 pathname 可能是 install（deskpet://install?… 解析后 host='install'）
  const action = parsed.host || parsed.pathname.replace(/^\/+/, '')
  if (action !== 'install') return

  const zipUrl = parsed.searchParams.get('url') || ''
  const name = parsed.searchParams.get('name') || ''
  if (!/^https:\/\//.test(zipUrl)) {
    debugLaunch('deskpet install: url not https, ignored')
    return
  }

  void installPetdexPet(zipUrl, name).then((result) => {
    if (result.ok) {
      applySettings({ selectedPetId: result.slug })
      openSettings()
      sendBubble(`已装上「${result.name}」🎉`, 'happy', AGENT_TERMINAL_BUBBLE_MS)
    } else {
      openSettings()
      sendBubble(`装宠物失败：${result.error}`, 'failed', AGENT_TERMINAL_BUBBLE_MS)
    }
  })
}

/** 从一批启动/命令行参数里挑出 deskpet:// URL（Windows/Linux 冷启动走命令行参数） */
function extractDeskpetUrl(argv: string[]): string | null {
  return argv.find((a) => a.startsWith('deskpet://')) ?? null
}

function buildQuickAccessMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '设置…', click: openSettings },
    { label: getSettings().petVisible ? '隐藏桌宠' : '显示桌宠', click: () => applySettings({ petVisible: !getSettings().petVisible }) },
    { label: '重置位置', click: resetPetPosition },
    { type: 'separator' },
    { label: '退出', click: quit }
  ])
}

function refreshDockMenu(): void {
  if (process.platform === 'darwin') {
    app.dock?.setMenu(buildQuickAccessMenu())
  }
}

function installApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: '设置…', accelerator: 'Command+,', click: openSettings },
        { label: getSettings().petVisible ? '隐藏桌宠' : '显示桌宠', click: () => applySettings({ petVisible: !getSettings().petVisible }) },
        { label: '重置位置', click: resetPetPosition },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    { role: 'editMenu', label: '编辑' },
    { role: 'windowMenu', label: '窗口' }
  ])
  Menu.setApplicationMenu(menu)
}

function openSettingsFromAppActivation(): void {
  if (!activationCanOpenSettings || !app.isReady()) return
  if (isCursorOverPetWindow()) return
  openSettings()
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle(IPC.GetSnapshot, (event) => {
    requireTrustedSender(event)
    return buildSnapshot()
  })
  ipcMain.handle(IPC.UpdateSettings, (event, partial: unknown) => {
    requireTrustedSender(event)
    return applySettings(typeof partial === 'object' && partial !== null ? (partial as Partial<Settings>) : {})
  })
  ipcMain.handle(IPC.SelectPet, (event, petId: unknown) => {
    requireTrustedSender(event)
    return applySettings(typeof petId === 'string' ? { selectedPetId: petId } : {})
  })
  ipcMain.handle(IPC.ResetPetPosition, (event) => {
    requireTrustedSender(event)
    resetPetPosition()
  })
  ipcMain.handle(IPC.ShowPet, (event) => {
    requireTrustedSender(event)
    applySettings({ petVisible: true })
  })
  ipcMain.handle(IPC.HidePet, (event) => {
    requireTrustedSender(event)
    applySettings({ petVisible: false })
  })
  ipcMain.handle(IPC.QuitApp, (event) => {
    requireTrustedSender(event)
    quit()
  })

  // v0.3.3：合并后的「导入皮肤」——一个对话框选图片或皮肤包文件夹，按类型分流
  ipcMain.handle(IPC.PickSkin, (event): PickSkinResult => {
    requireTrustedSender(event)
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined
    const res = pickSkinFromDialog(parent)
    if (res.kind === 'pack') {
      // 皮肤包已导入完成：切到新宠物并回传最新快照
      applySettings({ selectedPetId: res.petId })
      return { kind: 'pack', snapshot: buildSnapshot(), petId: res.petId }
    }
    if (res.kind === 'petdex') {
      // v0.4：PetDex 宠物已导入完成：切到它并回传快照
      applySettings({ selectedPetId: res.slug })
      return { kind: 'petdex', snapshot: buildSnapshot(), slug: res.slug, name: res.name }
    }
    // image / canceled / error 原样透传（图片分支由渲染进程继续抠图 + savePetImage）
    return res
  })

  // v0.4：在线形象库——拉全量列表（联网，用户主动触发）
  ipcMain.handle(IPC.FetchPetdexList, (event) => {
    requireTrustedSender(event)
    return fetchPetdexList()
  })

  // v0.4：一键下载安装某只 PetDex 宠物，装完切到它并回传快照
  ipcMain.handle(IPC.InstallPetdexPet, async (event, zipUrl: unknown, displayName: unknown) => {
    requireTrustedSender(event)
    if (typeof zipUrl !== 'string' || !/^https:\/\//.test(zipUrl)) {
      return { result: { ok: false, error: '无效的下载地址' }, snapshot: buildSnapshot() }
    }
    const result = await installPetdexPet(zipUrl, typeof displayName === 'string' ? displayName : '')
    if (result.ok) applySettings({ selectedPetId: result.slug })
    return { result, snapshot: buildSnapshot() }
  })

  // v0.3：导入皮肤包（弹目录选择框 → 校验 → 复制 → 选中新宠物）
  ipcMain.handle(IPC.ImportPetPack, (event): ImportPetPackResult => {
    requireTrustedSender(event)
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined
    const res = importPetPackFromDialog(parent)
    if (!res.ok) {
      return { ok: false, error: res.error, canceled: res.canceled }
    }
    // 导入成功：切到新宠物（applySettings 会 broadcastSnapshot），再返回最新快照
    applySettings({ selectedPetId: res.petId })
    return { ok: true, snapshot: buildSnapshot(), petId: res.petId }
  })

  // v0.3.1 单图导入第一步：弹框选图，返回 dataUrl 给渲染进程抠背景（不落盘）
  ipcMain.handle(IPC.PickPetImage, (event): PickPetImageResult => {
    requireTrustedSender(event)
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined
    return pickPetImageFromDialog(parent)
  })

  // v0.3.1 单图导入第二步：存下（可能已抠好背景的）图，套壳成皮肤包并切过去
  ipcMain.handle(
    IPC.SavePetImage,
    (event, dataUrl: unknown, name: unknown): ImportPetPackResult => {
      requireTrustedSender(event)
      if (typeof dataUrl !== 'string') {
        return { ok: false, error: '图片数据缺失' }
      }
      const res = savePetImageFromDataUrl(dataUrl, typeof name === 'string' ? name : '')
      if (!res.ok) {
        return { ok: false, error: res.error, canceled: res.canceled }
      }
      applySettings({ selectedPetId: res.petId })
      return { ok: true, snapshot: buildSnapshot(), petId: res.petId }
    }
  )

  // v0.3：删除已导入皮肤包（只允许删 imported；删的是当前宠物则回落 dango）
  ipcMain.handle(IPC.DeleteImportedPetPack, (event, petId: unknown): Snapshot => {
    requireTrustedSender(event)
    if (typeof petId !== 'string') return buildSnapshot()
    // 只允许删 imported 来源的（官方内置不可删）
    const target = findPetInCatalog(petId)
    if (!target || target.source !== 'imported') return buildSnapshot()
    deleteImportedPack(petId)
    // 若删掉的正是当前选中宠物，切回 dango
    if (getSettings().selectedPetId === petId) {
      applySettings({ selectedPetId: FALLBACK_PET_ID })
    } else {
      broadcastSnapshot()
    }
    return buildSnapshot()
  })

  // v0.3.3：重命名已导入皮肤包显示名（只允许 imported；改的是 name 不是 id）
  ipcMain.handle(IPC.RenameImportedPetPack, (event, petId: unknown, name: unknown): Snapshot => {
    requireTrustedSender(event)
    if (typeof petId !== 'string' || typeof name !== 'string') return buildSnapshot()
    // 官方内置不可改名
    const target = findPetInCatalog(petId)
    if (!target || target.source !== 'imported') return buildSnapshot()
    renameImportedPack(petId, name)
    // catalog 无缓存，写回 manifest 后重扫即反映新名字；广播刷新所有窗口
    broadcastSnapshot()
    return buildSnapshot()
  })

  // v0.3：在 Finder 打开导入皮肤包目录
  ipcMain.handle(IPC.RevealPetPacksFolder, (event) => {
    requireTrustedSender(event)
    revealImportedPacksFolder()
  })

  ipcMain.on(IPC.PetClicked, (event) => {
    if (!isTrustedSender(event)) return
    // interactive=true：这是用户手动点出来的互动气泡，不该被后台 Agent 的 working 清掉
    sendBubble(pickRandom(CLICK_BUBBLE_LINES), 'happy', BUBBLE_DURATION_MS, false, true)
    // 刚互动过就不要紧接着再冒闲时气泡，重置计时
    scheduleIdleBubble()
  })

  ipcMain.on(IPC.DragStart, (event) => {
    if (!isTrustedSender(event)) return
    if (!petWindow || petWindow.isDestroyed()) return
    const [winX, winY] = petWindow.getPosition()
    // 用主进程权威的鼠标屏幕坐标作为锚点，而不是渲染进程 PointerEvent 的 screenX/Y。
    // 后者在窗口被拖出屏幕（enableLargerThanScreen 打开后）时可能上报异常值，
    // 累加成天文数字导致 setPosition 崩溃、app 消失。
    const cursor = screen.getCursorScreenPoint()
    dragOrigin = { winX, winY, cursorX: cursor.x, cursorY: cursor.y }
  })
  ipcMain.on(IPC.DragMove, (event) => {
    if (!isTrustedSender(event)) return
    if (!petWindow || petWindow.isDestroyed() || !dragOrigin) return
    // 同样只信任主进程的实时鼠标坐标，渲染进程只负责"触发"移动，不再传坐标。
    const cursor = screen.getCursorScreenPoint()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return
    const nextX = Math.round(dragOrigin.winX + (cursor.x - dragOrigin.cursorX))
    const nextY = Math.round(dragOrigin.winY + (cursor.y - dragOrigin.cursorY))
    safeSetPetPosition(nextX, nextY, 'dragMove')
  })
  ipcMain.on(IPC.DragStop, (event) => {
    if (!isTrustedSender(event)) return
    dragOrigin = null
    savePetPosition()
  })

  ipcMain.on(IPC.SetInteractive, (event, interactive: unknown) => {
    if (!isTrustedSender(event)) return
    setPetInteractive(interactive === true)
  })

  // v0.2 dev 模拟：构造一条 Agent 事件走 monitor 的统一处理链路（非扫描来源，不受 prime/终态限制）
  ipcMain.on(IPC.AgentSimulate, (event, source: unknown, kind: unknown) => {
    if (!isTrustedSender(event)) return
    if (app.isPackaged) return // 打包环境不提供模拟
    const validSources: AgentSource[] = ['codex', 'claude']
    const validKinds: AgentEventKind[] = ['working', 'done', 'needs_attention', 'failed']
    if (!validSources.includes(source as AgentSource)) return
    if (!validKinds.includes(kind as AgentEventKind)) return
    if (!agentMonitor) syncAgentMonitor()
    const k = kind as AgentEventKind
    // 给模拟事件补上默认的停止原因 + 细节，方便验证「带原因的气泡」文案
    const simReason =
      k === 'failed' ? 'error' : k === 'needs_attention' ? 'needs_input' : undefined
    const simDetail =
      k === 'failed'
        ? '示例：TypeError: cannot read property x of undefined'
        : k === 'needs_attention'
          ? '示例：是否允许写入 /etc/hosts？'
          : undefined
    agentMonitor?.ingest(
      {
        id: '',
        source: source as AgentSource,
        env: 'terminal',
        sessionKey: `sim:${source}`,
        kind: k,
        message: `模拟 ${source} ${kind}`,
        timestampMs: Date.now(),
        rawPath: undefined,
        reason: simReason,
        detail: simDetail
      },
      false
    )
  })

  // v0.5：设置台「测试连接」——用当前 AI 设置对样例文本发一次真实请求，验证 Key/模型可用
  ipcMain.handle(IPC.TestAiSummary, (event) => {
    requireTrustedSender(event)
    return testAiSummary(getSettings())
  })
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  debugLaunch('single instance lock failed; quitting')
  app.quit()
} else {
  debugLaunch('single instance lock acquired')
  registerNavigationGuards()

  // v0.4：注册 deskpet:// 协议（dev 下需带 process.execPath + 脚本路径才能正确回调）
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('deskpet', process.execPath, [require('node:path').resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient('deskpet')
  }

  // macOS：App 已运行时，点 deskpet:// 链接走这里
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (app.isReady()) handleDeskpetUrl(url)
    else app.once('ready', () => handleDeskpetUrl(url))
  })

  app.on('second-instance', (_event, argv) => {
    // Windows/Linux：第二实例的命令行参数里可能带 deskpet:// URL
    const url = extractDeskpetUrl(argv)
    if (url) {
      if (app.isReady()) handleDeskpetUrl(url)
      else app.once('ready', () => handleDeskpetUrl(url))
      return
    }
    if (app.isReady()) openSettings()
    else app.once('ready', openSettings)
  })

  app.on('activate', () => {
    openSettingsFromAppActivation()
  })

  app.on('did-become-active', () => {
    openSettingsFromAppActivation()
  })

  void app.whenReady().then(() => {
    debugLaunch('app ready')
    registerIpc()

    // v0.4：冷启动时命令行里可能带 deskpet:// URL（Windows/Linux；macOS 走 open-url）
    const coldUrl = extractDeskpetUrl(process.argv)
    if (coldUrl) setTimeout(() => handleDeskpetUrl(coldUrl), 800)

    const saved = getSettings().petPosition
    const position = saved ? clampToWorkArea(saved, getSettings().petScale) : defaultPetPosition()
    petWindow = createPetWindow(position)
    debugLaunch('pet window created')
    petWindow.once('ready-to-show', () => {
      if (getSettings().petVisible && petWindow && !petWindow.isDestroyed()) {
        petWindow.showInactive()
        recheckPetInteractivity()
      }
    })
    petWindow.on('closed', () => {
      petWindow = null
    })

    createTray({
      isPetVisible: () => getSettings().petVisible,
      togglePet: () => {
        applySettings({ petVisible: !getSettings().petVisible })
      },
      openSettings,
      resetPosition: resetPetPosition,
      quit
    })
    debugLaunch('tray created')
    installApplicationMenu()
    refreshDockMenu()
    activationCanOpenSettings = true
    openSettings()
    debugLaunch('openSettings requested on startup')

    scheduleIdleBubble()

    // v0.2：按设置启动 Agent 监控
    syncAgentMonitor()
    agentMonitor?.start()
    debugLaunch('agent monitor started')
  })

  // 托盘应用：设置窗口关掉、宠物隐藏时也要常驻
  app.on('window-all-closed', () => {
    /* 不退出 */
  })

  app.on('before-quit', () => {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    agentMonitor?.stop()
    if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
      savePetPosition(false)
    }
  })
}
