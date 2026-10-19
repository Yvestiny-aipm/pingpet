/** 仅用于本地视觉验收：给桌宠窗口注入假数据，并暴露几个演示入口。 */
const { contextBridge } = require('electron')

const snapshot = {
  settings: {
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
    aiOpenaiBaseUrl: 'https://api.openai.com/v1',
    aiOpenaiApiKey: '',
    aiOpenaiModel: '',
    updateCheckEnabled: true,
    codexMonitoringEnabled: true,
    codexMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
    claudeMonitoringEnabled: true,
    claudeMonitoringEnvs: ['terminal', 'vscode', 'desktop'],
    cursorMonitoringEnabled: false,
    cursorMonitoringEnvs: ['terminal', 'desktop'],
    grokMonitoringEnabled: false,
    grokMonitoringEnvs: ['desktop']
  },
  pets: [
    {
      id: 'dango',
      name: '团子',
      kind: 'svg',
      source: 'official',
      accentColor: '#F0B27E',
      description: '软乎乎的奶油小猫'
    }
  ],
  appVersion: '0.6.2',
  agent: {
    enabled: true,
    lastEvent: null,
    activeSessions: [],
    lastCheckedAt: null,
    error: null
  },
  isPackaged: false
}

let bubbleCb = null
let stateCb = null
let hideCb = null

contextBridge.exposeInMainWorld('petApi', {
  getSnapshot: async () => structuredClone(snapshot),
  updateSettings: async () => structuredClone(snapshot),
  selectPet: async () => structuredClone(snapshot),
  resetPetPosition: async () => undefined,
  showPet: async () => undefined,
  hidePet: async () => undefined,
  quitApp: async () => undefined,
  petClicked: () => undefined,
  petDragStart: () => undefined,
  petDragMove: () => undefined,
  petDragStop: () => undefined,
  setInteractive: () => undefined,
  agentSimulate: () => undefined,
  testAiSummary: async () => ({ ok: true, text: '' }),
  pickSkin: async () => ({ kind: 'canceled' }),
  fetchPetdexList: async () => ({ ok: true, total: 0, pets: [] }),
  installPetdexPet: async () => ({ result: { ok: false, error: 'demo' }, snapshot }),
  importPetPack: async () => ({ ok: false, canceled: true, error: '' }),
  pickPetImage: async () => ({ ok: false, canceled: true, error: '' }),
  savePetImage: async () => ({ ok: false, canceled: true, error: '' }),
  deleteImportedPetPack: async () => structuredClone(snapshot),
  renameImportedPetPack: async () => structuredClone(snapshot),
  revealPetPacksFolder: async () => undefined,
  onSnapshot: () => () => undefined,
  onShowBubble: (cb) => {
    bubbleCb = cb
    return () => {
      bubbleCb = null
    }
  },
  onPlayCodexAttentionSound: () => () => undefined,
  onHideBubble: (cb) => {
    hideCb = cb
    return () => {
      hideCb = null
    }
  },
  onSetState: (cb) => {
    stateCb = cb
    return () => {
      stateCb = null
    }
  },
  onRecheckHover: () => () => undefined
})

contextBridge.exposeInMainWorld('petDemo', {
  bubble: (payload) => bubbleCb && bubbleCb(payload),
  hideBubble: () => hideCb && hideCb(),
  state: (state, durationMs) => stateCb && stateCb({ state, durationMs })
})
