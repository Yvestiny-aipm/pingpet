/**
 * 设置台交互冒烟：用假数据跑一遍主要操作，任何未捕获异常或 console error 都算失败。
 *
 *   pnpm exec electron --no-sandbox --disable-gpu scripts/smoke-settings.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const root = join(__dirname, '..')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const problems = []

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true)

  const clickNav = async (label) => {
    const ok = await js(`(() => {
      const target = [...document.querySelectorAll('.pp-nav__item')]
        .find((el) => el.textContent.includes(${JSON.stringify(label)}))
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!ok) problems.push(`找不到导航：${label}`)
    await wait(420)
  }

  await wait(900)
  if (!(await js(`Boolean(document.querySelector('.pp-page'))`))) problems.push('设置台没有渲染')

  // 桌宠页：选择导入形象 → 改名 → 删除对话框取消
  await js(`document.querySelectorAll('.pp-pet-card')[3]?.click()`)
  await wait(300)
  await js(`document.querySelector('.pp-pet-card.is-selected .pp-pet-card__actions button')?.click()`)
  await wait(250)
  if (!(await js(`Boolean(document.querySelector('.pp-dialog input'))`))) problems.push('改名对话框没有打开')
  await js(`(() => {
    const input = document.querySelector('.pp-dialog input')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '新柴柴')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(150)
  await js(`[...document.querySelectorAll('.pp-dialog__foot .pp-btn')].find((b) => b.textContent.includes('保存'))?.click()`)
  await wait(350)
  if (!(await js(`document.body.innerText.includes('新柴柴')`))) problems.push('改名没有生效')
  await js(`document.querySelector('.pp-pet-card.is-selected .pp-pet-card__actions button.is-danger')?.click()`)
  await wait(250)
  if (!(await js(`document.body.innerText.includes('删除这个形象')`))) problems.push('删除确认没有打开')
  await js(`[...document.querySelectorAll('.pp-dialog__foot .pp-btn')].find((b) => b.textContent.includes('保留'))?.click()`)
  await wait(250)

  // 形象库：列表、搜索、类型筛选
  await clickNav('形象库')
  await wait(500)
  if (!(await js(`document.querySelectorAll('.pp-gallery-card').length >= 10`))) problems.push('形象库列表数量异常')
  await js(`(() => {
    const input = document.querySelector('.pp-search input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '柴')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(350)
  if (!(await js(`document.querySelectorAll('.pp-gallery-card').length === 1`))) problems.push('形象库搜索没有生效')
  await js(`document.querySelector('.pp-search__clear')?.click()`)
  await clickNav('陪伴气泡')
  await js(`[...document.querySelectorAll('.pp-anchor-preset')].find((b) => b.textContent.includes('右侧'))?.click()`)
  await wait(250)
  if (!(await js(`[...document.querySelectorAll('.pp-anchor-preset')].find((b) => b.textContent.includes('右侧'))?.classList.contains('is-active')`))) {
    problems.push('气泡方向预设没有生效')
  }
  await clickNav('Agent 监控')
  await js(`document.querySelector('.pp-disclosure')?.click()`)
  await wait(300)
  if (!(await js(`Boolean(document.querySelector('.pp-advanced'))`))) problems.push('高级面板没有展开')
  if (!(await js(`document.querySelectorAll('.pp-dev-tools .pp-btn').length === 16`))) problems.push('开发模拟按钮数量异常')

  // AI：开启 → 切 OpenAI 兼容 → 测试连接
  await clickNav('AI 总结')
  await js(`document.querySelector('.pp-ai-hero .pp-switch')?.click()`)
  await wait(350)
  await js(`[...document.querySelectorAll('.pp-segmented__item')].find((b) => b.textContent.includes('OpenAI 兼容'))?.click()`)
  await wait(350)
  if (!(await js(`Boolean(document.querySelector('.pp-input[placeholder="https://api.openai.com/v1"]'))`))) {
    problems.push('OpenAI 兼容的 Base URL 没有出现')
  }
  await js(`[...document.querySelectorAll('.pp-btn')].find((b) => b.textContent.includes('测试连接'))?.click()`)
  await wait(500)
  if (!(await js(`Boolean(document.querySelector('.pp-test-result.is-ok'))`))) problems.push('测试连接结果没有显示')

  await js(`document.querySelector('.pp-scroll').scrollTop = 600`)
  await clickNav('通用设置')
  if (!(await js(`document.body.innerText.includes('隐私边界')`))) problems.push('通用设置内容缺失')
  if (!(await js(`document.querySelector('.pp-scroll').scrollTop === 0`))) problems.push('切页后没有回到顶部')
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'capture-preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })

  win.webContents.on('console-message', (_event, level, message) => {
    // 本地验收用的假数据窗口必然关 webSecurity，Electron 的安全警告不算业务错误
    if (level >= 2 && !message.includes('Electron Security Warning')) {
      problems.push(`console: ${message}`)
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    problems.push(`renderer gone: ${JSON.stringify(details)}`)
  })

  try {
    await win.loadFile(join(root, 'out', 'renderer', 'index.html'), { hash: 'settings' })
    await run(win)
  } catch (error) {
    problems.push(String(error && error.stack ? error.stack : error))
  }

  if (problems.length) {
    console.error('SMOKE FAILED')
    for (const problem of problems) console.error(`- ${problem}`)
    app.exit(1)
    return
  }

  console.log('SMOKE OK')
  app.exit(0)
})
