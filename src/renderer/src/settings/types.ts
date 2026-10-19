export type PageKey = 'pet' | 'gallery' | 'bubble' | 'agent' | 'ai' | 'general'

export type AiProviderChoice = 'anthropic' | 'siliconflow' | 'openai'

export interface ToastState {
  id: number
  message: string
  tone: 'default' | 'error'
}
