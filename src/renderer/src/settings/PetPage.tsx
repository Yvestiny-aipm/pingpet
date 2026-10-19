import { useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  Globe2,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { PET_SCALE_MAX, PET_SCALE_MIN } from '@shared/defaults'
import type { PetDefinition, Settings, Snapshot } from '@shared/types'
import PetSprite from '../components/PetSprite'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHead,
  Row,
  SearchBox,
  SectionHead,
  Segmented,
  Switch
} from './ui'

type PetTab = 'all' | 'official' | 'imported'

const TABS: ReadonlyArray<{ value: PetTab; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'official', label: '内置' },
  { value: 'imported', label: '我导入的' }
]

export interface PetPageProps {
  snapshot: Snapshot
  displayScale: number
  packBusy: boolean
  onPatch: (partial: Partial<Settings>) => void
  onSelectPet: (id: string) => void
  onScaleDraft: (value: number) => void
  onScaleCommit: (value: number) => void
  onImport: () => void
  onReveal: () => void
  onRename: (pet: PetDefinition) => void
  onDelete: (pet: PetDefinition) => void
  onOpenGallery: () => void
  onToggleVisible: () => void
}

export default function PetPage(props: PetPageProps): JSX.Element {
  const { snapshot, displayScale } = props
  const { settings, pets } = snapshot
  const [tab, setTab] = useState<PetTab>('all')
  const [query, setQuery] = useState('')
  const sizeRef = useRef<HTMLDivElement | null>(null)

  const currentPet =
    pets.find((pet) => pet.id === settings.selectedPetId) ?? pets[0] ?? null
  const importedCount = pets.filter((pet) => pet.source === 'imported').length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pets.filter((pet) => {
      if (tab === 'official' && pet.source !== 'official') return false
      if (tab === 'imported' && pet.source !== 'imported') return false
      if (!q) return true
      return `${pet.name} ${pet.description}`.toLowerCase().includes(q)
    })
  }, [pets, tab, query])

  const focusSize = (): void => {
    sizeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      sizeRef.current?.querySelector<HTMLInputElement>('input[type="range"]')?.focus()
    }, 320)
  }

  return (
    <div className="pp-page">
      <PageHead
        title="我的桌宠"
        subtitle="挑一只喜欢的小伙伴，让它安静住在你的桌面。"
        actions={
          <Button variant="primary" icon={<Plus size={15} />} loading={props.packBusy} onClick={props.onImport}>
            {props.packBusy ? '导入中' : '导入桌宠'}
          </Button>
        }
      />

      {currentPet && (
        <section className="pp-hero">
          <div className="pp-hero__copy">
            <h2>{currentPet.name}</h2>
            <p>{currentPet.description}</p>
            <div className="pp-hero__status">
              <Badge tone="sage" dot>
                当前正在使用
              </Badge>
              <span>
                {currentPet.source === 'official' ? '内置形象' : '导入形象'} · 桌面显示{' '}
                {Math.round(displayScale * 100)}%
              </span>
            </div>
            <div className="pp-hero__actions">
              <Button variant="primary" onClick={focusSize}>
                调整大小
              </Button>
              <Button
                variant="ghost"
                icon={settings.petVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                onClick={props.onToggleVisible}
              >
                {settings.petVisible ? '藏起桌宠' : '叫回桌宠'}
              </Button>
            </div>
          </div>
          <div className="pp-hero__stage">
            <div className="pp-hero__speech">你忙你的，我在这里。</div>
            <div className="pp-hero__halo" />
            <div className="pp-hero__pet">
              <PetSprite pet={currentPet} state="idle" />
            </div>
            <div className="pp-hero__shadow" />
          </div>
        </section>
      )}

      <section className="pp-section">
        <SectionHead
          title="形象库"
          hint={`官方内置、一张图导入、皮肤包和 PetDex 形象都收在这里。共 ${pets.length} 个，其中 ${importedCount} 个已导入。`}
          action={<span className="pp-count">{filtered.length} / {pets.length}</span>}
        />

        <div className="pp-library-toolbar">
          <Segmented options={TABS} value={tab} onChange={setTab} label="形象分类" />
          <SearchBox value={query} onChange={setQuery} placeholder="搜索形象" ariaLabel="搜索形象" />
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Plus size={20} />}
            title={query ? '没有找到这只形象' : '还没有导入过形象'}
            description={
              query
                ? '换个关键词试试，或者切换到「全部」。'
                : '选一张 PNG / WebP / SVG，或导入一个皮肤包文件夹。'
            }
            action={
              <Button variant="primary" icon={<Plus size={15} />} onClick={props.onImport}>
                导入形象
              </Button>
            }
          />
        ) : (
          <div className="pp-pet-grid">
            {filtered.map((pet) => {
              const selected = pet.id === settings.selectedPetId
              return (
                <article
                  key={pet.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  className={`pp-pet-card${selected ? ' is-selected' : ''}`}
                  onClick={() => props.onSelectPet(pet.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      props.onSelectPet(pet.id)
                    }
                  }}
                >
                  <div className="pp-pet-card__top">
                    <Badge tone={pet.source === 'official' ? 'neutral' : 'sage'}>
                      {pet.source === 'official' ? '内置' : '已导入'}
                    </Badge>
                    {selected && (
                      <span className="pp-pet-card__check" aria-label="当前使用">
                        <Check size={12} strokeWidth={2.6} />
                      </span>
                    )}
                  </div>
                  <div className="pp-pet-card__stage">
                    <PetSprite pet={pet} state="idle" />
                  </div>
                  <div className="pp-pet-card__name">{pet.name}</div>
                  <div className="pp-pet-card__desc">{pet.description}</div>
                  {pet.source === 'imported' && (
                    <div
                      className="pp-pet-card__actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        title="重命名"
                        aria-label={`重命名 ${pet.name}`}
                        onClick={() => props.onRename(pet)}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        title="删除"
                        aria-label={`删除 ${pet.name}`}
                        onClick={() => props.onDelete(pet)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </article>
              )
            })}
            <button type="button" className="pp-pet-card pp-pet-card--add" onClick={props.onImport}>
              <span className="pp-pet-card__add-icon">
                <Plus size={22} strokeWidth={1.6} />
              </span>
              <span className="pp-pet-card__name">导入形象</span>
              <span className="pp-pet-card__desc">一张图或皮肤包</span>
            </button>
          </div>
        )}
      </section>

      <section className="pp-gallery-banner">
        <div className="pp-gallery-banner__icon">
          <Globe2 size={20} />
        </div>
        <div className="pp-gallery-banner__copy">
          <strong>3400+ 社区形象，来自 PetDex</strong>
          <span>角色、生物、物件都有。看中哪只，点一下就能装进桌面。</span>
        </div>
        <Button variant="secondary" icon={<ChevronRight size={15} />} onClick={props.onOpenGallery}>
          去逛逛
        </Button>
      </section>

      <section className="pp-section" ref={sizeRef}>
        <SectionHead title="桌面显示" hint="这些设置会立即作用到桌面上的那只小伙伴。" />
        <Card padded={false} className="pp-settings-card">
          <Row
            title="桌面大小"
            desc={`${Math.round(displayScale * 100)}% · 缩放只影响宠物本体，不影响气泡位置`}
            control={
              <div className="pp-slider">
                <span>小</span>
                <input
                  type="range"
                  aria-label="桌宠大小"
                  min={PET_SCALE_MIN}
                  max={PET_SCALE_MAX}
                  step={0.05}
                  value={displayScale}
                  onChange={(event) => props.onScaleDraft(Number(event.target.value))}
                  onPointerUp={(event) => props.onScaleCommit(Number(event.currentTarget.value))}
                  onPointerCancel={() => props.onScaleDraft(displayScale)}
                  onBlur={(event) => props.onScaleCommit(Number(event.currentTarget.value))}
                  onKeyUp={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      props.onScaleCommit(Number(event.currentTarget.value))
                    }
                  }}
                />
                <span>大</span>
                <output>{Math.round(displayScale * 100)}%</output>
              </div>
            }
          />
          <Row
            title="显示桌宠"
            desc="需要专注时可以暂藏起来。隐藏期间不会弹任何气泡。"
            control={
              <Switch
                label="显示桌宠"
                checked={settings.petVisible}
                onChange={props.onToggleVisible}
              />
            }
          />
          <Row
            title="导入图片时自动去背景"
            desc="黑底、白底等纯色背景会在本机抠成透明；复杂背景保持原样。"
            control={
              <Switch
                label="导入图片时自动去背景"
                checked={settings.autoRemoveBackground}
                onChange={(value) => props.onPatch({ autoRemoveBackground: value })}
              />
            }
          />
          <Row
            title="导入目录"
            desc="已导入的皮肤包都保存在本机，可以在这里打开查看。"
            control={
              <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={props.onReveal}>
                在 Finder 中打开
              </Button>
            }
          />
        </Card>
      </section>
    </div>
  )
}
