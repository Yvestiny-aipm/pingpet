import { execFile } from 'node:child_process'

/**
 * Cursor 主进程是否在运行。
 *
 * 只用于「强制退出 / 崩溃」兜底：正常结束会先写 turn_ended，进程监视不会触发。
 * 只认 macOS 的 Cursor.app 主进程 `Cursor`；Helper 进程不参与判断，
 * 否则主进程退出后 Helper 还没退干净，会漏报。
 *
 * 非 macOS 返回 undefined，表示当前平台不启用这条兜底，而不是「没运行」。
 */
export function createCursorProcessProbe(): () => boolean | undefined {
  if (process.platform !== 'darwin') return () => undefined

  let lastKnown: boolean | undefined
  let inFlight = false

  const refresh = (): void => {
    if (inFlight) return
    inFlight = true
    execFile('pgrep', ['-x', 'Cursor'], { timeout: 1_000 }, (err, stdout) => {
      inFlight = false
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') {
        lastKnown = undefined
        return
      }
      // pgrep 无匹配时退出码为 1；其它错误也保守当作「没在运行」。
      lastKnown = !err && stdout.trim().length > 0
    })
  }

  refresh()
  const timer = setInterval(refresh, 2_000)
  // 不阻止 Node / Electron 退出；probe 随主进程生命周期存在。
  timer.unref()

  return () => lastKnown
}
