import { describe, expect, it } from 'vitest'
import { AGENT_SOURCES, AGENT_SOURCE_IDS, AGENT_SOURCE_LIST } from './agents'
import { AGENT_SCANNERS } from '../main/agent/scanners'
import { DEFAULT_SETTINGS } from './defaults'
import { AGENT_ENVS } from './types'
import type { AgentSource } from './types'

/**
 * 登记处的「完整性」在几个地方是靠 as 断言过的（用循环填 Record 时 TS 没法确认已填满）：
 * defaults.ts 的 agentMonitoringDefaults、main.ts 的 monitorConfigFromSettings。
 * 这些用例就是补回那份被 as 绕过去的检查——新增一家 Agent 只填了一半时，这里会红。
 */

// 手写一份来源清单：如果 AgentSource 加了新家，这里编译不过（Record 缺 key），
// 从而提醒「下面这些断言要覆盖到它」。比 Object.keys 更能挡住漏改。
const EXPECTED_SOURCES: Record<AgentSource, true> = {
  codex: true,
  claude: true,
  cursor: true,
  grok: true
}
const ALL_SOURCES = Object.keys(EXPECTED_SOURCES) as AgentSource[]

describe('登记处覆盖每一家', () => {
  it('AGENT_SOURCES 有全部来源，且 source 字段和键一致', () => {
    for (const source of ALL_SOURCES) {
      expect(AGENT_SOURCES[source]).toBeDefined()
      expect(AGENT_SOURCES[source].source).toBe(source)
    }
  })

  it('AGENT_SOURCE_LIST / AGENT_SOURCE_IDS 与 AGENT_SOURCES 数量一致', () => {
    expect(AGENT_SOURCE_LIST).toHaveLength(ALL_SOURCES.length)
    expect([...AGENT_SOURCE_IDS].sort()).toEqual([...ALL_SOURCES].sort())
  })

  it('每一家都登记了扫描器', () => {
    for (const source of ALL_SOURCES) {
      expect(typeof AGENT_SCANNERS[source]).toBe('function')
    }
  })
})

describe('默认设置里每一家的字段都在', () => {
  it('开关字段存在且是布尔（缺了会让那家的选择静默存不进去）', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      expect(typeof DEFAULT_SETTINGS[meta.enabledKey]).toBe('boolean')
      expect(DEFAULT_SETTINGS[meta.enabledKey]).toBe(meta.defaultEnabled)
    }
  })

  it('环境字段存在且是数组', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      expect(Array.isArray(DEFAULT_SETTINGS[meta.envsKey])).toBe(true)
      expect(DEFAULT_SETTINGS[meta.envsKey]).toEqual([...meta.defaultEnvs])
    }
  })

  it('默认环境是该家真正支持的环境的子集（不然一开机就有个永不触发的档位）', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      for (const env of meta.defaultEnvs) {
        expect(meta.envs).toContain(env)
      }
    }
  })

  it('字段名与来源一致，改名时不会张冠李戴', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      expect(meta.enabledKey).toBe(`${meta.source}MonitoringEnabled`)
      expect(meta.envsKey).toBe(`${meta.source}MonitoringEnvs`)
    }
  })
})

describe('元信息本身是自洽的', () => {
  it('可监听环境只能取自 AGENT_ENVS，且不为空', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      expect(meta.envs.length).toBeGreaterThan(0)
      for (const env of meta.envs) expect(AGENT_ENVS).toContain(env)
    }
  })

  it('环境不全的家必须写明原因——否则用户只会以为是坏了', () => {
    for (const meta of AGENT_SOURCE_LIST) {
      if (meta.envs.length < AGENT_ENVS.length) {
        expect(meta.envLimitReason, `${meta.source} 少了环境却没写原因`).toBeTruthy()
      }
    }
  })

  it('显示名不为空且互不重复', () => {
    const labels = AGENT_SOURCE_LIST.map((m) => m.label)
    for (const label of labels) expect(label.trim()).not.toBe('')
    expect(new Set(labels).size).toBe(labels.length)
  })
})
