import {
  BUBBLE_MAX_DISTANCE,
  BUBBLE_MIN_DISTANCE,
  PET_CENTER
} from '@shared/defaults'
import type { BubbleAnchor, ScreenRect } from '@shared/types'

const DEG2RAD = Math.PI / 180

/** 把极坐标（角度+距离）换算成气泡中心相对窗口左上角的坐标（窗口内 px） */
export function anchorToWindowPoint(anchor: BubbleAnchor): { x: number; y: number } {
  const rad = anchor.angleDeg * DEG2RAD
  return {
    x: PET_CENTER.x + Math.cos(rad) * anchor.distance,
    y: PET_CENTER.y + Math.sin(rad) * anchor.distance
  }
}

/** 把气泡中心（窗口内坐标）换算回极坐标，并把距离夹到 [MIN, MAX] 环内 */
export function windowPointToAnchor(x: number, y: number): BubbleAnchor {
  const dx = x - PET_CENTER.x
  const dy = y - PET_CENTER.y
  const rawDist = Math.hypot(dx, dy)
  const distance = Math.min(Math.max(rawDist, BUBBLE_MIN_DISTANCE), BUBBLE_MAX_DISTANCE)
  // 距离为 0 时保留朝上，避免 atan2(0,0) 抖动
  const angleDeg = rawDist < 0.001 ? 270 : (((Math.atan2(dy, dx) / DEG2RAD) % 360) + 360) % 360
  return { angleDeg, distance }
}

/**
 * 计算气泡实际渲染的窗口内坐标：先按 anchor 定位，
 * 再确保气泡矩形（bubbleW×bubbleH，中心对齐）完整落在屏幕可视范围内，
 * 越界时把气泡中心收进屏幕（不改用户存的 anchor，只影响这次渲染）。
 */
export function effectiveBubbleWindowPoint(
  anchor: BubbleAnchor,
  bubbleW: number,
  bubbleH: number,
  windowRect: ScreenRect,
  displayBounds: ScreenRect
): { x: number; y: number } {
  const p = anchorToWindowPoint(anchor)
  // 气泡中心的屏幕绝对坐标
  let screenX = windowRect.x + p.x
  let screenY = windowRect.y + p.y
  const halfW = bubbleW / 2
  const halfH = bubbleH / 2
  const minX = displayBounds.x + halfW
  const maxX = displayBounds.x + displayBounds.width - halfW
  const minY = displayBounds.y + halfH
  const maxY = displayBounds.y + displayBounds.height - halfH
  if (maxX >= minX) screenX = Math.min(Math.max(screenX, minX), maxX)
  if (maxY >= minY) screenY = Math.min(Math.max(screenY, minY), maxY)
  // 收拢后换回窗口内坐标
  return { x: screenX - windowRect.x, y: screenY - windowRect.y }
}
