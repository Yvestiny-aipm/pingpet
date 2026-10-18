import { useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Archive,
  ArrowRight,
  Bell,
  Box,
  CircleDot,
  Folder,
  Globe2,
  History,
  Home,
  Library,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  Share2,
  SlidersHorizontal,
  Sparkles,
  UsersRound
} from 'lucide-react'
import { AGENT_SOURCE_LIST, AGENT_SOURCES } from '@shared/agents'
import {
  CODEX_CANDIDATE_SETTING_ITEMS,
  CODEX_CANDIDATE_SETTINGS_CARD_HINT,
  CODEX_CANDIDATE_SETTINGS_CARD_TITLE,
  type CodexCandidateUiSettingKey
} from '@shared/codexCandidateSettings'
import { PET_SCALE_MAX, PET_SCALE_MIN } from '@shared/defaults'
import { AGENT_ENVS } from '@shared/types'
import type {
  AgentEnv,
  AgentEventKind,
  AgentMonitorEvent,
  MonitoringEnabledKey,
  MonitoringEnvsKey,
  PetDefinition,
  Settings
} from '@shared/types'
import PetSprite from '../components/PetSprite'
import avatarUrl from './avatar.png'
import type { AiProviderChoice, SettingsPrototypeProps } from './SettingsPrototype'

type PageKey = 'pet' | 'bubble' | 'agent' | 'ai' | 'about'
type PetTab = 'all' | 'official' | 'imported'

const AGENT_KIND_LABEL: Record<AgentEventKind, string> = {
  working: '处理中',
  done: '完成',
  needs_attention: '需要你',
  failed: '出错/中断'
}

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function sourceLabel(source: PetDefinition['source']): string {
  return source === 'imported' ? '已导入' : '官方'
}

const ease = [0.16, 1, 0.3, 1] as const

const RAIL: Array<{ icon: typeof Home; page: PageKey }> = [
  { icon: Home, page: 'pet' },
  { icon: Globe2, page: 'pet' },
  { icon: Sparkles, page: 'ai' },
  { icon: Share2, page: 'bubble' },
  { icon: PanelLeft, page: 'agent' },
  { icon: Box, page: 'about' }
]

const HOME_ROWS: Array<{ page: PageKey; icon: typeof SlidersHorizontal; label: string; count?: string }> = [
  { page: 'pet', icon: SlidersHorizontal, label: '桌宠', count: '3' },
  { page: 'bubble', icon: Library, label: '气泡' },
  { page: 'agent', icon: UsersRound, label: 'Agent 监控' }
]

const ABILITY_ROWS: Array<{ page: PageKey; icon: typeof Sparkles; label: string; count?: string }> = [
  { page: 'ai', icon: Sparkles, label: 'AI 总结', count: '1' },
  { page: 'about', icon: CircleDot, label: '关于' }
]

const ENV_LABEL: Record<AgentEnv, string> = {
  terminal: '终端',
  vscode: 'VS Code',
  desktop: '客户端'
}

const FREQ = [
  { value: 60, label: '大约每 1 分钟' },
  { value: 180, label: '大约每 3 分钟' },
  { value: 300, label: '大约每 5 分钟' },
  { value: 600, label: '大约每 10 分钟' }
]

