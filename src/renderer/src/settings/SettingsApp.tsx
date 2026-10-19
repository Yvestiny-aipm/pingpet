import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Images,
  MessageCircle,
  Moon,
  PawPrint,
  Settings2,
  Sparkles,
  Sun,
  X
} from 'lucide-react'
import { AGENT_SOURCE_LIST } from '@shared/agents'
import { AGENT_ENVS } from '@shared/types'
import type {
  AgentEnv,
  AgentEventKind,
  AgentSource,
  AiTestResult,
  MonitoringEnvsKey,
  PetDefinition,
  Settings,
  Snapshot
} from '@shared/types'
import { api } from '../api'
import { removeBackgroundFromDataUrl } from '../removeBackground'
import AgentPage from './AgentPage'
import AiPage from './AiPage'
import BubblePage from './BubblePage'
import GalleryPage from './GalleryPage'
import GeneralPage from './GeneralPage'
import PetPage from './PetPage'
import type { AiProviderChoice, PageKey, ToastState } from './types'
import { Button, Dialog } from './ui'
import logoUrl from '../assets/logo.png'
import './settings.css'

const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'

interface NavItem {
  key: PageKey
  label: string
  icon: JSX.Element
}

const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  {
    label: '桌面',
    items: [
      { key: 'pet', label: '桌宠', icon: <PawPrint size={17} /> },
      { key: 'gallery', label: '形象库', icon: <Images size={17} /> },
      { key: 'bubble', label: '陪伴气泡', icon: <MessageCircle size={17} /> }
    ]
  },
  {
    label: '能力',
    items: [
      { key: 'agent', label: 'Agent 监控', icon: <Activity size={17} /> },
      { key: 'ai', label: 'AI 总结', icon: <Sparkles size={17} /> }
    ]
  },
  {
    label: '应用',
    items: [{ key: 'general', label: '通用设置', icon: <Settings2 size={17} /> }]
  }
]

interface DialogState {
  type: 'rename' | 'delete'
  pet: PetDefinition
}

