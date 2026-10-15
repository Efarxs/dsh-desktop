/**
 * 浏览器探测 / 启动参数 / 端口文件这一层的测试。
 *
 * ## 为什么这几件事值得单独测
 *
 * 它们全是**没有浏览器也能测的纯逻辑**，而错了的后果都要等用户报"浏览器起不来"才知道：
 *
 * - `buildLaunchArgs` 少一个 `--user-data-dir`，插件就会去操作**用户日常的 Chrome**
 *   （起不来还是轻的，重的是往人家正在用的窗口里乱点）；多一个 `0.0.0.0`
 *   就是把调试端口开到局域网上；
 * - `readActivePort` 只看文件不看探活 —— 上一轮把这条坑记在 launch.ts 的文件头里，
 *   这里用真实文件把它钉死：**陈旧端口必须被判死**；
 * - `liveEndpointFromProfile` 是"复用上一个还活着的实例"的唯一入口。
 *   它误判成"活着"→ 拿着死端口等 CDP 超时（就是那个查了两轮的 20 秒超时）；
 *   它误判成"死了"→ 又起一个实例撞 SingletonLock。
 *
 * 这里用真实文件 + 一个假的 CDP 端点（本地 http server 冒充 `/json/version`）来测，
 * **不需要真的装浏览器**。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildLaunchArgs,
  candidatePaths,
  clearActivePort,
  detectBrowsers,
  liveEndpointFromProfile,
  pickBrowser,
  portOf,
  readActivePort,
} from '../src/browser/launch.js'

const temps: string[] = []
const servers: Server[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-bu-launch-'))
  temps.push(d)
  return d
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 起一个冒牌 CDP 端点（只要 `/json/version` 返回 200 就算"活着"）。 */
async function fakeCdp(status = 200): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === '/json/version' && status === 200) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Fake/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1/x' }))
      return
    }
    res.writeHead(status)
    res.end('nope')
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('拿不到端口')
  return addr.port
}

describe('buildLaunchArgs', () => {
  it('必带的几项：调试端口、独立 profile、open 的 url', () => {
    const args = buildLaunchArgs(0, 'D:/profile', 'https://start.example')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain('--user-data-dir=D:/profile')
    expect(args.at(-1)).toBe('https://start.example')
  })

  it('讨厌的首次运行弹窗与后台联网要关掉（否则第一次启动会卡在向导页）', () => {
    const args = buildLaunchArgs(1, 'p', 'u')
    for (const flag of ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync']) {
      expect(args, flag).toContain(flag)
    }
  })

  it('绝不出现 0.0.0.0 或任何非回环的暴露面', () => {
    const line = buildLaunchArgs(0, 'p', 'u').join(' ')
    expect(line).not.toContain('0.0.0.0')
    expect(line).not.toContain('--remote-debugging-address')
    // 只允许回环来源连上来
    expect(line).toContain('--remote-allow-origins=http://127.0.0.1/*')
  })
})

describe('portOf', () => {
  it('从 endpoint 里取端口，取不到就是 0', () => {
    expect(portOf('http://127.0.0.1:9222')).toBe(9222)
    expect(portOf('http://127.0.0.1')).toBe(0)
    expect(portOf('不是 url')).toBe(0)
  })
})

describe('detectBrowsers / pickBrowser', () => {
  it('Windows 上按标准安装位置找 Chrome 与 Edge', () => {
    const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' }
    expect(candidatePaths('edge', 'win32', env)).toContain('C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(candidatePaths('chrome', 'win32', env)).toContain('C:\\PF\\Google\\Chrome\\Application\\chrome.exe')
    // LOCALAPPDATA 下的用户级安装也要覆盖到（管理员权限装不上时的常见落点）
    expect(candidatePaths('chrome', 'win32', env)).toContain('C:\\LA\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('macOS / Linux 的路径各自对', () => {
    expect(candidatePaths('chrome', 'darwin', {})).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(candidatePaths('edge', 'darwin', {})).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    expect(candidatePaths('chrome', 'linux', { PATH: '/usr/bin' })).toContain('/opt/google/chrome/chrome')
  })

  it('pickBrowser: auto 取第一个（Edge 优先），指定了就只认那一个', () => {
    const cands = [
      { kind: 'edge' as const, label: 'Microsoft Edge', path: 'e' },
      { kind: 'chrome' as const, label: 'Google Chrome', path: 'c' },
    ]
    expect(pickBrowser(cands, 'auto')?.kind).toBe('edge')
    expect(pickBrowser(cands, 'chrome')?.kind).toBe('chrome')
    expect(pickBrowser([cands[1]!], 'edge')).toBeUndefined()
    expect(pickBrowser([], 'auto')).toBeUndefined()
  })

  it('本机没装浏览器时返回空数组，不抛（探测本身失败也不能让插件加载不了）', () => {
    // detectBrowsers 默认用真实 existsSync 与真实的 process.platform；
    // 这里只断言"不抛且是数组"，具体找到什么取决于跑测试的机器。
    expect(Array.isArray(detectBrowsers())).toBe(true)
  })
})

describe('DevToolsActivePort 的读写', () => {
  it('读第一行当端口；文件不存在/内容是垃圾都返回 undefined', () => {
    const dir = tempDir()
    expect(readActivePort(dir)).toBeUndefined()

    writeFileSync(join(dir, 'DevToolsActivePort'), '51791\n/devtools/browser/abc\n')
    expect(readActivePort(dir)).toBe(51791)

    writeFileSync(join(dir, 'DevToolsActivePort'), 'not-a-number\n')
    expect(readActivePort(dir)).toBeUndefined()

    writeFileSync(join(dir, 'DevToolsActivePort'), '0\n')
    expect(readActivePort(dir)).toBeUndefined()
  })

  it('clearActivePort 把文件删掉；本来不存在也不抛', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'DevToolsActivePort'), '1234\n')
    clearActivePort(dir)
    expect(readActivePort(dir)).toBeUndefined()
    // 再删一次：不抛
    expect(() => clearActivePort(dir)).not.toThrow()
    // 目录都不存在：也不抛
    expect(() => clearActivePort(join(dir, '没有这个目录'))).not.toThrow()
  })
})

describe('liveEndpointFromProfile', () => {
  it('★ 陈旧端口必须被判死 —— 这条坑就是那个"等 CDP 超时"的根因', async () => {
    const dir = tempDir()
    // 51791 是实测踩过的那个陈旧端口号：文件还在，但没人在听
    writeFileSync(join(dir, 'DevToolsActivePort'), '51791\n')
    expect(await liveEndpointFromProfile(dir)).toBeUndefined()
  })

  it('没有端口文件时返回 undefined（从没启动过）', async () => {
    expect(await liveEndpointFromProfile(tempDir())).toBeUndefined()
  })

  it('端口真的有人听时返回可用的 endpoint（复用上一个实例）', async () => {
    const port = await fakeCdp()
    const dir = tempDir()
    writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`)
    expect(await liveEndpointFromProfile(dir)).toBe(`http://127.0.0.1:${port}`)
  })

  it('端口上有人但不是 CDP（返回非 2xx）时也算死', async () => {
    const port = await fakeCdp(500)
    const dir = tempDir()
    writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n`)
    expect(await liveEndpointFromProfile(dir)).toBeUndefined()
  })
})
