import { describe, expect, it } from 'vitest'
import { classifyStopText } from './classify'

/**
 * 这份关键词表被刻意收紧过（2026-07-06）：宁漏勿误报。
 * 下面「不该命中」的用例记录的是产品决定而不是实现细节——如果哪天有人为了「多认出一些
 * 需要你处理」把 需要你 / 请确认 / 要不要 这类客套话加回去，正常完成的回复会被大量误判成
 * needs_attention，用户看到的是「宠物老说要我处理，其实早干完了」。
 */

describe('该命中的高置信信号', () => {
  it.each([
    ['这一步需要你授权才能继续', 'needs_attention'],
    ['是否允许我改这个文件', 'needs_attention'],
    ['waiting for your input', 'needs_attention'],
    ['请选择一个方案', 'needs_attention'],
    ['已完成，改动都提交了', 'done'],
    ['修好了', 'done'],
    ['all set', 'done'],
    ['构建失败，报错如下', 'failed'],
    ['traceback (most recent call last)', 'failed'],
    ['任务已被中断', 'failed']
  ])('%s → %s', (text, kind) => {
    expect(classifyStopText(text)?.kind).toBe(kind)
  })

  it('中断优先于完成（两类词同时出现时按更严重的算）', () => {
    const r = classifyStopText('已完成一部分，但任务被中断了')
    expect(r?.kind).toBe('failed')
    expect(r?.reason).toBe('interrupted')
  })

  it('等你处理优先于完成', () => {
    expect(classifyStopText('前两步已完成，是否允许我继续第三步')?.reason).toBe('needs_input')
  })
})

describe('刻意不命中的宽泛措辞（防误报）', () => {
  it.each([
    '需要你确认一下这个改法合不合适',
    '请确认下我理解得对不对',
    '要不要我顺手把测试也加上',
    'should i also update the docs',
    'would you like me to continue'
  ])('%s 不判为 needs_attention', (text) => {
    expect(classifyStopText(text)?.kind).not.toBe('needs_attention')
  })

  it.each([
    '顺手补了错误处理的分支',
    '加了失败重试，避免偶发失败',
    '这段代码原本有异常没接住，已修正'
  ])('%s 不判为 failed（正常完成里提到「错误/失败/异常」不算出错）', (text) => {
    expect(classifyStopText(text)?.kind).not.toBe('failed')
  })

  it('认不出类别时返回 null，交给调用方兜底', () => {
    expect(classifyStopText('嗯')).toBeNull()
    expect(classifyStopText('')).toBeNull()
  })
})
