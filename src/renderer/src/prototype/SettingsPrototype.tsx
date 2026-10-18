import { useEffect, useRef, useState } from 'react'
import type { AiTestResult, Settings, Snapshot } from '@shared/types'
import type { AgentEnv, MonitoringEnvsKey } from '@shared/types'
import DashboardFrame from './DashboardFrame'
import './settings.css'

const CANVAS_W = 2240
const CANVAS_H = 2048
const MIN_VIEW_W = 480
const MIN_VIEW_H = 360

export type AiProviderChoice = 'anthropic' | 'siliconflow' | 'openai'

export interface SettingsPrototypeProps {
  snapshot: Snapshot
  displayScale: number
  packBusy: boolean
  packError: string | null
  aiTestBusy: boolean
  aiTestResult: AiTestResult | null
  aiProviderChoice: AiProviderChoice
  onPatch: (partial: Partial<Settings>) => void
  onSelectPet: (id: string) => void
  onScaleDraft: (n: number) => void
  onScaleCommit: (n: number) => void
  onImport: () => void
  onReveal: () => void
  onDeletePack: (id: string, name: string) => void
  onToggleEnv: (key: MonitoringEnvsKey, current: AgentEnv[], env: AgentEnv) => void
  onTestAi: () => void
  onAiProviderChoice: (choice: AiProviderChoice) => void
  onResetPosition: () => void
  onToggleVisible: () => void
}

function readViewport(el: HTMLElement | null): { width: number; height: number } | null {
  const width = el?.clientWidth || window.innerWidth
  const height = el?.clientHeight || window.innerHeight
  if (width < MIN_VIEW_W || height < MIN_VIEW_H) return null
  return { width, height }
}

function fitScale(width: number, height: number): number {
  return Math.min(width / CANVAS_W, height / CANVAS_H)
}

export default function SettingsPrototype(props: SettingsPrototypeProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 1280, height: 800, scale: fitScale(1280, 800) })

  useEffect(() => {
    const apply = (): boolean => {
      const next = readViewport(viewportRef.current)
      if (!next) return false
      setBox({
        width: next.width,
        height: next.height,
        scale: fitScale(next.width, next.height)
      })
      return true
    }

    apply()
    const ro = new ResizeObserver(() => {
      apply()
    })
    if (viewportRef.current) ro.observe(viewportRef.current)
    window.addEventListener('resize', apply)
    window.addEventListener('focus', apply)
    document.addEventListener('visibilitychange', apply)

    let frames = 0
    let raf = 0
    const tick = (): void => {
      apply()
      frames += 1
      if (frames < 30) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const later = window.setTimeout(apply, 250)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
      window.removeEventListener('focus', apply)
      document.removeEventListener('visibilitychange', apply)
      cancelAnimationFrame(raf)
      window.clearTimeout(later)
    }
  }, [])

  const left = Math.max(0, (box.width - CANVAS_W * box.scale) / 2)
  const top = Math.max(0, (box.height - CANVAS_H * box.scale) / 2)

  return (
    <div ref={viewportRef} className="settings-proto-viewport">
      <div
        className="settings-proto-canvas"
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          transform: `translate(${left}px, ${top}px) scale(${box.scale})`
        }}
      >
        <DashboardFrame {...props} />
      </div>
    </div>
  )
}
