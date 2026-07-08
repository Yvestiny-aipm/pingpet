import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared')
}

/**
 * 生产构建时注入 CSP。
 * 开发模式不注入：@vitejs/plugin-react 的 HMR preamble 是内联脚本，会被 script-src 'self' 拦截。
 */
function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry: resolve(__dirname, 'src/main/main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    plugins: [react(), injectCsp()],
    resolve: { alias: sharedAlias }
  }
})
