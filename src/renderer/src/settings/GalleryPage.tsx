import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Check, Download, Globe2, RefreshCw, Sparkles } from 'lucide-react'
import type { PetDefinition, PetdexListItem, Snapshot } from '@shared/types'
import { api } from '../api'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  PageHead,
  SearchBox,
  Spinner
} from './ui'

const PAGE_SIZE = 60

const KIND_LABEL: Record<string, string> = {
  character: '角色',
  creature: '生物',
  object: '物件',
  person: '人物',
  animal: '动物',
  robot: '机器人',
  other: '其他'
}

function kindLabel(kind: string): string {
  if (!kind) return '其他'
  return KIND_LABEL[kind] ?? kind
}

function PetdexThumb({ item }: { item: PetdexListItem }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="pp-petdex-thumb pp-petdex-thumb--fallback">
        <Box size={20} />
      </div>
    )
  }
  return (
    <div className="pp-petdex-thumb">
      <img
        src={item.spritesheetUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

export interface GalleryPageProps {
  pets: PetDefinition[]
  onInstalled: (snapshot: Snapshot) => void
  notify: (message: string, tone?: 'default' | 'error') => void
}

export default function GalleryPage({ pets, onInstalled, notify }: GalleryPageProps): JSX.Element {
  const [items, setItems] = useState<PetdexListItem[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [installing, setInstalling] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    return () => {
      alive.current = false
    }
  }, [])

  const load = (): void => {
    setStatus('loading')
    setError('')
    void api
      .fetchPetdexList()
      .then((result) => {
        if (!alive.current) return
        if (result.ok) {
          setItems(result.pets)
          setTotal(result.total)
          setStatus('ready')
        } else {
          setError(result.error || '未知错误')
          setStatus('error')
        }
      })
      .catch((reason: unknown) => {
        if (!alive.current) return
        setError(String(reason))
        setStatus('error')
      })
  }

  useEffect(() => {
    load()
    // 只在第一次打开形象库时联网；之后用刷新按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const key = item.kind || 'other'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (kind !== 'all' && (item.kind || 'other') !== kind) return false
      if (!q) return true
      return `${item.displayName} ${item.author} ${item.slug}`.toLowerCase().includes(q)
    })
  }, [items, query, kind])

  useEffect(() => {
    setVisible(PAGE_SIZE)
  }, [query, kind])

  const installedIds = useMemo(() => new Set(pets.map((pet) => pet.id)), [pets])

  const install = (item: PetdexListItem): void => {
    setInstalling(item.slug)
    void api
      .installPetdexPet(item.zipUrl, item.displayName)
      .then(({ result, snapshot }) => {
        if (!alive.current) return
        if (result.ok) {
          onInstalled(snapshot)
          notify(`已装上「${result.name}」`)
        } else {
          notify(`安装失败：${result.error}`, 'error')
        }
      })
      .catch((reason: unknown) => {
        if (alive.current) notify(`安装失败：${String(reason)}`, 'error')
      })
      .finally(() => {
        if (alive.current) setInstalling(null)
      })
  }

  return (
    <div className="pp-page">
      <PageHead
        eyebrow="PETDEX GALLERY"
        title="形象库"
        subtitle={
          status === 'ready'
            ? `来自 PetDex 的 ${total.toLocaleString()} 只社区形象，点一下就能装进桌面。`
            : '来自 PetDex 的开放社区形象库。'
        }
        actions={
          <Button
            variant="ghost"
            icon={<RefreshCw size={14} className={status === 'loading' ? 'pp-spin' : undefined} />}
            disabled={status === 'loading'}
            onClick={load}
          >
            刷新
          </Button>
        }
      />

      <Callout tone="sage" icon={<Globe2 size={16} />}>
        <strong>打开这个页面会联网</strong>
        <span>
          只会向 petdex.dev 获取公开的形象列表；点安装时才下载对应的精灵图资源。
          不发送任何关于你或你项目的信息。核心监控始终纯本地。
        </span>
      </Callout>

      {status === 'loading' && (
        <div className="pp-gallery-loading">
          <Spinner label="正在连接 PetDex 形象库…" />
        </div>
      )}

      {status === 'error' && (
        <EmptyState
          icon={<Globe2 size={20} />}
          title="暂时连不上形象库"
          description={
            <>
              可能是网络或 PetDex 服务暂时不可用。
              <br />
              <span className="pp-mono">{error}</span>
            </>
          }
          action={
            <Button variant="primary" icon={<RefreshCw size={14} />} onClick={load}>
              再试一次
            </Button>
          }
        />
      )}

      {status === 'ready' && (
        <>
          <div className="pp-library-toolbar pp-library-toolbar--gallery">
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="搜索名字、作者或 slug"
              ariaLabel="搜索 PetDex 形象"
            />
            <div className="pp-kind-filter" role="group" aria-label="形象类型">
              <button
                type="button"
                className={kind === 'all' ? 'is-active' : ''}
                aria-pressed={kind === 'all'}
                onClick={() => setKind('all')}
              >
                全部
                <em>{items.length}</em>
              </button>
              {kinds.slice(0, 6).map(([key, count]) => (
                <button
                  key={key}
                  type="button"
                  className={kind === key ? 'is-active' : ''}
                  aria-pressed={kind === key}
                  onClick={() => setKind(key)}
                >
                  {kindLabel(key)}
                  <em>{count}</em>
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="没有找到匹配的形象"
              description="换个关键词或类型试试。"
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('')
                    setKind('all')
                  }}
                >
                  清空筛选
                </Button>
              }
            />
          ) : (
            <>
              <div className="pp-gallery-grid">
                {filtered.slice(0, visible).map((item) => {
                  const installed = installedIds.has(item.slug)
                  const busy = installing === item.slug
                  return (
                    <article key={item.slug} className="pp-gallery-card">
                      <div className="pp-gallery-card__stage">
                        <PetdexThumb item={item} />
                      </div>
                      <div className="pp-gallery-card__copy">
                        <h3 title={item.displayName}>{item.displayName}</h3>
                        <p>
                          {kindLabel(item.kind)}
                          {item.author ? ` · ${item.author}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={installed ? 'ghost' : 'secondary'}
                        icon={installed ? <Check size={13} /> : <Download size={13} />}
                        loading={busy}
                        disabled={installed}
                        onClick={() => install(item)}
                      >
                        {installed ? '已安装' : busy ? '安装中' : '安装'}
                      </Button>
                    </article>
                  )
                })}
              </div>

              <div className="pp-gallery-more">
                <span>
                  显示 {Math.min(visible, filtered.length)} / {filtered.length} 只
                </span>
                {visible < filtered.length && (
                  <Button variant="secondary" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
                    加载更多
                  </Button>
                )}
              </div>
            </>
          )}

          <div className="pp-gallery-foot">
            <Badge tone="neutral">PetDex</Badge>
            <p>
              社区形象版权归各自作者所有。已经用 PetDex CLI 装在{' '}
              <code>~/.codex/pets</code> 的形象，会自动出现在「我的桌宠」里。
            </p>
          </div>
        </>
      )}
    </div>
  )
}
