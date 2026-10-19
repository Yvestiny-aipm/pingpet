import { useMemo } from 'react'
import { Compass, MessageCircle, RotateCcw } from 'lucide-react'
import {
  BUBBLE_DEFAULT_ANGLE_DEG,
  BUBBLE_DEFAULT_DISTANCE
} from '@shared/defaults'
import type { PetDefinition, Settings } from '@shared/types'
import PetSprite from '../components/PetSprite'
import {
  Badge,
  Button,
  Card,
  PageHead,
  Row,
  SectionHead,
  Segmented,
  Switch
} from './ui'

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 60, label: '1 分钟' },
  { value: 180, label: '3 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' }
]

const ANCHOR_PRESETS: ReadonlyArray<{ angleDeg: number; label: string }> = [
  { angleDeg: 270, label: '头顶' },
  { angleDeg: 0, label: '右侧' },
  { angleDeg: 180, label: '左侧' },
  { angleDeg: 90, label: '下方' }
]

export interface BubblePageProps {
  pet: PetDefinition | null
  settings: Settings
  onPatch: (partial: Partial<Settings>) => void
}

export default function BubblePage({ pet, settings, onPatch }: BubblePageProps): JSX.Element {
  const frequencyOptions = useMemo(() => {
    const custom = settings.bubbleFrequencySeconds
    if (FREQUENCY_OPTIONS.some((option) => option.value === custom)) return FREQUENCY_OPTIONS
    return [
      ...FREQUENCY_OPTIONS,
      { value: custom, label: `${Math.max(1, Math.round(custom / 60))} 分钟` }
    ]
  }, [settings.bubbleFrequencySeconds])

  const anchor = settings.bubbleAnchor
  // 预览里把真实距离缩小到 0.62 倍，避免气泡跑出卡片
  const previewDistance = Math.min(110, Math.max(84, anchor.distance * 0.72))
  const rad = (anchor.angleDeg * Math.PI) / 180
  const bubbleX = 160 + Math.cos(rad) * previewDistance
  const bubbleY = 132 + Math.sin(rad) * previewDistance

  const setPreset = (angleDeg: number): void => {
    onPatch({ bubbleAnchor: { angleDeg, distance: anchor.distance } })
  }

  const resetAnchor = (): void => {
    onPatch({
      bubbleAnchor: { angleDeg: BUBBLE_DEFAULT_ANGLE_DEG, distance: BUBBLE_DEFAULT_DISTANCE }
    })
  }

  return (
    <div className="pp-page">
      <PageHead
        eyebrow="COMPANION BUBBLES"
        title="陪伴气泡"
        subtitle="偶尔说一句，平时安静陪着。和 Agent 的工作提醒是两套独立的气泡。"
      />

      <section className="pp-bubble-preview">
        <div className="pp-bubble-preview__stage">
          <div
            className="pp-bubble-preview__bubble"
            style={{ left: bubbleX, top: bubbleY }}
          >
            喝口水，休息一下吧。
          </div>
          <div className="pp-bubble-preview__pet">
            {pet ? <PetSprite pet={pet} state="idle" /> : null}
          </div>
          <div className="pp-bubble-preview__floor" />
        </div>
        <div className="pp-bubble-preview__meta">
          <Badge tone={settings.bubblesEnabled ? 'sage' : 'neutral'} dot>
            {settings.bubblesEnabled ? '陪伴气泡已开' : '陪伴气泡已关'}
          </Badge>
          <div>
            <strong>大约每 {Math.max(1, Math.round(settings.bubbleFrequencySeconds / 60))} 分钟</strong>
            <span>会轻轻冒一句，带一点随机抖动，不机械。</span>
          </div>
          <p>预览只演示气泡相对桌宠的位置，真实气泡可以随手拖到任意角度。</p>
        </div>
      </section>

      <Card padded={false} className="pp-settings-card">
        <Row
          title="偶尔冒出小气泡"
          desc="关闭后桌宠完全安静，只保留 Agent 停机提醒。"
          control={
            <Switch
              label="陪伴气泡"
              checked={settings.bubblesEnabled}
              onChange={(value) => onPatch({ bubblesEnabled: value })}
            />
          }
        />
        <Row
          title="出现频率"
          desc="间隔会上下浮动 35%，最短不低于 15 秒。"
          control={
            <Segmented
              options={frequencyOptions}
              value={settings.bubbleFrequencySeconds}
              onChange={(value) => onPatch({ bubbleFrequencySeconds: value })}
              label="气泡出现频率"
            />
          }
        />
      </Card>

      <section className="pp-section">
        <SectionHead
          title="气泡位置"
          hint="选中一个方向，或直接在桌面上拖动真实气泡，松手后会自动记住。"
          action={
            <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={resetAnchor}>
              恢复默认
            </Button>
          }
        />
        <Card>
          <div className="pp-anchor-row">
            <div className="pp-anchor-compass">
              <Compass size={20} />
              <span>{Math.round(anchor.angleDeg)}°</span>
            </div>
            <div className="pp-anchor-presets">
              {ANCHOR_PRESETS.map((preset) => {
                const active = Math.abs(anchor.angleDeg - preset.angleDeg) < 1
                return (
                  <button
                    key={preset.angleDeg}
                    type="button"
                    className={`pp-anchor-preset${active ? ' is-active' : ''}`}
                    onClick={() => setPreset(preset.angleDeg)}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
            <span className="pp-anchor-distance">
              距离 {Math.round(anchor.distance)} px
            </span>
          </div>
          <div className="pp-anchor-hint">
            <MessageCircle size={15} />
            <p>
              气泡始终跟着桌宠。贴到屏幕边缘时会自动收拢，不会被裁到屏幕外面。
              也可以在桌面上按住气泡直接拖动，位置会保存在本机。
            </p>
          </div>
        </Card>
      </section>
    </div>
  )
}
