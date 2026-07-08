import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AgentEventKind,
  AgentSource,
  BubblePayload,
  DragPoint,
  PetApi,
  PetStatePayload,
  Settings,
  Snapshot,
  WindowPoint
} from '@shared/types'
import { IPC } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: PetApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.GetSnapshot),
  updateSettings: (partial: Partial<Settings>) => ipcRenderer.invoke(IPC.UpdateSettings, partial),
  selectPet: (petId: string) => ipcRenderer.invoke(IPC.SelectPet, petId),
  resetPetPosition: () => ipcRenderer.invoke(IPC.ResetPetPosition),
  showPet: () => ipcRenderer.invoke(IPC.ShowPet),
  hidePet: () => ipcRenderer.invoke(IPC.HidePet),
  quitApp: () => ipcRenderer.invoke(IPC.QuitApp),
  petClicked: () => ipcRenderer.send(IPC.PetClicked),
  petDragStart: (point: DragPoint) => ipcRenderer.send(IPC.DragStart, point),
  petDragMove: (point: DragPoint) => ipcRenderer.send(IPC.DragMove, point),
  petDragStop: () => ipcRenderer.send(IPC.DragStop),
  setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.SetInteractive, interactive),
  agentSimulate: (source: AgentSource, kind: AgentEventKind) =>
    ipcRenderer.send(IPC.AgentSimulate, source, kind),
  pickSkin: () => ipcRenderer.invoke(IPC.PickSkin),
  fetchPetdexList: () => ipcRenderer.invoke(IPC.FetchPetdexList),
  installPetdexPet: (zipUrl: string, displayName: string) =>
    ipcRenderer.invoke(IPC.InstallPetdexPet, zipUrl, displayName),
  importPetPack: () => ipcRenderer.invoke(IPC.ImportPetPack),
  pickPetImage: () => ipcRenderer.invoke(IPC.PickPetImage),
  savePetImage: (dataUrl: string, name: string) =>
    ipcRenderer.invoke(IPC.SavePetImage, dataUrl, name),
  deleteImportedPetPack: (petId: string) =>
    ipcRenderer.invoke(IPC.DeleteImportedPetPack, petId),
  renameImportedPetPack: (petId: string, name: string) =>
    ipcRenderer.invoke(IPC.RenameImportedPetPack, petId, name),
  revealPetPacksFolder: () => ipcRenderer.invoke(IPC.RevealPetPacksFolder),
  onSnapshot: (cb) => subscribe<Snapshot>(IPC.OnSnapshot, cb),
  onShowBubble: (cb) => subscribe<BubblePayload>(IPC.OnShowBubble, cb),
  onHideBubble: (cb) => subscribe<void>(IPC.OnHideBubble, () => cb()),
  onSetState: (cb) => subscribe<PetStatePayload>(IPC.OnSetState, cb),
  onRecheckHover: (cb) => subscribe<WindowPoint>(IPC.OnRecheckHover, cb)
}

contextBridge.exposeInMainWorld('petApi', api)
