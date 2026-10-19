/**
 * 本地视觉验收：截取桌宠窗口的气泡与状态表情。
 *
 *   pnpm exec electron --no-sandbox --disable-gpu scripts/capture-pet.cjs
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const outDir = join(root, 'docs', 'screenshots', 'redesign')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function capture(win, name) {
  const image = await win.webContents.capturePage()
  writeFileSync(join(outDir, `${name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({
    width: 600,
    height: 600,
    x: 120,
    y: 120,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#eae5d9',
    webPreferences: {
      preload: join(__dirname, 'pet-preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })

  await win.loadFile(join(root, 'out', 'renderer', 'index.html'), { hash: 'pet' })
  await wait(900)

  const bounds = win.getBounds()
  await win.webContents.executeJavaScript(
    `window.petDemo.bubble({
      text: 'Claude Code 需要你处理一下 🙋\\n是否允许运行 npm test 验证表单校验改动？',
      state: 'attention',
      durationMs: 60000,
      windowRect: ${JSON.stringify(bounds)},
      displayBounds: { x: 0, y: 0, width: 1440, height: 900 }
    })`
  )
  await wait(500)
  await capture(win, '17-pet-bubble')

  await win.webContents.executeJavaScript(`window.petDemo.hideBubble()`)
  await wait(250)
  await win.webContents.executeJavaScript(`window.petDemo.state('thinking', 60000)`)
  await wait(350)
  await capture(win, '18-pet-thinking')

  await win.webContents.executeJavaScript(`window.petDemo.state('failed', 60000)`)
  await wait(350)
  await capture(win, '19-pet-failed')

  // 深色主题下的气泡
  await win.webContents.executeJavaScript(`window.petDemo.theme('dark')`)
  await wait(350)
  await win.webContents.executeJavaScript(
    `window.petDemo.bubble({
      text: 'Claude Code 需要你处理一下 🙋\\n是否允许运行 npm test 验证表单校验改动？',
      state: 'attention',
      durationMs: 60000,
      windowRect: ${JSON.stringify(bounds)},
      displayBounds: { x: 0, y: 0, width: 1440, height: 900 }
    })`
  )
  await wait(500)
  await capture(win, '20-dark-pet-bubble')

  app.quit()
})