function CountBadge({ value }: { value: string }): JSX.Element {
  return (
    <span className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-[16px] font-normal text-[#777]">
      {value}
    </span>
  )
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return <div className="text-[24px] font-normal leading-none tracking-[-0.03em] text-[#777]">{children}</div>
}

function Stat({ label, value, mint }: { label: string; value: string; mint?: boolean }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[16px] text-[#777]">{label}</div>
      {mint ? (
        <div className="mt-2 inline-flex h-10 items-center rounded-[12px] bg-[rgba(135,225,203,0.16)] px-3 text-[18px] font-semibold text-[#8DEFD2]">
          {value}
        </div>
      ) : (
        <div className="mt-2 text-[22px] font-medium tracking-[-0.04em] text-[#111]">{value}</div>
      )}
    </div>
  )
}

function TrafficLight({ color }: { color: string }): JSX.Element {
  return (
    <span
      className="h-6 w-6 rounded-full"
      style={{
        background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85), ${color})`,
        border: '1px solid rgba(255,255,255,0.35)',
        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.55), 0 4px 8px rgba(0,0,0,0.10)'
      }}
    />
  )
}

function SearchField({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}): JSX.Element {
  return (
    <label className="mt-[24px] flex h-[72px] w-full items-center gap-[18px] rounded-[20px] border border-white/22 bg-white/[0.035] px-[23px]">
      <Search size={24} color="#111111" strokeWidth={1.7} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-full w-full bg-transparent text-[24px] text-[#111] outline-none placeholder:text-[#777]"
      />
    </label>
  )
}

function FadeIn({
  children,
  delay,
  className
}: {
  children: ReactNode
  delay: number
  className?: string
}): JSX.Element {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.72, delay, ease }}
    >
      {children}
    </motion.div>
  )
}

export default function DashboardFrame(props: SettingsPrototypeProps): JSX.Element {
  const { snapshot, displayScale, onPatch, onSelectPet } = props
  const { settings, pets, appVersion, agent } = snapshot
  const [page, setPage] = useState<PageKey>('pet')
  const [railIndex, setRailIndex] = useState(0)
  const [petTab, setPetTab] = useState<PetTab>('all')
  const [treeQuery, setTreeQuery] = useState('')
  const [paneQuery, setPaneQuery] = useState('')

  const currentPet = pets.find((p) => p.id === settings.selectedPetId) ?? pets[0]
  const officialPets = pets.filter((p) => p.source === 'official')
  const importedPets = pets.filter((p) => p.source === 'imported')
  const openAgentCount = AGENT_SOURCE_LIST.filter((m) => settings[m.enabledKey]).length

  const filteredPets = useMemo(() => {
    return pets.filter((p) => {
      if (petTab === 'official' && p.source !== 'official') return false
      if (petTab === 'imported' && p.source !== 'imported') return false
      if (paneQuery && !`${p.name}${p.description}`.includes(paneQuery)) return false
      return true
    })
  }, [pets, petTab, paneQuery])

  const go = (next: PageKey, rail?: number): void => {
    setPage(next)
    if (rail !== undefined) setRailIndex(rail)
    else {
      const idx = RAIL.findIndex((r) => r.page === next)
      if (idx >= 0) setRailIndex(idx)
    }
    setPaneQuery('')
  }

  return (
    <div className="relative h-[2048px] w-[2240px] overflow-hidden bg-[#9f9f9f] text-[#111]">
      <UtilityRail
        selected={railIndex}
        onSelect={(i) => {
          setRailIndex(i)
          go(RAIL[i].page, i)
        }}
        onSettings={() => go('about', 5)}
      />

      <motion.div
        className="absolute left-[244px] top-[100px] z-10 h-[1685px] w-[1916px] overflow-hidden rounded-[35px] border border-white/20 bg-white/[0.055] shadow-[0_30px_80px_rgba(0,0,0,0.16)] backdrop-blur-[12px]"
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.9, delay: 0.08, ease }}
      >
        <WorkspaceSidebar
          page={page}
          selectedPetId={currentPet?.id ?? ''}
          officialPets={officialPets}
          importedCount={importedPets.length}
          lastCheckedAt={agent.lastCheckedAt}
          lastEvent={agent.lastEvent}
          activeCount={agent.activeSessions.length}
          appVersion={appVersion}
          treeQuery={treeQuery}
          onTreeQuery={setTreeQuery}
          onPage={go}
          onPet={onSelectPet}
        />

        <div className="absolute left-[554px] top-0 z-[12] h-full w-[1362px] overflow-y-auto overflow-x-hidden bg-white/[0.035]">
          <div className="relative ml-[62px] mr-[56px] w-auto pb-[36px] pt-[56px]">
            {page === 'pet' && currentPet && (
              <PetPane
                pet={currentPet}
                scale={displayScale}
                tab={petTab}
                query={paneQuery}
                pets={filteredPets}
                autoCutout={settings.autoRemoveBackground}
                packBusy={props.packBusy}
                packError={props.packError}
                onTab={setPetTab}
                onQuery={setPaneQuery}
                onSelect={onSelectPet}
                onScaleDraft={props.onScaleDraft}
                onScaleCommit={props.onScaleCommit}
                onCutout={(v) => onPatch({ autoRemoveBackground: v })}
                onImport={props.onImport}
                onReveal={props.onReveal}
                onDeletePack={props.onDeletePack}
              />
            )}
            {page === 'bubble' && (
              <BubblePane
                on={settings.bubblesEnabled}
                freq={settings.bubbleFrequencySeconds}
                onToggle={(v) => onPatch({ bubblesEnabled: v })}
                onFreq={(v) => onPatch({ bubbleFrequencySeconds: v })}
              />
            )}
            {page === 'agent' && (
              <AgentPane
                openCount={openAgentCount}
                soundOn={settings.agentCompletionSoundEnabled}
                settings={settings}
                lastCheckedAt={agent.lastCheckedAt}
                lastEvent={agent.lastEvent}
                activeCount={agent.activeSessions.length}
                onSound={(v) => onPatch({ agentCompletionSoundEnabled: v })}
                onToggle={(key, value) => onPatch({ [key]: value } as Partial<typeof settings>)}
                onEnv={props.onToggleEnv}
                onCodexFlag={(key, value) => onPatch({ [key]: value })}
              />
            )}
            {page === 'ai' && (
              <AiPane
                on={settings.aiSummaryEnabled}
                provider={props.aiProviderChoice}
                apiKey={
                  settings.aiProvider === 'anthropic' ? settings.aiAnthropicApiKey : settings.aiOpenaiApiKey
                }
                model={
                  settings.aiProvider === 'anthropic' ? settings.aiAnthropicModel : settings.aiOpenaiModel
                }
                base={settings.aiOpenaiBaseUrl}
                test={
                  props.aiTestResult
                    ? props.aiTestResult.ok
                      ? `连接成功！「${props.aiTestResult.text}」`
                      : props.aiTestResult.error
                    : null
                }
                testBusy={props.aiTestBusy}
                onToggle={(v) => onPatch({ aiSummaryEnabled: v })}
                onProvider={props.onAiProviderChoice}
                onKey={(v) =>
                  onPatch(
                    settings.aiProvider === 'anthropic' ? { aiAnthropicApiKey: v } : { aiOpenaiApiKey: v }
                  )
                }
                onModel={(v) =>
                  onPatch(
                    settings.aiProvider === 'anthropic' ? { aiAnthropicModel: v } : { aiOpenaiModel: v }
                  )
                }
                onBase={(v) => onPatch({ aiOpenaiBaseUrl: v })}
                onTest={props.onTestAi}
              />
            )}
            {page === 'about' && currentPet && (
              <AboutPane
                pet={currentPet}
                version={appVersion}
                updateOn={settings.updateCheckEnabled}
                visible={settings.petVisible}
                onUpdate={(v) => onPatch({ updateCheckEnabled: v })}
                onVisible={props.onToggleVisible}
                onReset={props.onResetPosition}
              />
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function UtilityRail({
  selected,
  onSelect,
  onSettings
}: {
  selected: number
  onSelect: (i: number) => void
  onSettings: () => void
}): JSX.Element {
  return (
    <motion.div initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.72, delay: 0.18, ease }}>
      <div className="absolute left-[110px] top-[100px] z-30 h-[1260px] w-[118px] rounded-[34px] border border-white/20 bg-white/[0.10] shadow-[0_22px_48px_rgba(0,0,0,0.16)] backdrop-blur-[18px]" />
      <div className="absolute left-[126px] top-[116px] z-[31] h-[924px] w-[85px] rounded-[22px] bg-[#252527] shadow-[inset_0_1px_1px_rgba(255,255,255,0.12),0_16px_24px_rgba(0,0,0,0.18)]">
        <svg className="absolute left-[29px] top-[28px] text-[#F5F5F5]" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2V22M2 12H22M4.93 4.93L19.07 19.07M19.07 4.93L4.93 19.07" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
        <div className="absolute left-[22px] top-[93px] h-px w-[42px] bg-white/20" />
        {RAIL.map((item, i) => {
          const Icon = item.icon
          const active = selected === i
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className="absolute flex h-[68px] w-[70px] items-center justify-center rounded-[16px] transition-colors duration-[180ms]"
              style={{
                left: 7,
                top: 122 + i * (68 + 21),
                background: active ? 'rgba(255,255,255,0.20)' : 'transparent',
                border: active ? '1px solid rgba(255,255,255,0.28)' : '1px solid transparent'
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.10)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = active ? 'rgba(255,255,255,0.20)' : 'transparent'
              }}
            >
              <Icon size={25} color="#F5F5F5" strokeWidth={1.6} />
            </button>
          )
        })}
      </div>

      <div className="absolute left-[110px] top-[1048px] z-30 flex h-[300px] w-[118px] items-center justify-center rounded-[34px] border border-white/20 bg-white/[0.10]">
        <span className="rail-label text-[14px] font-medium text-white/30">PINGPET NAV</span>
        <div className="absolute bottom-[90px] left-1/2 h-px w-[50px] -translate-x-1/2 bg-white/20" />
      </div>

      <div className="absolute left-[110px] top-[1365px] z-30 h-[420px] w-[118px] rounded-[34px] border border-white/20 bg-white/[0.10]">
        <span className="rail-label absolute left-1/2 top-[90px] -translate-x-1/2 text-[14px] font-medium text-white/30">
          PINGPET SETTINGS
        </span>
        <div className="absolute left-1/2 top-[238px] h-px w-[50px] -translate-x-1/2 bg-white/20" />
        <button
          type="button"
          onClick={onSettings}
          className="absolute bottom-[26px] left-[16px] flex h-[86px] w-[85px] items-center justify-center rounded-[22px] bg-[#252527] active:scale-[0.98]"
        >
          <SettingsIcon size={28} color="#F5F5F5" strokeWidth={1.5} />
        </button>
      </div>
    </motion.div>
  )
}

function WorkspaceSidebar({
  page,
  selectedPetId,
  officialPets,
  importedCount,
  lastCheckedAt,
  lastEvent,
  activeCount,
  appVersion,
  treeQuery,
  onTreeQuery,
  onPage,
  onPet
}: {
  page: PageKey
  selectedPetId: string
  officialPets: PetDefinition[]
  importedCount: number
  lastCheckedAt: number | null
  lastEvent: AgentMonitorEvent | null
  activeCount: number
  appVersion: string
  treeQuery: string
  onTreeQuery: (v: string) => void
  onPage: (p: PageKey) => void
  onPet: (id: string) => void
}): JSX.Element {
  const q = treeQuery.trim()
  const officialOpen = !q || officialPets.some((p) => p.name.includes(q)) || '官方内置'.includes(q)

  return (
    <motion.aside
      className="absolute inset-y-0 left-0 z-[11] w-[554px] border-r border-white/15 bg-white/[0.045] px-[43px] pt-[43px]"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.72, delay: 0.24, ease }}
    >
      <div className="absolute left-[42px] top-[43px] flex gap-[13px]">
        <TrafficLight color="#E7A4B0" />
        <TrafficLight color="#E6CB91" />
        <TrafficLight color="#9BD9C9" />
      </div>
      <div className="absolute left-[515px] top-[44px] flex h-[25px] w-[28px] items-center justify-center rounded-[6px] border border-[rgba(35,35,35,0.38)] bg-white/10">
        <PanelLeft size={13} color="#5D5D5D" />
      </div>

      <div className="absolute left-[43px] top-[101px] flex items-center">
        <img
          src={avatarUrl}
          alt=""
          className="h-20 w-20 rounded-full object-cover object-center"
          style={{ boxShadow: '0 10px 16px rgba(0,0,0,0.22)' }}
        />
        <div className="ml-[25px]">
          <div className="flex items-center gap-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-[#111]">
            PingPet
          </div>
          <div className="mt-[8px] text-[23px] font-normal leading-none text-[#7A7A7A]">本地桌宠 · v{appVersion}</div>
        </div>
      </div>

      <div className="absolute left-[43px] right-[43px] top-[225px]">
        <SectionLabel>主页</SectionLabel>
        <div className="mt-[34px] flex flex-col gap-[7px]">
          {HOME_ROWS.map((row) => {
            const Icon = row.icon
            const active = page === row.page
            return (
              <button
                key={row.label}
                type="button"
                onClick={() => onPage(row.page)}
                className={
                  active
                    ? 'flex h-[68px] w-full items-center rounded-[17px] border border-white/55 bg-[#b6bab9] px-[23px] text-[27px] font-medium tracking-[-0.04em] shadow-[inset_0_1px_2px_rgba(255,255,255,0.38),0_12px_20px_rgba(0,0,0,0.06)]'
                    : 'flex h-[68px] w-full items-center gap-[24px] px-[23px] text-[27px] font-medium tracking-[-0.04em] text-[#111]'
                }
              >
                <Icon size={25} strokeWidth={1.7} className={active ? 'mr-6' : ''} />
                {row.label}
                {row.count && <CountBadge value={row.count} />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="absolute left-[43px] h-px w-[510px] bg-[rgba(35,35,35,0.16)]" style={{ top: 489 }} />
      <div className="absolute left-[43px] right-[43px]" style={{ top: 514 }}>
        <SectionLabel>能力</SectionLabel>
        <div className="mt-[34px] flex flex-col gap-[7px]">
          {ABILITY_ROWS.map((row) => {
            const Icon = row.icon
            const active = page === row.page
            return (
              <button
                key={row.label}
                type="button"
                onClick={() => onPage(row.page)}
                className={
                  active
                    ? 'flex h-[68px] w-full items-center rounded-[17px] border border-white/55 bg-[#b6bab9] px-[23px] text-[27px] font-medium tracking-[-0.04em]'
                    : 'flex h-[68px] w-full items-center gap-[24px] px-[23px] text-[27px] font-medium tracking-[-0.04em] text-[#111]'
                }
              >
                <Icon size={25} strokeWidth={1.7} className={active ? 'mr-6' : ''} />
                {row.label}
                {row.count && <CountBadge value={row.count} />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="absolute left-[43px] h-px w-[510px] bg-[rgba(35,35,35,0.16)]" style={{ top: 805 }} />
      <div className="absolute left-[43px] right-[43px]" style={{ top: 830 }}>
        <SectionLabel>诊断</SectionLabel>
        <div className="mt-[34px] flex flex-col">
          <div className="flex h-[68px] w-full items-center gap-[24px] px-[23px] text-[27px] font-medium tracking-[-0.04em]">
            <History size={25} strokeWidth={1.7} />
            最近检查
            <span className="ml-auto text-[20px] font-normal text-[#777]">{formatTime(lastCheckedAt)}</span>
          </div>
          <div className="flex h-[68px] w-full items-center gap-[24px] px-[23px] text-[27px] font-medium tracking-[-0.04em]">
            <Bell size={25} strokeWidth={1.7} />
            最近事件
            <span className="ml-auto text-[18px] font-normal text-[#777]">
              {lastEvent
                ? `${AGENT_SOURCES[lastEvent.source].label} · ${AGENT_KIND_LABEL[lastEvent.kind]}`
                : '—'}
            </span>
          </div>
          <div className="flex h-[68px] w-full items-center gap-[24px] px-[23px] text-[27px] font-medium tracking-[-0.04em]">
            <Archive size={25} strokeWidth={1.7} />
            活跃会话
            <CountBadge value={String(activeCount)} />
          </div>
        </div>
      </div>

      <div className="absolute left-[43px] h-px w-[510px] bg-[rgba(35,35,35,0.16)]" style={{ top: 1115 }} />
      <div className="absolute left-[43px] right-[43px]" style={{ top: 1140 }}>
        <div className="flex items-center">
          <SectionLabel>形象</SectionLabel>
          <span className="ml-auto flex h-[34px] w-[34px] items-center justify-center rounded-full border border-dashed border-[rgba(35,35,35,0.38)]">
            <Plus size={20} color="#111" />
          </span>
        </div>
        <SearchField value={treeQuery} onChange={onTreeQuery} placeholder="搜索皮肤、会话…" />
        <div className="relative mt-[16px] w-full rounded-[18px] border border-[rgba(35,35,35,0.20)] bg-[rgba(255,255,255,0.035)] px-[23px] py-[17px]">
          <div className="absolute bottom-[18px] left-[35px] top-[62px] w-px bg-[rgba(35,35,35,0.18)]" />
          <TreeRow icon label="官方内置" count={String(officialPets.length)} />
          {officialOpen &&
            officialPets
              .filter((p) => !q || p.name.includes(q))
              .map((p) => (
                <TreeRow
                  key={p.id}
                  indent
                  label={p.name}
                  count="1"
                  selected={selectedPetId === p.id && page === 'pet'}
                  onClick={() => {
                    onPet(p.id)
                    onPage('pet')
                  }}
                />
              ))}
          <TreeRow label="已导入" count={String(importedCount)} />
          <TreeRow label="PetDex 形象库" />
        </div>
      </div>
    </motion.aside>
  )
}

function TreeRow({
  label,
  count,
  indent,
  selected,
  icon,
  onClick
}: {
  label: string
  count?: string
  indent?: boolean
  selected?: boolean
  icon?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-12 w-full items-center text-left text-[25px] font-medium tracking-[-0.04em] ${
        selected ? 'rounded-[12px] bg-[#A1A1A1] px-3' : ''
      }`}
      style={indent && !selected ? { paddingLeft: 48 } : indent && selected ? { marginLeft: 36, width: 'calc(100% - 36px)' } : undefined}
    >
      {(icon || indent) && <Folder size={26} className="mr-3 shrink-0" strokeWidth={1.6} />}
      {label}
      {count && <CountBadge value={count} />}
    </button>
  )
}

