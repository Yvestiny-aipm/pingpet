import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BubbleAnchor, BubblePayload, PetState, Snapshot } from '@shared/types'
import { BUBBLE_DEFAULT_ANGLE_DEG, BUBBLE_DEFAULT_DISTANCE, PET_CENTER } from '@shared/defaults'
import { api } from '../api'
import { effectiveBubbleWindowPoint, windowPointToAnchor } from '../bubbleGeometry'
import PetSprite from './PetSprite'

/** 移动超过这个距离才算拖拽，否则视为点击 */
const DRAG_THRESHOLD_PX = 5
/** 多久没有互动后才可能犯困 */
const SLEEPY_AFTER_MS = 90_000
const SLEEPY_CHECK_INTERVAL_MS = 20_000
const SLEEPY_CHANCE = 0.4
const SLEEPY_DURATION_MS = 9_000
/** 点击后 happy 状态的最短持续时间 */
const HAPPY_MIN_DURATION_MS = 2_600

const DEFAULT_ANCHOR: BubbleAnchor = {
  angleDeg: BUBBLE_DEFAULT_ANGLE_DEG,
  distance: BUBBLE_DEFAULT_DISTANCE
}

interface PointerSession {
  pointerId: number
  startScreenX: number
  startScreenY: number
  dragging: boolean
}

interface BubbleDragSession {
  pointerId: number
  /** 按下时指针相对气泡中心的偏移，拖动全程减掉它，让气泡跟手而不是中心硬贴指针 */
  grabDX: number
  grabDY: number
}

