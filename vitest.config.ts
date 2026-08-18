import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 每个测试文件单独进程：多个 scanner 测试会各自改写 process.env.HOME
    // 并且 grok 的扫描器带模块级状态，共享进程会互相污染
    isolate: true,
    pool: 'forks'
  }
})
