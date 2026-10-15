import { defineConfig } from 'vitest/config'

/**
 * 测试只跑 `test/` 下的东西，且**不需要 DOM**。
 *
 * 这一层刻意只测纯函数与"宿主契约"的适配层：origin 审批、配置归一、浏览器探测与
 * 启动参数、以及 cordis 上下文那条最容易写错的边界。它们不需要 Harness、不需要
 * 真浏览器、出错代价却最大 —— origin 判定松一格，模型就能替你访问任意站点；
 * `ctx.inject` 的回调是异步的这件事写错一次，HTTP 路由就静默挂不上，
 * 而症状是面板上一句"浏览器未启动"，跟"注册时机"隔了十万八千里。
 *
 * 真浏览器与界面不在这里测：那要靠真机装进 QuWork 看，见 README 的验证清单。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
})
