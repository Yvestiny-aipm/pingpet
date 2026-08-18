import { safeStorage } from 'electron'

/**
 * API Key 的落盘加密。
 *
 * 之前 Key 是明文躺在 config.json 里的——任何能读到用户目录的程序（包括别的 Electron 应用、
 * 装错的脚本）都能直接拿走。这里改用系统级加密：macOS 走钥匙串、Windows 走 DPAPI，
 * 密钥由操作系统按「当前用户」保管，我们自己不持有也不落盘。
 *
 * 只加密落盘那一层：进程内和 IPC 传给设置界面的仍是明文（设置里那个输入框要显示原值），
 * 所以这解决的是「文件被别的程序读走」，不是「本机上有恶意程序读进程内存」。
 *
 * 三条硬约束（都是「宁可退回明文，也不能让用户的 Key 凭空消失」）：
 *  1. 系统不支持加密时（如某些 Linux 没有 keyring）照旧存明文，不能因此存不进去；
 *  2. 加密抛错时退回明文，同理；
 *  3. 解密失败时返回空串而不是乱码——乱码会被当成有效 Key 发到 API 去，
 *     用户看到的是莫名其妙的 401；空串则会让界面显示「没填 Key」，用户重填一次即可。
 */

/** 密文前缀：用来区分「已加密」和「老版本留下的明文」，也预留了换算法时的版本位 */
const ENC_PREFIX = 'enc.v1:'

/** safeStorage 在 app ready 之前不可用，所以每次现问、不缓存 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 磁盘上这个值是不是已经加密过了 */
export function isEncryptedAtRest(stored: unknown): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_PREFIX)
}

/** 明文 → 落盘形态。空串保持空串（表示「没填」，不需要也不应该加密） */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (!encryptionAvailable()) return plain
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return plain // 加密不了也得存下来，否则用户填的 Key 会凭空丢失
  }
}

/** 落盘形态 → 明文。认不出的一律当「没填」处理 */
export function decryptSecret(stored: unknown): string {
  if (typeof stored !== 'string' || stored === '') return ''
  // 老版本存的明文：原样返回，下一次写盘时会被自动加密
  if (!isEncryptedAtRest(stored)) return stored
  if (!encryptionAvailable()) return ''
  try {
    const cipher = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
    return safeStorage.decryptString(cipher)
  } catch {
    // 钥匙串条目被清掉 / 换了机器 / 密文损坏：当成没填，让用户重填，别把乱码发去 API
    return ''
  }
}
