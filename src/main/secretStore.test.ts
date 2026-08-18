import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 这里测的是「Key 绝不会凭空消失、也绝不会变成乱码发去 API」这两条底线。
 * safeStorage 是 Electron 运行时提供的，测试里用假实现替掉，并可切换成
 * 「系统不支持加密」和「加解密抛错」两种坏情况。
 */

const state = {
  available: true,
  throwOnEncrypt: false,
  throwOnDecrypt: false
}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      if (!state.available) return false
      return true
    },
    encryptString: (plain: string) => {
      if (state.throwOnEncrypt) throw new Error('keychain locked')
      return Buffer.from(`sealed:${plain}`, 'utf8')
    },
    decryptString: (buf: Buffer) => {
      if (state.throwOnDecrypt) throw new Error('keychain entry gone')
      const s = buf.toString('utf8')
      if (!s.startsWith('sealed:')) throw new Error('bad ciphertext')
      return s.slice('sealed:'.length)
    }
  }
}))

const { decryptSecret, encryptSecret, isEncryptedAtRest } = await import('./secretStore')

const KEY = 'sk-ant-api03-abcdef1234567890'

beforeEach(() => {
  state.available = true
  state.throwOnEncrypt = false
  state.throwOnDecrypt = false
})

describe('正常路径', () => {
  it('加密后再解密拿回原值', () => {
    expect(decryptSecret(encryptSecret(KEY))).toBe(KEY)
  })

  it('落盘形态里不再出现明文 Key', () => {
    expect(encryptSecret(KEY)).not.toContain(KEY)
  })

  it('空串（没填 Key）保持空串，不做加密', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBe('')
  })
})

describe('从老版本的明文迁移', () => {
  it('读到没有前缀的明文时原样返回，不当成损坏数据丢掉', () => {
    expect(decryptSecret(KEY)).toBe(KEY)
  })

  it('能区分明文与密文，便于启动时判断要不要重写一次', () => {
    expect(isEncryptedAtRest(KEY)).toBe(false)
    expect(isEncryptedAtRest(encryptSecret(KEY))).toBe(true)
  })
})

describe('系统不支持加密时（如无 keyring 的 Linux）', () => {
  it('退回存明文，不能让用户填的 Key 存不进去', () => {
    state.available = false
    expect(encryptSecret(KEY)).toBe(KEY)
  })

  it('已加密的值在系统不可用时读成空串，而不是乱码', () => {
    const sealed = encryptSecret(KEY)
    state.available = false
    expect(decryptSecret(sealed)).toBe('')
  })
})

describe('加解密出错时', () => {
  it('加密抛错 → 退回明文，宁可不加密也不能丢 Key', () => {
    state.throwOnEncrypt = true
    expect(encryptSecret(KEY)).toBe(KEY)
  })

  it('解密抛错（钥匙串条目被清掉）→ 空串，让用户重填而不是拿乱码去请求', () => {
    const sealed = encryptSecret(KEY)
    state.throwOnDecrypt = true
    expect(decryptSecret(sealed)).toBe('')
  })

  it('密文被截断损坏 → 空串', () => {
    const sealed = encryptSecret(KEY)
    expect(decryptSecret(sealed.slice(0, 12))).toBe('')
  })
})

describe('脏数据', () => {
  it.each([undefined, null, 123, {}, []])('非字符串输入 %s 读成空串', (input) => {
    expect(decryptSecret(input)).toBe('')
  })
})
