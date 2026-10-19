/**
 * 本地视觉验收：用构建产物 + 假数据截取设置台各页面。
 *
 *   pnpm exec electron scripts/capture-settings.cjs
 *
 * 输出到 docs/screenshots/redesign/。
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

async function clickTheme(win, label) {
  await win.webContents.executeJavaScript(
    `(() => {
      const target = [...document.querySelectorAll('.pp-theme-toggle button')]
        .find((el) => el.textContent.includes(${JSON.stringify(label)}))
      if (target) target.click()
      return Boolean(target)
    })()`
  )
  await wait(600)
}

async function clickNav(win, label) {
  await win.webContents.executeJavaScript(
    `(() => {
      const target = [...document.querySelectorAll('.pp-nav__item')]
        .find((el) => el.textContent.includes(${JSON.stringify(label)}))
      if (target) target.click()
      return Boolean(target)
    })()`
  )
  await wait(500)
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false,
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, 'capture-preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })

  await win.loadFile(join(root, 'out', 'renderer', 'index.html'), { hash: 'settings' })
  await wait(1200)
  await capture(win, '01-pet')

  await clickNav(win, '形象库')
  await capture(win, '02-gallery')

  await clickNav(win, '陪伴气泡')
  await capture(win, '03-bubble')

  await clickNav(win, 'Agent 监控')
  await capture(win, '04-agent')

  await clickNav(win, 'AI 总结')
  await capture(win, '05-ai-off')
  await win.webContents.executeJavaScript(
    `document.querySelector('.pp-ai-hero .pp-switch')?.click()`
  )
  await wait(450)
  await capture(win, '06-ai-on')

  await clickNav(win, '通用设置')
  await capture(win, '07-general')

  await clickNav(win, '桌宠')
  await win.webContents.executeJavaScript(
    `document.querySelector('.pp-pet-card:nth-child(4)')?.click()`
  )
  await wait(450)
  await capture(win, '08-pet-imported')

  // 深色主题
  await clickTheme(win, '深色')
  await clickNav(win, '桌宠')
  await capture(win, '09-dark-pet')
  await clickNav(win, '形象库')
  await capture(win, '10-dark-gallery')
  await clickNav(win, '陪伴气泡')
  await capture(win, '11-dark-bubble')
  await clickNav(win, 'Agent 监控')
  await capture(win, '12-dark-agent')
  await clickNav(win, 'AI 总结')
  await capture(win, '13-dark-ai')
  await clickNav(win, '通用设置')
  await capture(win, '14-dark-general')

  // 最小窗口尺寸下的布局检查（回到浅色）
  await clickTheme(win, '浅色')
  win.setSize(920, 680)
  await wait(600)
  await clickNav(win, '桌宠')
  await capture(win, '15-pet-narrow')
  await clickNav(win, 'AI 总结')
  await capture(win, '16-ai-narrow')

  app.quit()
})
