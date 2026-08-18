import { join } from 'node:path'
import { app, Menu, Tray, nativeImage } from 'electron'
import appIcon from '../../build/icon.png?asset'

export interface TrayHandlers {
  isPetVisible(): boolean
  togglePet(): void
  openSettings(): void
  resetPosition(): void
  quit(): void
  /** 有新版本时返回版本号，没有则返回 null（决定菜单里是否多一项下载入口） */
  pendingUpdateVersion(): string | null
  openUpdatePage(): void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

export function createTray(h: TrayHandlers): void {
  handlers = h
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.icns') : appIcon
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  tray.setToolTip('桌宠')
  tray.setTitle('PET')
  tray.on('click', () => tray?.popUpContextMenu(buildTrayMenu()))
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  refreshTrayMenu()
}

export function refreshTrayMenu(): void {
  if (!tray || !handlers) return
  tray.setContextMenu(buildTrayMenu())
}

function buildTrayMenu(): Menu {
  if (!handlers) return Menu.buildFromTemplate([])
  const h = handlers
  const update = h.pendingUpdateVersion()
  return Menu.buildFromTemplate([
    { label: h.isPetVisible() ? '隐藏桌宠' : '显示桌宠', click: () => h.togglePet() },
    { label: '设置…', click: () => h.openSettings() },
    { label: '重置位置', click: () => h.resetPosition() },
    // 新版本入口只在真有新版本时出现：气泡会过期消失，托盘是那之后唯一还找得到的入口
    ...(update
      ? [
          { type: 'separator' as const },
          { label: `下载新版本 v${update}`, click: () => h.openUpdatePage() }
        ]
      : []),
    { type: 'separator' },
    { label: '退出', click: () => h.quit() }
  ])
}
