/**
 * 新版本提醒。
 *
 * 为什么不是「静默自动更新」：macOS 上 electron-updater 走 Squirrel.Mac，安装前会校验新旧
 * 包的代码签名是否同源。本项目目前是 ad-hoc 签名（electron-builder.yml 里 identity: null），
 * 每次构建的签名都不同源，Squirrel 一定拒装。要做到真正的一键静默更新，前置条件是
 * Apple Developer ID 证书（付费账号）+ 公证，那是账号问题不是代码问题。
 *
 * 所以这里只做「发现有新版本 → 告诉用户 → 一键打开下载页」。等以后有了证书，换成
 * electron-updater 时这一层的判定逻辑（版本比较、是否跳过预发布）可以原样复用。
 *
 * 隐私：只向 GitHub 取一个版本号，不发送任何用户信息、不带任何标识。是否检查由设置控制。
 */

/** 官网与 release 都在这个仓库 */
const REPO = 'Yvestiny-aipm/pingpet'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** 单次请求超时：拿不到就当没有新版本，绝不让它影响启动或卡住主进程 */
const REQUEST_TIMEOUT_MS = 8_000

export interface UpdateInfo {
  /** 规范化后的版本号（去掉了 v 前缀），如 '0.2.0' */
  version: string
  /** 下载页地址 */
  url: string
}

/**
 * 解析版本号成可比较的数字段。只认 x.y.z（允许少写位数、允许 v 前缀）。
 * 带预发布后缀（-beta.1 等）的返回 null —— 宁可不提醒，也不要把用户推到预发布版上。
 */
export function parseVersion(raw: unknown): number[] | null {
  if (typeof raw !== 'string') return null
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** latest 是否严格新于 current。任一侧解析不出来就返回 false（宁可不提醒） */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

/**
 * 从 GitHub release 响应里挑出「该提醒的新版本」。
 * 草稿、预发布、版本号不比当前新的，一律返回 null。
 */
export function pickUpdate(release: unknown, currentVersion: string): UpdateInfo | null {
  if (!release || typeof release !== 'object') return null
  const r = release as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const tag = typeof r.tag_name === 'string' ? r.tag_name : ''
  const parsed = parseVersion(tag)
  if (!parsed) return null
  if (!isNewerVersion(tag, currentVersion)) return null
  const url = typeof r.html_url === 'string' && r.html_url.startsWith('https://')
    ? r.html_url
    : RELEASES_PAGE
  return { version: parsed.join('.'), url }
}

/**
 * 查一次 GitHub 最新 release。任何失败（离线、限流、超时、格式变了）都返回 null，
 * 不抛错、不写日志刷屏——检查更新失败对用户来说不是事故。
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub 要求带 UA；只写产品名和版本，不含任何可定位到用户的信息
        'User-Agent': `PingPet/${currentVersion}`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) return null
    return pickUpdate(await res.json(), currentVersion)
  } catch {
    return null
  }
}