export default function SettingsApp(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [page, setPage] = useState<PageKey>('pet')
  const [scaleDraft, setScaleDraft] = useState<number | null>(null)
  const [packBusy, setPackBusy] = useState(false)
  const [aiTestBusy, setAiTestBusy] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<AiTestResult | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const theme = snapshot?.settings.theme ?? 'light'
  const [renameDraft, setRenameDraft] = useState('')
  const toastTimer = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false
    void api.getSnapshot().then((next) => {
      if (!disposed) setSnapshot(next)
    })
    const off = api.onSnapshot(setSnapshot)
    return () => {
      disposed = true
      off()
    }
  }, [])

  useEffect(() => {
    document.title = 'PingPet 设置'
  }, [])

  // 页面切换时回到顶部：所有页面共用一个滚动容器，不重置会停在上一页的滚动位置
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [page])

  // 主题写到 body，CSS 变量与原生表单控件一起切换
  useEffect(() => {
    document.body.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const notify = useCallback((message: string, tone: 'default' | 'error' = 'default'): void => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), message, tone })
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null
      setToast(null)
    }, 3400)
  }, [])

  const patch = useCallback(
    (partial: Partial<Settings>): void => {
      void api
        .updateSettings(partial)
        .then(setSnapshot)
        .catch((reason: unknown) => notify(`设置没有保存成功：${String(reason)}`, 'error'))
    },
    [notify]
  )

  const closeDialog = useCallback(() => setDialog(null), [])

  const handleSelectPet = (id: string): void => {
    void api
      .selectPet(id)
      .then(setSnapshot)
      .catch((reason: unknown) => notify(`切换形象失败：${String(reason)}`, 'error'))
  }

  const handleScaleDraft = (value: number): void => setScaleDraft(value)

  const handleScaleCommit = (value = scaleDraft): void => {
    if (value === null || !snapshot) return
    setScaleDraft(null)
    if (value !== snapshot.settings.petScale) patch({ petScale: value })
  }

  const toggleEnv = (key: MonitoringEnvsKey, current: AgentEnv[], env: AgentEnv): void => {
    const set = new Set(current)
    if (set.has(env)) set.delete(env)
    else set.add(env)
    const nextEnvs = AGENT_ENVS.filter((item) => set.has(item))
    patch({ [key]: nextEnvs } as Partial<Settings>)
  }

  const handleImport = (): void => {
    setPackBusy(true)
    void (async () => {
      try {
        const picked = await api.pickSkin()
        if (picked.kind === 'canceled') return
        if (picked.kind === 'error') {
          notify(picked.error || '导入失败', 'error')
          return
        }
        if (picked.kind === 'pack' || picked.kind === 'petdex') {
          setSnapshot(picked.snapshot)
          notify('新形象已经装好，并切换过去了')
          return
        }
        if (!snapshot) return
        let dataUrl = picked.dataUrl
        if (snapshot.settings.autoRemoveBackground && picked.ext !== '.svg') {
          const cut = await removeBackgroundFromDataUrl(picked.dataUrl)
          if (cut) dataUrl = cut
        }
        const result = await api.savePetImage(dataUrl, picked.name)
        if (result.ok) {
          setSnapshot(result.snapshot)
          notify('图片已经变成桌宠了')
        } else if (!result.canceled) {
          notify(result.error || '导入失败', 'error')
        }
      } catch (reason) {
        notify(`导入失败：${String(reason)}`, 'error')
      } finally {
        setPackBusy(false)
      }
    })()
  }

  const handleDelete = (): void => {
    if (!dialog || dialog.type !== 'delete') return
    const target = dialog.pet
    void api
      .deleteImportedPetPack(target.id)
      .then((next) => {
        setSnapshot(next)
        notify(`已删除「${target.name}」`)
      })
      .catch((reason: unknown) => notify(`删除失败：${String(reason)}`, 'error'))
      .finally(closeDialog)
  }

  const handleRename = (): void => {
    if (!dialog || dialog.type !== 'rename') return
    const name = renameDraft.trim()
    if (name.length < 1) return
    if (name.length > 30) {
      notify('名字要 1–30 个字', 'error')
      return
    }
    if (name === dialog.pet.name) {
      closeDialog()
      return
    }
    const target = dialog.pet
    void api
      .renameImportedPetPack(target.id, name)
      .then((next) => {
        setSnapshot(next)
        notify('名字已经改好')
      })
      .catch((reason: unknown) => notify(`改名失败：${String(reason)}`, 'error'))
      .finally(closeDialog)
  }

  const handleTestAi = (): void => {
    setAiTestBusy(true)
    setAiTestResult(null)
    void api
      .testAiSummary()
      .then(setAiTestResult)
      .catch((reason: unknown) => setAiTestResult({ ok: false, error: String(reason) }))
      .finally(() => setAiTestBusy(false))
  }

  const applyAiProvider = (choice: AiProviderChoice): void => {
    if (!snapshot) return
    setAiTestResult(null)
    if (choice === 'anthropic') {
      patch({ aiProvider: 'anthropic' })
    } else if (choice === 'siliconflow') {
      patch({
        aiProvider: 'openai',
        aiOpenaiBaseUrl: SILICONFLOW_BASE_URL,
        aiOpenaiModel: snapshot.settings.aiOpenaiModel || 'deepseek-ai/DeepSeek-V3.1'
      })
    } else {
      patch({
        aiProvider: 'openai',
        aiOpenaiBaseUrl:
          snapshot.settings.aiOpenaiBaseUrl === SILICONFLOW_BASE_URL
            ? 'https://api.openai.com/v1'
            : snapshot.settings.aiOpenaiBaseUrl
      })
    }
  }

  const toggleVisible = (): void => {
    if (!snapshot) return
    if (snapshot.settings.petVisible) {
      void api.hidePet()
      notify('桌宠已经藏起来了，随时可以在这里叫回来')
    } else {
      void api.showPet()
      notify('桌宠回来了')
    }
  }

  const resetPosition = (): void => {
    void api.resetPetPosition()
    notify('已挪回主屏右下角')
  }

  const openGallery = (): void => {
    setPage('gallery')
  }

  if (!snapshot) {
    return (
      <div className="pp-boot">
        <img src={logoUrl} alt="" />
        <span>正在打开 PingPet 设置…</span>
      </div>
    )
  }

  const { settings, pets, appVersion } = snapshot
  const displayScale = scaleDraft ?? settings.petScale
  const aiProviderChoice: AiProviderChoice =
    settings.aiProvider === 'anthropic'
      ? 'anthropic'
      : settings.aiOpenaiBaseUrl === SILICONFLOW_BASE_URL
        ? 'siliconflow'
        : 'openai'
  const currentPet = pets.find((pet) => pet.id === settings.selectedPetId) ?? pets[0] ?? null
  const agentCount = AGENT_SOURCE_LIST.filter((meta) => settings[meta.enabledKey]).length

  return (
    <div className="pp-app">
      <div className="pp-titlebar" aria-hidden="true" />

      <aside className="pp-sidebar">
        <div className="pp-brand">
          <img src={logoUrl} alt="" className="pp-brand__logo" />
          <div>
            <strong>PingPet</strong>
            <span>桌面小伙伴</span>
          </div>
        </div>

        <nav className="pp-nav" aria-label="设置导航">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="pp-nav__group">
              <div className="pp-nav__label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`pp-nav__item${page === item.key ? ' is-active' : ''}`}
                  aria-current={page === item.key ? 'page' : undefined}
                  onClick={() => setPage(item.key)}
                >
                  <span className="pp-nav__icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.key === 'agent' && agentCount > 0 && (
                    <span className="pp-nav__count">{agentCount}</span>
                  )}
                  {item.key === 'ai' && settings.aiSummaryEnabled && (
                    <span className="pp-nav__dot" aria-label="已开启" />
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="pp-theme-toggle" role="group" aria-label="主题">
          <button
            type="button"
            className={theme === 'light' ? 'is-active' : ''}
            aria-pressed={theme === 'light'}
            onClick={() => patch({ theme: 'light' })}
          >
            <Sun size={13} />
            浅色
          </button>
          <button
            type="button"
            className={theme === 'dark' ? 'is-active' : ''}
            aria-pressed={theme === 'dark'}
            onClick={() => patch({ theme: 'dark' })}
          >
            <Moon size={13} />
            深色
          </button>
        </div>

        <button type="button" className="pp-status-card" onClick={toggleVisible}>
          <span className={`pp-status-card__dot${settings.petVisible ? ' is-live' : ''}`} />
          <span className="pp-status-card__copy">
            <strong>{settings.petVisible ? '桌宠正在陪伴' : '桌宠已隐藏'}</strong>
            <em>v{appVersion} · 点击{settings.petVisible ? '隐藏' : '唤回'}</em>
          </span>
        </button>
      </aside>

      <main className="pp-main">
        <div className="pp-scroll" ref={scrollRef}>
          {page === 'pet' && (
            <PetPage
              snapshot={snapshot}
              displayScale={displayScale}
              packBusy={packBusy}
              onPatch={patch}
              onSelectPet={handleSelectPet}
              onScaleDraft={handleScaleDraft}
              onScaleCommit={handleScaleCommit}
              onImport={handleImport}
              onReveal={() => void api.revealPetPacksFolder()}
              onRename={(pet) => {
                setRenameDraft(pet.name)
                setDialog({ type: 'rename', pet })
              }}
              onDelete={(pet) => setDialog({ type: 'delete', pet })}
              onOpenGallery={openGallery}
              onToggleVisible={toggleVisible}
            />
          )}

          {page === 'gallery' && (
            <GalleryPage
              pets={pets}
              onInstalled={setSnapshot}
              notify={notify}
            />
          )}

          {page === 'bubble' && (
            <BubblePage pet={currentPet} settings={settings} onPatch={patch} />
          )}

          {page === 'agent' && (
            <AgentPage
              snapshot={snapshot}
              onPatch={patch}
              onToggleEnv={toggleEnv}
              onSimulate={(source: AgentSource, kind: AgentEventKind) => api.agentSimulate(source, kind)}
            />
          )}

          {page === 'ai' && (
            <AiPage
              settings={settings}
              providerChoice={aiProviderChoice}
              testBusy={aiTestBusy}
              testResult={aiTestResult}
              onPatch={patch}
              onProvider={applyAiProvider}
              onTest={handleTestAi}
              onClearTest={() => setAiTestResult(null)}
            />
          )}

          {page === 'general' && (
            <GeneralPage
              snapshot={snapshot}
              onPatch={patch}
              onResetPosition={resetPosition}
              onToggleVisible={toggleVisible}
              onReveal={() => void api.revealPetPacksFolder()}
              onQuit={() => void api.quitApp()}
            />
          )}
        </div>
      </main>

      {toast && (
        <div className={`pp-toast${toast.tone === 'error' ? ' is-error' : ''}`} role="status">
          <span>{toast.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {dialog?.type === 'rename' && (
        <Dialog
          title="给形象改个名字"
          description={`「${dialog.pet.name}」会以新名字显示在形象库里。`}
          onClose={closeDialog}
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!renameDraft.trim() || renameDraft.trim().length > 30}
                onClick={handleRename}
              >
                保存名字
              </Button>
            </>
          }
        >
          <input
            className="pp-input pp-input--full"
            value={renameDraft}
            maxLength={30}
            autoFocus
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleRename()
            }}
          />
          <p className="pp-dialog__hint">1–30 个字。只改显示名，不动皮肤包目录。</p>
        </Dialog>
      )}

      {dialog?.type === 'delete' && (
        <Dialog
          title="删除这个形象？"
          description={`「${dialog.pet.name}」的皮肤包会从本机删除，这个操作不能撤销。`}
          onClose={closeDialog}
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog}>
                保留
              </Button>
              <Button variant="danger" onClick={handleDelete}>
                删除形象
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}
