/**
 * origin 审批这一层的测试。
 *
 * ## 为什么这几个用例必须存在
 *
 * `check()` 是**模型能碰到的唯一一道站点闸门**：它松一格，模型就能替你打开任意站点；
 * 它紧一格，用户说了"允许"之后依然寸步难行（而症状是"模型说它批准了但还是不动"，
 * 从对话里根本看不出是 policy 没记住）。
 *
 * 三个分支各自对着一类真实误判：
 * - `about:blank` / `chrome://` 这类**没有 origin 的 URL** 必须放行 ——
 *   否则连"打开一个空白页"都要用户先批准，而这个批准请求本身没法解释；
 * - `newOriginPolicy = 'deny'` 要在 `ensure()` 之前就拒掉（见 service.ts 的注释），
 *   所以这里只测 `check()` 的判定，不测启动；
 * - 运行时 `approve()` 之后**必须真的放行** —— 这是"用户说允许"的唯一落点。
 */
import { describe, expect, it } from 'vitest'

import { OriginPolicy } from '../src/policy.js'

describe('OriginPolicy.check', () => {
  it('没有 origin 的 URL 一律放行（about:blank / chrome:// / 非法 URL）', () => {
    const p = new OriginPolicy([], 'deny')
    // 即便策略是 deny，这些也必须过 —— 它们不是"某个站点"
    for (const url of ['about:blank', 'chrome://settings', 'devtools://devtools/x', '', 'no-a-url']) {
      expect(p.check(url), url).toEqual({ verdict: 'allow', origin: '' })
    }
  })

  it('预批准的 origin 放行，且 origin 归一成不带路径的形式', () => {
    const p = new OriginPolicy(['https://ops.rrzu.com'], 'ask')
    expect(p.check('https://ops.rrzu.com/super/v4-order/index?a=1')).toEqual({
      verdict: 'allow',
      origin: 'https://ops.rrzu.com',
    })
  })

  it('未批准的站点按 newOriginPolicy 走三种策略', () => {
    expect(new OriginPolicy([], 'ask').check('https://new.example/x').verdict).toBe('needs_approval')
    expect(new OriginPolicy([], 'allow').check('https://new.example/x').verdict).toBe('allow')
    expect(new OriginPolicy([], 'deny').check('https://new.example/x').verdict).toBe('deny')
  })

  it('运行时 approve 之后真的放行（用户说"允许"的唯一落点）', () => {
    const p = new OriginPolicy([], 'ask')
    const url = 'https://new.example/page'
    expect(p.check(url).verdict).toBe('needs_approval')
    p.approve('https://new.example')
    expect(p.check(url).verdict).toBe('allow')
    expect(p.isApproved('https://new.example')).toBe(true)
  })

  it('端口算 origin 的一部分，不能与不带端口的站点混为一谈', () => {
    const p = new OriginPolicy(['https://a.com:8443'], 'ask')
    expect(p.check('https://a.com:8443/x').verdict).toBe('allow')
    expect(p.check('https://a.com/x').verdict).toBe('needs_approval')
  })

  it('http 与 https 是两个不同的 origin', () => {
    const p = new OriginPolicy(['http://a.com'], 'ask')
    expect(p.check('http://a.com/x').verdict).toBe('allow')
    expect(p.check('https://a.com/x').verdict).toBe('needs_approval')
  })
})

describe('OriginPolicy.approvalMessage', () => {
  it('给出的是可执行指令：先问用户，再说批哪个 origin', () => {
    const msg = new OriginPolicy([], 'ask').approvalMessage('https://new.example')
    // 这段话是发给**模型**看的，几条缺一不可：站点、问用户、用什么工具批准
    expect(msg).toContain('NEEDS_APPROVAL')
    expect(msg).toContain('https://new.example')
    expect(msg).toContain('browser_approve_origin')
  })
})
