/**
 * The loading-chain contract for the embedded browser, run through the real
 * bundled loader instead of a hand-built context.
 *
 * Production topology being reproduced: DSH Desktop inserts `dsh-browser-use` by
 * **file: URL** through `$DSH_HOME/desktop-host-sources.patch.yml`, a launcher-layer
 * row that carries no `inject:` of its own (and dsh never consumes a row-level
 * `inject:` anyway). The plugin therefore has to reach the model with its tools
 * from a module-level service declaration only.
 *
 * The regression guarded here is the one that made "the browser tools never show
 * up" undiagnosable: reading `ctx.tools` without declaring it throws
 * `cannot get property "tools" without inject` in cordis 4, and the old `apply()`
 * swallowed exactly that and returned — a plugin that "loaded" and registered zero
 * tools, with no failure for Desktop to attribute or recover from.
 *
 * A unit test with a plain object as the fake context cannot see any of this, which
 * is why both cases below boot a real profile in a temporary DSH_HOME.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePluginStartupFailures, PLUGIN_FAILURE_PREFIX } from '../src/shared/plugin-startup-failure'

const lockedDirectoryCodes = new Set(['EBUSY', 'EPERM', 'EACCES'])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (dir) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!code || !lockedDirectoryCodes.has(code) || attempt === 7) throw error
        await new Promise((wait) => setTimeout(wait, 25 * (attempt + 1)))
      }
    }
  }))
})

/**
 * A temporary DSH_HOME whose `web` profile loads nothing but the plugin row the
 * Desktop host would insert. `provideTools: false` models a Harness that has no
 * `tools` service at all.
 */
async function fixture(provideTools: boolean): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-browser-use-activation-'))
  roots.push(home)
  const profile = join(home, 'profiles', 'web')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: {},
    dsh: { profile: { bundles: [] } }
  }))
  await writeFile(join(profile, 'cordis.yml'), '[]')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]')

  const hostInsertedRow = {
    insert: [{
      id: 'dsh-browser-use',
      name: pathToFileURL(resolve('packages/dsh-browser-use/lib/index.js')).href
    }]
  }
  const entry = join(home, 'entry.mjs')
  await writeFile(entry, [
    `import { loadProfile, boot } from ${JSON.stringify(pathToFileURL(resolve('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)};`,
    `const profile = loadProfile('fixture', 'web', ${JSON.stringify(resolve('node_modules/@deepseek-ai/dsh/package.json'))}, ${JSON.stringify(home)});`,
    'const registered = [];',
    `await boot('fixture', ${JSON.stringify(join(profile, 'cordis.yml'))}, [`,
    '  ...profile.layers.flatMap(layer => layer.patches),',
    `  ${JSON.stringify(hostInsertedRow)},`,
    '], (ctx) => {',
    provideTools
      ? '  ctx.provide(\'tools\', { register: (tool) => { registered.push(tool.name); return () => {} } });'
      : '  // no tools service on this host at all',
    '});',
    'process.stdout.write(`TOOLS_REGISTERED:${JSON.stringify(registered)}\\n`);',
    ''
  ].join('\n'))
  return entry
}

function run(entry: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolve('build/harness-node-entry.mjs'), entry], {
    encoding: 'utf8',
    timeout: 40_000,
    env: { ...process.env, DSH_HOME: join(entry, '..') }
  })
  expect(result.error, String(result.error)).toBeUndefined()
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const registeredNames = (stdout: string): string[] => {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('TOOLS_REGISTERED:'))
  expect(line, stdout).toBeDefined()
  return JSON.parse(line!.slice('TOOLS_REGISTERED:'.length)) as string[]
}

describe('dsh-browser-use activation through the host-inserted profile', () => {
  it('registers every browser tool so the model can actually see them', async () => {
    const entry = await fixture(true)
    const { status, stdout, stderr } = run(entry)

    expect(status, stderr).toBe(0)
    expect(stderr).not.toContain(PLUGIN_FAILURE_PREFIX)
    const names = registeredNames(stdout)
    // The whole point: the model's tool list must contain the entry point the user
    // asked for, not just a plugin that reported "loaded" in the log.
    expect(names).toContain('browser_navigate')
    expect(names.filter((name) => name.startsWith('browser_'))).toHaveLength(16)
  })

  it('fails activation naming the missing service instead of loading with no tools', async () => {
    const entry = await fixture(false)
    const { status, stderr } = run(entry)

    // Declaring the dependency turns "silently useless" into an attributable
    // startup failure, which is what the Desktop recovery flow keys off.
    expect(status, stderr).toBe(1)
    const line = stderr.split('\n').find((candidate) => candidate.startsWith(PLUGIN_FAILURE_PREFIX))
    expect(line, stderr).toBeDefined()
    const failures = parsePluginStartupFailures(line!)
    expect(failures?.[0]).toMatchObject({
      stage: 'activate',
      message: expect.stringContaining('tools')
    })
  })
})