export default function PetView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [state, setState] = useState<PetState>('idle')
  const [stateSeq, setStateSeq] = useState(0)
  const [bubble, setBubble] = useState<BubblePayload | null>(null)
  const [bubbleSeq, setBubbleSeq] = useState(0)
  // 拖拽过程中临时覆盖的 anchor（松手才写回 settings）
  const [dragAnchor, setDragAnchor] = useState<BubbleAnchor | null>(null)
  // 气泡挂载后测得真实尺寸，触发一次重渲染让定位/收拢用准确的宽高
  const [measureTick, setMeasureTick] = useState(0)

  const stateTimer = useRef<number | null>(null)
  const bubbleTimer = useRef<number | null>(null)
  const lastInteraction = useRef<number>(Date.now())
  const pointer = useRef<PointerSession | null>(null)
  const bubbleDrag = useRef<BubbleDragSession | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const storedAnchor = snapshot?.settings.bubbleAnchor ?? DEFAULT_ANCHOR
  const activeAnchor = dragAnchor ?? storedAnchor

  /** 立即清掉当前气泡及其自动消失定时器（切换状态时用它顶掉旧气泡） */
  const clearBubble = useCallback(() => {
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = null
    setBubble(null)
  }, [])

  /** 切到一个临时状态，到时自动回到 idle */
  const setTransientState = useCallback((next: PetState, durationMs: number) => {
    if (stateTimer.current !== null) window.clearTimeout(stateTimer.current)
    setStateSeq((seq) => seq + 1)
    setState(next)
    stateTimer.current = window.setTimeout(() => {
      stateTimer.current = null
      setState('idle')
    }, durationMs)
  }, [])

  // 快照 + 气泡订阅
  useEffect(() => {
    let disposed = false
    void api.getSnapshot().then((snap) => {
      if (!disposed) setSnapshot(snap)
    })
    const offSnapshot = api.onSnapshot(setSnapshot)
    const offShow = api.onShowBubble((payload) => {
      // 四种状态互斥：新气泡来先顶掉旧气泡（含它的定时器），再弹新的
      clearBubble()
      setBubble(payload)
      setBubbleSeq((seq) => seq + 1)
      setTransientState(payload.state, Math.max(payload.durationMs, HAPPY_MIN_DURATION_MS))
      bubbleTimer.current = window.setTimeout(() => {
        bubbleTimer.current = null
        setBubble(null)
      }, payload.durationMs)
    })
    const offHide = api.onHideBubble(() => {
      clearBubble()
    })
    // v0.2.1：只切状态、不弹气泡（Agent working 时的安静思考视觉）。
    // 「处理中」是互斥状态之一，切进来时要立即顶掉上一条终态气泡，
    // 否则会出现「思考中的桌宠头上还飘着上一条『任务完成』」的矛盾画面。
    const offSetState = api.onSetState((payload) => {
      clearBubble()
      setTransientState(payload.state, payload.durationMs)
    })
    const offRecheckHover = api.onRecheckHover((point) => {
      const target = document.elementFromPoint(point.x, point.y)
      // 悬停在宠物或气泡上都要让窗口可交互
      api.setInteractive(Boolean(target?.closest('.pet-hitbox') || target?.closest('.bubble')))
    })
    return () => {
      disposed = true
      offSnapshot()
      offShow()
      offHide()
      offSetState()
      offRecheckHover()
    }
  }, [setTransientState, clearBubble])

  // 久未互动时偶尔犯困
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - lastInteraction.current < SLEEPY_AFTER_MS) return
      if (Math.random() < SLEEPY_CHANCE) setTransientState('sleepy', SLEEPY_DURATION_MS)
    }, SLEEPY_CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [setTransientState])

  // 卸载时清掉挂起的定时器
  useEffect(() => {
    return () => {
      if (stateTimer.current !== null) window.clearTimeout(stateTimer.current)
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    }
  }, [])

  // 气泡内容变化后，测一次真实尺寸并重渲染，让定位/越界收拢用准确宽高（首帧 ref 还是 null）
  useLayoutEffect(() => {
    if (bubble) setMeasureTick((t) => t + 1)
  }, [bubble?.text, bubbleSeq])

  // 拖动宠物期间气泡还开着时，按帧重算气泡位置（window.screenX/Y 实时变），
  // 让气泡在宠物贴边的过程中就被墙实时挡住，而不是拖完才跳
  const reflowRaf = useRef(false)
  const scheduleBubbleReflow = useCallback(() => {
    if (reflowRaf.current) return
    reflowRaf.current = true
    window.requestAnimationFrame(() => {
      reflowRaf.current = false
      setMeasureTick((t) => t + 1)
    })
  }, [])

  // ---------- 宠物本体：点击 vs 拖拽 ----------

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    lastInteraction.current = Date.now()
    e.currentTarget.setPointerCapture(e.pointerId)
    pointer.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      dragging: false
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const session = pointer.current
    if (!session || e.pointerId !== session.pointerId) return
    if (!session.dragging) {
      const moved = Math.hypot(e.screenX - session.startScreenX, e.screenY - session.startScreenY)
      if (moved < DRAG_THRESHOLD_PX) return
      session.dragging = true
      // 坐标由主进程用 getCursorScreenPoint 自取，这里只负责触发
      api.petDragStart({ screenX: e.screenX, screenY: e.screenY })
    }
    api.petDragMove({ screenX: e.screenX, screenY: e.screenY })
    // 拖宠物时若气泡开着，实时重算它的越界收拢
    if (bubble) scheduleBubbleReflow()
  }

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const session = pointer.current
    if (!session || e.pointerId !== session.pointerId) return
    pointer.current = null
    lastInteraction.current = Date.now()
    if (session.dragging) {
      api.petDragStop()
    } else if (!cancelled) {
      api.petClicked()
    }
  }

  // ---------- 气泡：360° 拖拽定位 ----------

  const handleBubblePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    lastInteraction.current = Date.now()
    e.currentTarget.setPointerCapture(e.pointerId)
    // 记住按下点相对气泡"当前实际渲染中心"的偏移，拖动全程减掉它
    const rect = e.currentTarget.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    bubbleDrag.current = {
      pointerId: e.pointerId,
      grabDX: e.clientX - centerX,
      grabDY: e.clientY - centerY
    }
    setDragAnchor(activeAnchor)
  }

  const handleBubblePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const session = bubbleDrag.current
    if (!session || e.pointerId !== session.pointerId) return
    e.stopPropagation()
    // 目标气泡中心 = 指针位置 - 抓取偏移（clientX/Y 即窗口内坐标）
    const winX = e.clientX - session.grabDX
    const winY = e.clientY - session.grabDY
    setDragAnchor(windowPointToAnchor(winX, winY))
  }

  const finishBubbleDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const session = bubbleDrag.current
    if (!session || e.pointerId !== session.pointerId) return
    e.stopPropagation()
    bubbleDrag.current = null
    lastInteraction.current = Date.now()
    const finalAnchor = dragAnchor
    if (finalAnchor) {
      // 先本地乐观更新快照，再清 dragAnchor——两个 setState 在同一事件里批处理，
      // 渲染结果和拖动最后一帧完全一致；等主进程快照回传时值相同，不会闪回旧位置。
      setSnapshot((s) =>
        s ? { ...s, settings: { ...s.settings, bubbleAnchor: finalAnchor } } : s
      )
      void api.updateSettings({ bubbleAnchor: finalAnchor })
    }
    setDragAnchor(null)
  }

  // ---------- 鼠标穿透：悬停在宠物/气泡上时窗口才可交互 ----------

  const handleMouseEnter = (): void => {
    api.setInteractive(true)
  }

  const handleMouseLeave = (): void => {
    // 拖拽途中指针可能短暂滑出，不能中途放弃交互
    if (pointer.current?.dragging || bubbleDrag.current) return
    api.setInteractive(false)
  }

  const scale = snapshot?.settings.petScale ?? 1
  // v0.3：从 catalog（snapshot.pets）里找当前宠物；找不到（导入包失效等）回落第一只
  const pets = snapshot?.pets ?? []
  const selectedPet =
    pets.find((p) => p.id === snapshot?.settings.selectedPetId) ?? pets[0] ?? null

  // 气泡渲染位置：拖动中和松手后走【完全同一套算法】——始终 effectiveBubbleWindowPoint
  // （极坐标定位 + 环钳制 + 越界收拢）。这样拖到哪就定到哪，松手不重算、不跳；
  // 越界收拢在拖动时就实时生效，拖到屏幕边就当场被挡住。
  void measureTick // 让测量后的重渲染重新计算下面的位置
  let bubbleLeft = PET_CENTER.x
  let bubbleTop = PET_CENTER.y
  if (bubble) {
    const bw = bubbleRef.current?.offsetWidth ?? 160
    const bh = bubbleRef.current?.offsetHeight ?? 44
    // 用窗口【实时】屏幕坐标（window.screenX/Y）而不是弹气泡时的快照，
    // 这样桌宠移动到边角后气泡也能正确收拢；displayBounds 仍用主进程给的快照。
    const liveRect = {
      x: window.screenX,
      y: window.screenY,
      width: bubble.windowRect.width,
      height: bubble.windowRect.height
    }
    const pt = effectiveBubbleWindowPoint(activeAnchor, bw, bh, liveRect, bubble.displayBounds)
    bubbleLeft = pt.x
    bubbleTop = pt.y
  }

  return (
    <div className="pet-root">
      {bubble && (
        <div
          className="bubble-slot"
          style={{ transform: `translate(${bubbleLeft}px, ${bubbleTop}px)` }}
        >
          <div
            ref={bubbleRef}
            className={`bubble${dragAnchor ? ' bubble--dragging' : ''}`}
            key={bubbleSeq}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerDown={handleBubblePointerDown}
            onPointerMove={handleBubblePointerMove}
            onPointerUp={finishBubbleDrag}
            onPointerCancel={finishBubbleDrag}
          >
            {bubble.text}
          </div>
        </div>
      )}
      <div
        className="pet-hitbox"
        style={{ transform: `scale(${scale})` }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
      >
        <div key={stateSeq} className={`pet-anim pet-anim--${state}`}>
          {selectedPet && <PetSprite pet={selectedPet} state={state} />}
        </div>
        {state === 'sleepy' && <div className="pet-emote pet-emote--zzz">z z</div>}
        {state === 'attention' && <div className="pet-emote pet-emote--alert">!</div>}
        {state === 'thinking' && <div className="pet-emote pet-emote--think">…</div>}
        {state === 'failed' && <div className="pet-emote pet-emote--fail">×</div>}
      </div>
    </div>
  )
}