function PetPane({
  pet,
  scale,
  tab,
  query,
  pets,
  autoCutout,
  packBusy,
  packError,
  onTab,
  onQuery,
  onSelect,
  onScaleDraft,
  onScaleCommit,
  onCutout,
  onImport,
  onReveal,
  onDeletePack
}: {
  pet: PetDefinition
  scale: number
  tab: PetTab
  query: string
  pets: PetDefinition[]
  autoCutout: boolean
  packBusy: boolean
  packError: string | null
  onTab: (t: PetTab) => void
  onQuery: (v: string) => void
  onSelect: (id: string) => void
  onScaleDraft: (n: number) => void
  onScaleCommit: (n: number) => void
  onCutout: (v: boolean) => void
  onImport: () => void
  onReveal: () => void
  onDeletePack: (id: string, name: string) => void
}): JSX.Element {
  const tabs: Array<{ key: PetTab; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'official', label: '官方' },
    { key: 'imported', label: '已导入' }
  ]

  return (
    <>
      <FadeIn delay={0.34}>
        <h1 className="text-[54px] font-medium leading-[1] tracking-[-0.065em] text-[#111]">桌宠</h1>
        <p className="mt-[20px] text-[29px] font-normal leading-[1.15] tracking-[-0.035em] text-[#777]">
          选一只小伙伴，或导入你自己的皮肤。
        </p>
      </FadeIn>

      <FadeIn delay={0.48}>
        <div className="light-glass mt-[72px] flex h-[240px] w-full items-stretch rounded-[20px] px-[32px] py-[28px]">
          <div className="flex min-w-0 flex-1 items-end gap-6">
            <div className="h-[120px] w-[120px] shrink-0">
              <PetSprite pet={pet} state="idle" />
            </div>
            <div className="min-w-0 pb-1">
              <div className="text-[22px] font-medium tracking-[-0.04em] text-[#777]">当前陪伴</div>
              <div className="mt-2 text-[88px] font-medium leading-[0.78] tracking-[-0.09em] text-[#3E3E40]">{pet.name}</div>
              <div className="mt-4 truncate text-[20px] text-[#777]">{pet.description}</div>
            </div>
          </div>
          <div className="ml-8 flex w-[360px] shrink-0 items-center justify-between border-l border-[rgba(35,35,35,0.12)] pl-8">
            <Stat label="大小" value={`${Math.round(scale * 100)}%`} />
            <Stat label="状态" value="空闲中" />
            <Stat label="来源" value={sourceLabel(pet.source)} mint />
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={0.58}>
        <div className="mt-[32px] grid grid-cols-2 gap-4">
          <button
            type="button"
            disabled={packBusy}
            onClick={onImport}
            className="flex h-[78px] items-center justify-between rounded-[20px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] bg-white/[0.015] px-[25px] text-[27px] font-medium tracking-[-0.045em] transition duration-[180ms] hover:-translate-y-px hover:bg-white/10 active:scale-[0.98] disabled:opacity-50"
          >
            {packBusy ? '导入中…' : '导入皮肤'}
            <ArrowRight size={26} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={onReveal}
            className="flex h-[78px] items-center justify-between rounded-[20px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] bg-white/[0.015] px-[25px] text-[27px] font-medium tracking-[-0.045em] transition duration-[180ms] hover:-translate-y-px hover:bg-white/10 active:scale-[0.98]"
          >
            打开导入目录
            <ArrowRight size={26} strokeWidth={1.8} />
          </button>
        </div>
      </FadeIn>

      <FadeIn delay={0.72}>
        <h2 className="mt-[64px] text-[50px] font-medium leading-none tracking-[-0.065em]">形象库</h2>
        <div className="mt-[38px] flex gap-[48px] text-[27px] font-medium">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTab(t.key)}
              className={`relative pb-[22px] ${tab === t.key ? 'text-[#111]' : 'text-[#777]'}`}
            >
              {t.label}
              {tab === t.key && (
                <span className="absolute bottom-0 left-0 block h-1 w-full rounded-full bg-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.12)]" />
              )}
            </button>
          ))}
        </div>
      </FadeIn>

      <FadeIn delay={0.8}>
        <label className="mt-[20px] flex h-[72px] w-full items-center gap-[18px] rounded-[20px] border border-white/22 bg-white/[0.035] px-[23px]">
          <Search size={27} color="#111" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索皮肤、会话…"
            className="h-full w-full bg-transparent text-[24px] outline-none placeholder:text-[#777]"
          />
        </label>
      </FadeIn>

      <FadeIn delay={0.88}>
        <div className="mt-[28px] w-full rounded-[20px] border border-white/22 bg-white/[0.045] p-6 shadow-[inset_0_1px_2px_rgba(255,255,255,0.24)]">
          {pets.length === 0 ? (
            <div className="flex h-[280px] items-center justify-center text-center text-[20px] leading-relaxed text-[#858585]">
              已导入还是空的。选一张图，或打开 PetDex。
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-5">
              {pets.map((p) => {
                const on = p.id === pet.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelect(p.id)}
                    className={`rounded-[18px] border px-3 pb-5 pt-4 text-left active:scale-[0.98] ${
                      on ? 'border-white/55 bg-[#b6bab9]' : 'border-white/20 bg-white/[0.04]'
                    }`}
                  >
                    <div className="mx-auto h-[140px] w-[140px]">
                      <PetSprite pet={p} state="idle" />
                    </div>
                    <div className="mt-2 text-center text-[24px] font-medium tracking-[-0.04em]">{p.name}</div>
                    <div className="mt-1 text-center text-[16px] text-[#777]">{p.description}</div>
                    <div className="mt-3 flex items-center justify-center gap-3 text-[14px] text-[#858585]">
                      <span>{sourceLabel(p.source)}</span>
                      {p.source === 'imported' && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="underline"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeletePack(p.id, p.name)
                          }}
                        >
                          删除
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
              <button
                type="button"
                onClick={onImport}
                className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-[rgba(35,35,35,0.28)] bg-white/[0.02] px-3 pb-5 pt-4 text-[#777] active:scale-[0.98]"
              >
                <span className="flex h-[140px] w-[140px] items-center justify-center">
                  <Plus size={42} strokeWidth={1.4} />
                </span>
                <div className="mt-2 text-center text-[24px] font-medium tracking-[-0.04em] text-[#111]">导入</div>
                <div className="mt-1 text-center text-[16px] text-[#777]">一张图或皮肤包</div>
                <div className="mt-3 text-center text-[14px] text-[#858585]">PetDex</div>
              </button>
            </div>
          )}
          <div className="mt-6 grid grid-cols-2 gap-5 border-t border-[rgba(35,35,35,0.10)] pt-5">
            <label className="flex items-center justify-between text-[18px] text-[#555]">
              <span>导入时自动去掉纯色背景</span>
              <input type="checkbox" className="proto-switch" checked={autoCutout} onChange={(e) => onCutout(e.target.checked)} />
            </label>
            <label className="flex items-center gap-4 text-[18px] text-[#555]">
              <span className="shrink-0">大小</span>
              <input
                type="range"
                min={PET_SCALE_MIN}
                max={PET_SCALE_MAX}
                step={0.05}
                value={scale}
                onChange={(e) => onScaleDraft(Number(e.target.value))}
                onPointerUp={(e) => onScaleCommit(Number(e.currentTarget.value))}
                className="w-full accent-[#252527]"
              />
              <span className="w-14 text-right">{Math.round(scale * 100)}%</span>
            </label>
          </div>
          {packError && <p className="mt-4 text-[16px] text-[#a33]">{packError}</p>}
        </div>
      </FadeIn>
    </>
  )
}

