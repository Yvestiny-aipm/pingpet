export type PageKey = 'pet' | 'gallery' | 'bubble' | 'agent' | 'general'

export interface ToastState {
  id: number
  message: string
  tone: 'default' | 'error'
}
