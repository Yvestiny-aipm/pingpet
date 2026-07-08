import type { PetApi } from '@shared/types'

/** preload 注入的安全 API，渲染进程统一从这里取用 */
export const api: PetApi = window.petApi
