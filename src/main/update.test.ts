import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseVersion, pickUpdate } from './update'

/**
 * 版本比较错一位的后果是「明明有新版却不提醒」或「反复提醒同一个版本」，
 * 而这类错误在本机永远试不出来（本机版本号只有一个）。所以全靠这些用例。
 */

describe('parseVersion', () => {
  it.each([
    ['1.2.3', [1, 2, 3]],
    ['v1.2.3', [1, 2, 3]],
    [' 0.1.0 ', [0, 1, 0]],
    ['2', [2, 0, 0]],
    ['2.5', [2, 5, 0]],
    ['v10.20.30', [10, 20, 30]]
  ])('%s → %j', (raw, expected) => {
    expect(parseVersion(raw)).toEqual(expected)
  })

  it.each(['', 'latest', '1.2.3-beta.1', 'v1.2.3+build', 'x.y.z', '1.2.3.4', null, undefined, 42])(
    '%s 解析不出来 → null',
    (raw) => {
      expect(parseVersion(raw)).toBeNull()
    }
  )
})

describe('isNewerVersion', () => {
  it.each([
    ['0.2.0', '0.1.0'],
    ['1.0.0', '0.9.9'],
    ['0.1.1', '0.1.0'],
    ['0.10.0', '0.9.0'], // 按数字比而不是按字符串，10 > 9
    ['v0.2.0', '0.1.0']
  ])('%s 新于 %s', (latest, current) => {
    expect(isNewerVersion(latest, current)).toBe(true)
  })

  it.each([
    ['0.1.0', '0.1.0'], // 一样就不提醒，否则每次启动都弹
    ['0.1.0', '0.2.0'], // 本机版本更新（开发中）时不要提醒降级
    ['0.9.0', '0.10.0'],
    ['1.2.3-beta.1', '1.0.0'], // 预发布不推给用户
    ['garbage', '0.1.0'],
    ['0.2.0', 'garbage']
  ])('%s 不新于 %s', (latest, current) => {
    expect(isNewerVersion(latest, current)).toBe(false)
  })
})

describe('pickUpdate', () => {
  const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/Yvestiny-aipm/pingpet/releases/tag/v0.2.0',
    draft: false,
    prerelease: false,
    ...over
  })

  it('有更新时返回规范化版本号与下载页', () => {
    expect(pickUpdate(release(), '0.1.0')).toEqual({
      version: '0.2.0',
      url: 'https://github.com/Yvestiny-aipm/pingpet/releases/tag/v0.2.0'
    })
  })

  it('版本相同 → 不提醒', () => {
    expect(pickUpdate(release({ tag_name: 'v0.1.0' }), '0.1.0')).toBeNull()
  })

  it('草稿 → 不提醒', () => {
    expect(pickUpdate(release({ draft: true }), '0.1.0')).toBeNull()
  })

  it('预发布 → 不提醒', () => {
    expect(pickUpdate(release({ prerelease: true }), '0.1.0')).toBeNull()
  })

  it('html_url 不是 https 时回落到固定的 releases 页，不跟着响应跳任意地址', () => {
    const got = pickUpdate(release({ html_url: 'javascript:alert(1)' }), '0.1.0')
    expect(got?.url).toBe('https://github.com/Yvestiny-aipm/pingpet/releases/latest')
  })

  it.each([null, undefined, 'oops', {}, { tag_name: 'nightly' }])(
    '响应是 %s 时安静返回 null',
    (payload) => {
      expect(pickUpdate(payload, '0.1.0')).toBeNull()
    }
  )
})
