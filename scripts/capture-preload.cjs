/**
 * 仅用于本地视觉验收：给设置台渲染进程注入一份假数据。
 * 不参与生产构建，也不改变任何真实设置。
 */
const { contextBridge } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// 自带的示例素材，保证 capture 脚本在独立 clone 的仓库里也能跑
const demoPet = pathToFileURL(join(__dirname, 'fixtures', 'demo-pet.png')).href
const demoSheet = pathToFileURL(join(__dirname, 'fixtures', 'demo-spritesheet.png')).href

const now = Date.now()

const settings = {
  theme: 'light',
  selectedPetId: 'dango',
  petScale: 1,
  bubblesEnabled: true,
  bubbleFrequencySeconds: 180,
  petPosition: null,
  petVisible: true,
  bubbleAnchor: { angleDeg: 270, distance: 110 },
  autoRemoveBackground: true,
  agentProgressBubblesEnabled: true,
  agentCompletionSoundEnabled: false,
  codexCandidateVisualEnabled: false,
  codexCandidateBubbleEnabled: false,
  codexCandidateSoundEnabled: false,
  aiSummaryEnabled: false,
  aiProvider: 'anthropic',
  aiAnthropicApiKey: '',
  aiAnthropicModel: 'claude-opus-4-8',
  aiOpenaiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiOpenaiApiKey: '',
  aiOpenaiModel: 'deepseek-ai/DeepSeek-V3.1',
  updateCheckEnabled: true,
  codexMonitoringEnabled: true,
  codexMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
  claudeMonitoringEnabled: true,
  claudeMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
  cursorMonitoringEnabled: false,
  cursorMonitoringEnvs: ['terminal', 'desktop'],
  grokMonitoringEnabled: false,
  grokMonitoringEnvs: ['desktop']
}

const pets = [
  {
    id: 'dango',
    name: '团子',
    kind: 'svg',
    source: 'official',
    accentColor: '#F0B27E',
    description: '软乎乎的奶油小猫'
  },
  {
    id: 'pudding',
    name: '布丁',
    kind: 'svg',
    source: 'official',
    accentColor: '#F5B942',
    description: '圆滚滚的小鸡'
  },
  {
    id: 'momo',
    name: '墨墨',
    kind: 'svg',
    source: 'official',
    accentColor: '#7C8DB0',
    description: '安安静静的小墨团'
  },
  {
    id: 'shiba-demo',
    name: '柴柴',
    kind: 'image-pack',
    source: 'imported',
    accentColor: '#C46A35',
    description: '暖呼呼的小伙伴',
    thumbnailUrl: demoPet,
    states: { idle: demoPet }
  }
]

let snapshot = {
  settings,
  pets,
  appVersion: '0.6.2',
  agent: {
    enabled: true,
    lastEvent: {
      id: 'demo-terminal',
      source: 'claude',
      env: 'terminal',
      sessionKey: 'demo',
      kind: 'needs_attention',
      message: 'Claude Code 需要你处理',
      timestampMs: now - 90_000,
      reason: 'needs_input',
      detail: '是否允许运行 npm test 验证表单校验改动？'
    },
    activeSessions: [
      { source: 'codex', sessionKey: 'demo-codex', lastSeenAt: now - 4_000 },
      { source: 'claude', sessionKey: 'demo-claude', lastSeenAt: now - 90_000 }
    ],
    lastCheckedAt: now - 1_200,
    error: null
  },
  isPackaged: false
}

const samplePets = [
  ['shiba', '柴柴', 'character', 'czy'],
  ['penguin', '企鹅', 'creature', 'czy'],
  ['froggle', '小青蛙', 'creature', 'czy'],
  ['rabbit', '小黄兔', 'creature', 'czy'],
  ['cat', '奶油猫', 'creature', 'petdex'],
  ['dragon', '小龙', 'creature', 'petdex'],
  ['robot', '小机器人', 'object', 'petdex'],
  ['ghost', '小幽灵', 'character', 'petdex'],
  ['fox', '狐狸', 'creature', 'petdex'],
  ['owl', '猫头鹰', 'creature', 'petdex'],
  ['plant', '盆栽', 'object', 'petdex'],
  ['star', '星星', 'object', 'petdex']
]

function petdexList() {
  return {
    ok: true,
    total: 5087,
    pets: samplePets.map(([slug, displayName, kind, author]) => ({
      slug,
      displayName,
      kind,
      author,
      spritesheetUrl: demoSheet,
      zipUrl: 'https://example.com/demo.zip'
    }))
  }
}

const noop = () => () => {}

contextBridge.exposeInMainWorld('petApi', {
  getSnapshot: async () => structuredClone(snapshot),
  updateSettings: async (partial) => {
    snapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, ...partial }
    }
    return structuredClone(snapshot)
  },
  selectPet: async (petId) => {
    snapshot = { ...snapshot, settings: { ...snapshot.settings, selectedPetId: petId } }
    return structuredClone(snapshot)
  },
  resetPetPosition: async () => undefined,
  showPet: async () => {
    snapshot = { ...snapshot, settings: { ...snapshot.settings, petVisible: true } }
  },
  hidePet: async () => {
    snapshot = { ...snapshot, settings: { ...snapshot.settings, petVisible: false } }
  },
  quitApp: async () => undefined,
  petClicked: () => undefined,
  petDragStart: () => undefined,
  petDragMove: () => undefined,
  petDragStop: () => undefined,
  setInteractive: () => undefined,
  agentSimulate: () => undefined,
  testAiSummary: async () => ({
    ok: true,
    text: '登录页的实时校验已经改好，正在等你确认是否运行测试。'
  }),
  pickSkin: async () => ({ kind: 'canceled' }),
  fetchPetdexList: async () => petdexList(),
  installPetdexPet: async () => ({ result: { ok: true, slug: 'shiba', name: '柴柴' }, snapshot }),
  importPetPack: async () => ({ ok: false, canceled: true, error: '' }),
  pickPetImage: async () => ({ ok: false, canceled: true, error: '' }),
  savePetImage: async () => ({ ok: false, canceled: true, error: '' }),
  deleteImportedPetPack: async () => structuredClone(snapshot),
  renameImportedPetPack: async (_id, name) => {
    snapshot = {
      ...snapshot,
      pets: snapshot.pets.map((pet) => (pet.id === 'shiba-demo' ? { ...pet, name } : pet))
    }
    return structuredClone(snapshot)
  },
  revealPetPacksFolder: async () => undefined,
  onSnapshot: noop,
  onShowBubble: noop,
  onPlayCodexAttentionSound: noop,
  onHideBubble: noop,
  onSetState: noop,
  onRecheckHover: noop
})
