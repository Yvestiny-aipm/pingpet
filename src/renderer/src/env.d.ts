/// <reference types="vite/client" />

import type { PetApi } from '@shared/types'

declare global {
  interface Window {
    petApi: PetApi
  }
}

export {}
