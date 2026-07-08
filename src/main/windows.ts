import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import { PET_BODY_SIZE, PET_CENTER, PET_WINDOW, SCREEN_EDGE_MARGIN } from '@shared/defaults'
import type { PetPosition } from '@shared/types'

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

function loadRoute(win: BrowserWindow, hash: 'pet' | 'settings'): void {
  if (rendererDevUrl) {
    void win.loadURL(`${rendererDevUrl}#${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

/** 默认落位：让"宠物本体"落在主屏工作区右下角（窗口比本体大很多，需按本体反推窗口坐标） */
export function defaultPetPosition(): PetPosition {
  const { workArea } = screen.getPrimaryDisplay()
  const half = PET_BODY_SIZE / 2
  // 宠物本体右下角贴近工作区右下角，留 SCREEN_EDGE_MARGIN
  const petRight = workArea.x + workArea.width - SCREEN_EDGE_MARGIN
  const petBottom = workArea.y + workArea.height - SCREEN_EDGE_MARGIN
  const petCenterX = petRight - half
  const petCenterY = petBottom - half
  return {
    x: Math.round(petCenterX - PET_CENTER.x),
    y: Math.round(petCenterY - PET_CENTER.y)
  }
}

/**
 * 把窗口位置收敛进所在显示器，让"可见宠物本体"完整地留在屏幕内、
 * 能贴到四边就停（像球撞墙），任何一部分都不越过屏幕边界。
 * 用整块显示器 bounds（不是 workArea），并按可见宠物本体（含缩放）而非透明窗口来算。
 *
 * 可见宠物在窗口内居中（PET_CENTER），缩放后尺寸 = PET_BODY_SIZE * scale，
 * 以中心为锚点向四周展开。
 */
export function clampToWorkArea(pos: PetPosition, petScale = 1): PetPosition {
  const petCenter = {
    x: pos.x + PET_CENTER.x,
    y: pos.y + PET_CENTER.y
  }
  const display = screen.getDisplayMatching({
    x: Math.round(petCenter.x - 1),
    y: Math.round(petCenter.y - 1),
    width: 2,
    height: 2
  })
  const b = display.bounds

  const scale = Number.isFinite(petScale) && petScale > 0 ? petScale : 1
  const half = (PET_BODY_SIZE * scale) / 2
  // 可见宠物盒相对窗口左上角的上/左边缘偏移（居中布局）
  const insetLeft = PET_CENTER.x - half
  const insetTop = PET_CENTER.y - half
  const visSize = PET_BODY_SIZE * scale

  // 让"可见宠物盒"完整落在显示器内 → 反推窗口左上角坐标的合法范围
  const minX = b.x - insetLeft
  const maxX = b.x + b.width - insetLeft - visSize
  const minY = b.y - insetTop
  const maxY = b.y + b.height - insetTop - visSize

  // 屏幕比宠物还小的极端情况下，min 可能大于 max，用 min 兜底避免 NaN 方向错乱
  const clamp = (v: number, lo: number, hi: number): number =>
    hi >= lo ? Math.min(Math.max(v, lo), hi) : lo

  return {
    x: Math.round(clamp(pos.x, minX, maxX)),
    y: Math.round(clamp(pos.y, minY, maxY))
  }
}

export function createPetWindow(position: PetPosition): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // 允许窗口位置越过屏幕边缘（含顶部菜单栏区域）。
    // 没有它时 macOS 会把窗口 y 钳制在工作区顶部（菜单栏下方），
    // 宠物往上拖只能到"离顶 1/3"处就卡住——这是宠物无法贴到屏幕最上方的真因。
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // v0.3.1：皮肤包素材用 <img src="file://..."> 渲染；dev 下 renderer 跑在
      // http://localhost 源，浏览器同源策略会拦 file:// 资源，导致导入/官方皮肤包
      // 图片加载失败（naturalWidth=0）。关掉 webSecurity 放行本地素材加载。
      webSecurity: false
    }
  })
  // v0.1 用温和的 floating 层级，不抢占 screen-saver 等激进层级
  win.setAlwaysOnTop(true, 'floating')
  // 跟随用户切换 Space，但不覆盖全屏应用
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  // 默认让整个透明窗口对鼠标"透明"，指针悬到宠物上时由渲染进程切回可交互
  win.setIgnoreMouseEvents(true, { forward: true })
  loadRoute(win, 'pet')
  return win
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // v0.3.2：设置台重构为「左侧导航 + 右侧面板」，用更宽的矩形给内容留白
    width: 760,
    height: 620,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '桌宠设置',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 见宠物窗同处注释：放行皮肤包 file:// 素材在 dev 的 http 源下加载。
      // 设置窗要显示皮肤包卡片缩略图，同样需要。
      webSecurity: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 让设置窗跟到用户当前所在的 Space（含别的 app 全屏时的 Space），
  // 避免点 Dock 图标把用户从全屏应用甩到一张空白桌面。
  // Electron 只暴露 setVisibleOnAllWorkspaces（= CanJoinAllSpaces + FullScreenAuxiliary），
  // 没有 MoveToActiveSpace，所以在创建时常驻置位；设置窗关掉即销毁，不会长期漂在所有 Space。
  // skipTransformProcessType 避免调用时闪一下 Dock 图标（本 app 是常规 Dock 应用）。
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  win.once('ready-to-show', () => {
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.show()
    win.focus()
  })
  loadRoute(win, 'settings')
  return win
}
