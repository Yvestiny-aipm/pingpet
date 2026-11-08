import { join } from 'node:path'
import { app, Menu, Tray, nativeImage } from 'electron'
import appIcon from '../../build/icon.png?asset'

export interface TrayHandlers {
  isPetVisible(): boolean
  togglePet(): void
  openSettings(): void
  resetPosition(): void
  quit(): void
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
  return Menu.buildFromTemplate([
    { label: h.isPetVisible() ? '隐藏桌宠' : '显示桌宠', click: () => h.togglePet() },
    { label: '设置…', click: () => h.openSettings() },
    { label: '重置位置', click: () => h.resetPosition() },
    { type: 'separator' },
    { label: '退出', click: () => h.quit() }
  ])
}