function BubblePane({
  on,
  freq,
  onToggle,
  onFreq
}: {
  on: boolean
  freq: number
  onToggle: (v: boolean) => void
  onFreq: (v: number) => void
}): JSX.Element {
  return (
    <>
      <FadeIn delay={0.34}>
        <h1 className="text-[54px] font-medium leading-[1] tracking-[-0.065em]">陪伴气泡</h1>
        <p className="mt-[20px] whitespace-nowrap text-[29px] font-normal tracking-[-0.035em] text-[#777]">
          桌宠偶尔冒出的小气泡，安静作陪。
        </p>
      </FadeIn>
      <FadeIn delay={0.48}>
        <div className="light-glass mt-[72px] flex h-[240px] w-full items-end justify-between rounded-[20px] px-[32px] pb-[28px] pt-[27px]">
          <div>
            <span className="text-[24px] font-medium tracking-[-0.045em] text-[#777]">频率</span>
            <div className="mt-4 text-[120px] font-medium leading-[0.78] tracking-[-0.09em] text-[#3E3E40]">
              {Math.round(freq / 60)}
            </div>
          </div>
          <div className="mb-2 flex flex-col items-end gap-3">
            <span className="flex h-12 items-center rounded-[15px] bg-[rgba(135,225,203,0.16)] px-[18px] text-[20px] font-semibold text-[#8DEFD2]">
              分钟
            </span>
            <span className="text-[20px] text-[#777]">{on ? '陪伴气泡已开' : '陪伴气泡已关'}</span>
          </div>
        </div>
      </FadeIn>
      <FadeIn delay={0.58}>
        <div className="mt-[38px] w-full space-y-4 rounded-[20px] border border-white/22 bg-white/[0.045] px-[25px] py-6">
          <label className="flex h-[68px] items-center justify-between text-[27px] font-medium">
            偶尔冒出小气泡
            <input type="checkbox" className="proto-switch" checked={on} onChange={(e) => onToggle(e.target.checked)} />
          </label>
          <label className="flex h-[68px] items-center justify-between text-[27px] font-medium">
            频率
            <select
              disabled={!on}
              value={freq}
              onChange={(e) => onFreq(Number(e.target.value))}
              className="rounded-[14px] border border-white/30 bg-transparent px-4 py-2 text-[22px] outline-none disabled:opacity-40"
            >
              {FREQ.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[18px] leading-relaxed text-[#777]">和 Agent 停下时的提醒不是同一类气泡。</p>
        </div>
      </FadeIn>
    </>
  )
}

function AgentPane({
  openCount,
  soundOn,
  settings,
  lastCheckedAt,
  lastEvent,
  activeCount,
  onSound,
  onToggle,
  onEnv,
  onCodexFlag
}: {
  openCount: number
  soundOn: boolean
  settings: Settings
  lastCheckedAt: number | null
  lastEvent: AgentMonitorEvent | null
  activeCount: number
  onSound: (v: boolean) => void
  onToggle: (key: MonitoringEnabledKey, value: boolean) => void
  onEnv: (key: MonitoringEnvsKey, current: AgentEnv[], env: AgentEnv) => void
  onCodexFlag: (key: CodexCandidateUiSettingKey, value: boolean) => void
}): JSX.Element {
  return (
    <>
      <FadeIn delay={0.34}>
        <h1 className="text-[54px] font-medium leading-[1] tracking-[-0.065em]">Agent 监控</h1>
        <p className="mt-[20px] whitespace-nowrap text-[26px] font-normal tracking-[-0.035em] text-[#777]">
          忙完或需要你时，第一时间提醒你。
        </p>
      </FadeIn>
      <FadeIn delay={0.48}>
        <div className="mt-[72px] grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-4">
          <div className="light-glass flex h-[220px] flex-col rounded-[20px] px-[28px] pt-[24px]">
            <span className="text-[24px] font-medium">已开启</span>
            <div className="mt-auto flex items-end justify-between pb-5">
              <span className="text-[110px] font-medium leading-[0.78] tracking-[-0.09em] text-[#3E3E40]">{openCount}</span>
              <span className="mb-1 flex h-10 items-center rounded-[12px] bg-[rgba(135,225,203,0.16)] px-3 text-[18px] font-semibold text-[#8DEFD2]">
                / 4 家
              </span>
            </div>
          </div>
          <div className="flex h-[220px] flex-col rounded-[20px] border border-white/22 bg-white/[0.045] px-6 pt-6">
            <span className="text-[18px] text-[#777]">最近检查</span>
            <span className="mt-auto pb-6 text-[32px] font-medium tracking-[-0.05em]">{formatTime(lastCheckedAt)}</span>
          </div>
          <div className="flex h-[220px] flex-col rounded-[20px] border border-white/22 bg-white/[0.045] px-6 pt-6">
            <span className="text-[18px] text-[#777]">最近事件</span>
            <span className="mt-auto pb-6 text-[26px] font-medium tracking-[-0.04em]">
              {lastEvent
                ? `${AGENT_SOURCES[lastEvent.source].label} · ${AGENT_KIND_LABEL[lastEvent.kind]}`
                : '—'}
            </span>
          </div>
          <div className="flex h-[220px] flex-col rounded-[20px] border border-white/22 bg-white/[0.045] px-6 pt-6">
            <span className="text-[18px] text-[#777]">活跃会话</span>
            <span className="mt-auto pb-6 text-[56px] font-medium leading-none tracking-[-0.06em] text-[#3E3E40]">{activeCount}</span>
          </div>
        </div>
      </FadeIn>
      <FadeIn delay={0.58}>
        <label className="mt-[38px] flex h-[78px] w-full items-center justify-between rounded-[20px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] bg-white/[0.015] px-[25px] text-[29px] font-medium">
          完成提示音
          <input type="checkbox" className="proto-switch" checked={soundOn} onChange={(e) => onSound(e.target.checked)} />
        </label>
      </FadeIn>
      <FadeIn delay={0.72} className="mt-[48px] grid grid-cols-2 gap-4">
        {AGENT_SOURCE_LIST.map((a) => (
          <div key={a.source} className="rounded-[20px] border border-white/22 bg-white/[0.045] px-6 py-5">
            <label className="flex items-center justify-between text-[27px] font-medium">
              监控 {a.label}
              <input
                type="checkbox"
                className="proto-switch"
                checked={settings[a.enabledKey]}
                onChange={(e) => onToggle(a.enabledKey, e.target.checked)}
              />
            </label>
            {settings[a.enabledKey] && (
              <div className="mt-4 flex flex-wrap gap-2">
                {AGENT_ENVS.map((env) => {
                  const usable = a.envs.includes(env)
                  const on = usable && settings[a.envsKey].includes(env)
                  return (
                    <button
                      key={env}
                      type="button"
                      title={usable ? undefined : a.envLimitReason}
                      disabled={!usable}
                      onClick={() => onEnv(a.envsKey, settings[a.envsKey], env)}
                      className={`proto-env-chip ${usable ? (on ? 'is-on' : '') : 'is-off'}`}
                    >
                      {ENV_LABEL[env]}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
        <p className="col-span-2 text-[18px] leading-relaxed text-[#777]">
          只有停下时才弹气泡。正在干活时只做思考表情。只读本机会话文件，不上传代码。
        </p>
      </FadeIn>
      <FadeIn delay={0.82} className="mt-[48px]">
        <div className="w-full space-y-5 rounded-[20px] border border-white/22 bg-white/[0.045] px-6 py-6">
          <div>
            <h2 className="text-[27px] font-medium">{CODEX_CANDIDATE_SETTINGS_CARD_TITLE}</h2>
            <p className="mt-2 text-[18px] leading-relaxed text-[#777]">{CODEX_CANDIDATE_SETTINGS_CARD_HINT}</p>
          </div>
          {CODEX_CANDIDATE_SETTING_ITEMS.map((item) => {
            const on = settings[item.key]
            return (
              <label key={item.key} className="flex items-start justify-between gap-6 text-[27px] font-medium">
                <span className="min-w-0">
                  <span className="block">{item.title}</span>
                  <span className="mt-2 block text-[18px] font-normal leading-relaxed text-[#777]">
                    {item.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3 pt-1">
                  <span className="text-[18px] font-medium text-[#777]">{on ? '已开' : '已关'}</span>
                  <input
                    type="checkbox"
                    className="proto-switch"
                    checked={on}
                    aria-label={item.title}
                    onChange={(e) => onCodexFlag(item.key, e.target.checked)}
                  />
                </span>
              </label>
            )
          })}
        </div>
      </FadeIn>
    </>
  )
}

function AiPane({
  on,
  provider,
  apiKey,
  model,
  base,
  test,
  testBusy,
  onToggle,
  onProvider,
  onKey,
  onModel,
  onBase,
  onTest
}: {
  on: boolean
  provider: AiProviderChoice
  apiKey: string
  model: string
  base: string
  test: string | null
  testBusy: boolean
  onToggle: (v: boolean) => void
  onProvider: (v: AiProviderChoice) => void
  onKey: (v: string) => void
  onModel: (v: string) => void
  onBase: (v: string) => void
  onTest: () => void
}): JSX.Element {
  return (
    <>
      <FadeIn delay={0.34}>
        <h1 className="text-[54px] font-medium leading-[1] tracking-[-0.065em]">AI 总结</h1>
        <p className="mt-[20px] text-[26px] font-normal leading-snug tracking-[-0.035em] text-[#777]">
          停下时用一句人话告诉你发生了什么。
        </p>
      </FadeIn>
      <FadeIn delay={0.48}>
        <div className="light-glass mt-[72px] flex h-[240px] w-full items-end justify-between rounded-[20px] px-[32px] pb-[28px] pt-[27px]">
          <div>
            <span className="text-[24px] font-medium text-[#777]">状态</span>
            <div className="mt-4 text-[88px] font-medium leading-[0.78] tracking-[-0.09em] text-[#3E3E40]">{on ? '开启' : '关闭'}</div>
          </div>
          <div className="mb-2 flex flex-col items-end gap-3">
            <span className="flex h-12 items-center rounded-[15px] bg-[rgba(135,225,203,0.16)] px-[18px] text-[20px] font-semibold text-[#8DEFD2]">
              {on ? '可选联网' : '不联网'}
            </span>
            <span className="text-[20px] text-[#777]">{on ? 'Key 只存在本机' : '此功能完全不联网'}</span>
          </div>
        </div>
      </FadeIn>
      <FadeIn delay={0.58}>
        <div className="mt-[38px] w-full space-y-4 rounded-[20px] border border-white/22 bg-white/[0.045] px-6 py-6">
          <label className="flex h-[68px] items-center justify-between text-[27px] font-medium">
            启用 AI 总结
            <input type="checkbox" className="proto-switch" checked={on} onChange={(e) => onToggle(e.target.checked)} />
          </label>
          {on && (
            <>
              <label className="flex items-center justify-between text-[22px] font-medium">
                模型服务
                <select
                  value={provider}
                  onChange={(e) => onProvider(e.target.value as AiProviderChoice)}
                  className="rounded-[14px] border border-white/30 bg-transparent px-3 py-2 text-[20px] outline-none"
                >
                  <option value="siliconflow">硅基流动</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI 兼容</option>
                </select>
              </label>
              {provider === 'openai' && (
                <input
                  value={base}
                  onChange={(e) => onBase(e.target.value)}
                  placeholder="Base URL"
                  className="h-[64px] w-full rounded-[16px] border border-white/22 bg-white/[0.035] px-4 text-[20px] outline-none"
                />
              )}
              <input
                type="password"
                value={apiKey}
                onChange={(e) => onKey(e.target.value)}
                placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                className="h-[64px] w-full rounded-[16px] border border-white/22 bg-white/[0.035] px-4 text-[20px] outline-none"
              />
              <input
                value={model}
                onChange={(e) => onModel(e.target.value)}
                placeholder="模型 ID"
                className="h-[64px] w-full rounded-[16px] border border-white/22 bg-white/[0.035] px-4 text-[20px] outline-none"
              />
              <button
                type="button"
                onClick={onTest}
                disabled={testBusy}
                className="flex h-[64px] w-full items-center justify-between rounded-[16px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] px-5 text-[22px] font-medium hover:bg-white/10 disabled:opacity-50"
              >
                {testBusy ? '测试中…' : '测试连接'}
                <ArrowRight size={22} />
              </button>
              {test && <p className="text-[18px] leading-relaxed text-[#555]">{test}</p>}
            </>
          )}
          <p className="text-[17px] leading-relaxed text-[#777]">
            只在停下那一刻，把会话末尾少量文本发给你自己配置的服务。Key 只存在本机。
          </p>
        </div>
      </FadeIn>
    </>
  )
}

function AboutPane({
  pet,
  version,
  updateOn,
  visible,
  onUpdate,
  onVisible,
  onReset
}: {
  pet: PetDefinition
  version: string
  updateOn: boolean
  visible: boolean
  onUpdate: (v: boolean) => void
  onVisible: () => void
  onReset: () => void
}): JSX.Element {
  return (
    <>
      <FadeIn delay={0.34}>
        <h1 className="text-[54px] font-medium leading-[1] tracking-[-0.065em]">关于</h1>
        <p className="mt-[20px] text-[29px] font-normal tracking-[-0.035em] text-[#777]">PingPet v{version}</p>
      </FadeIn>
      <FadeIn delay={0.48}>
        <div className="light-glass mt-[72px] flex h-[240px] w-full items-center gap-8 rounded-[20px] px-10">
          <div className="h-[140px] w-[140px] shrink-0">
            <PetSprite pet={pet} state="happy" />
          </div>
          <div>
            <p className="text-[28px] font-medium tracking-[-0.04em]">一个安静住在桌面上的小伙伴。</p>
            <p className="mt-3 text-[20px] leading-relaxed text-[#777]">
              所有设置和 API Key 都只保存在本机。默认只有更新检查会联网，AI 总结要你自己开。
            </p>
          </div>
        </div>
      </FadeIn>
      <FadeIn delay={0.58}>
        <div className="mt-[38px] w-full space-y-4 rounded-[20px] border border-white/22 bg-white/[0.045] px-6 py-6">
          <label className="flex h-[68px] items-center justify-between text-[27px] font-medium">
            检查新版本
            <input type="checkbox" className="proto-switch" checked={updateOn} onChange={(e) => onUpdate(e.target.checked)} />
          </label>
          <p className="text-[18px] leading-relaxed text-[#777]">每天只向 GitHub 取一个版本号，不上传任何关于你的信息。</p>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onReset}
              className="flex h-[64px] flex-1 items-center justify-center rounded-[16px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] text-[22px] font-medium hover:bg-white/10"
            >
              重置位置
            </button>
            <button
              type="button"
              onClick={onVisible}
              className="flex h-[64px] flex-1 items-center justify-center rounded-[16px] border proto-dash-btn border-dashed border-[rgba(35,35,35,0.34)] text-[22px] font-medium hover:bg-white/10"
            >
              {visible ? '隐藏桌宠' : '显示桌宠'}
            </button>
          </div>
        </div>
      </FadeIn>
    </>
  )
}
