/**
 * Sandboxed preloads can only require their own bundle: when both preload entries
 * reach the same module through a *value* import, the bundler splits it into
 * `out/preload/chunks/*.cjs`, Electron then fails with `module not found`, and the
 * desktop bridge disappears from the page. That is a build-graph fact no runtime test
 * in this repository can see, so it is pinned here instead.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const INDEX_ENTRY = 'src/preload/index.ts'
const PANE_ENTRY = 'src/preload/agent-browser-pane.ts'
const PRELOAD_ENTRIES = [INDEX_ENTRY, PANE_ENTRY]

const IMPORT = /(^|\n)\s*import\s+([\s\S]*?)\s+from\s+'(\.[^']+)'/g

/** Every binding in the clause is `type`-only, so the import disappears at build time. */
function isTypeOnly(clause: string): boolean {
  const trimmed = clause.trim()
  if (trimmed.startsWith('type ')) return true
  if (!trimmed.startsWith('{')) return false
  const bindings = trimmed.slice(1, trimmed.lastIndexOf('}')).split(',').map((item) => item.trim()).filter(Boolean)
  return bindings.length > 0 && bindings.every((binding) => binding.startsWith('type ') || binding === 'type')
}

function valueReachable(entry: string): Set<string> {
  const found = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    const source = readFileSync(resolve(projectRoot, file), 'utf8')
    for (const match of source.matchAll(IMPORT)) {
      const clause = match[2] ?? ''
      const specifier = match[3] as string
      if (isTypeOnly(clause)) continue
      const target = resolve(dirname(resolve(projectRoot, file)), `${specifier}.ts`).replace(/\.ts\.ts$/, '.ts')
      const relative = target.replace(projectRoot + '/', '').replace(projectRoot + '\\', '').replace(/\\/g, '/')
      if (!relative.startsWith('src/') || !relative.endsWith('.ts')) continue
      if (!found.has(relative)) {
        found.add(relative)
        queue.push(relative)
      }
    }
  }
  return found
}

const graphs = new Map(PRELOAD_ENTRIES.map((entry) => [entry, valueReachable(entry)]))

describe('preload bundle graph', () => {
  it('resolves the real modules behind each preload entry', () => {
    // A resolver that silently returns empty sets would pass every assertion below.
    expect(graphs.get(INDEX_ENTRY)).toContain('src/preload/agent-browser-bridge.ts')
    expect(graphs.get(PANE_ENTRY)).toContain('src/preload/agent-browser-pane-bridge.ts')
    expect(graphs.get(PANE_ENTRY)).toContain('src/shared/agent-browser.ts')
  })

  it('keeps the two entries from sharing any runtime module', () => {
    const indexGraph = graphs.get(INDEX_ENTRY) as Set<string>
    const paneGraph = graphs.get(PANE_ENTRY) as Set<string>
    const shared = [...indexGraph].filter((module) => paneGraph.has(module))

    expect(shared, `${INDEX_ENTRY} and ${PANE_ENTRY} both require ${shared.join(', ')}`).toEqual([])
  })

  it('leaves type-only sharing across entries allowed', () => {
    const source = readFileSync(resolve(projectRoot, 'src/preload/agent-browser-bridge.ts'), 'utf8')

    expect(source).toMatch(/import\s+\{\s*type AgentBrowserStatus\s*\}\s+from '\.\.\/shared\/agent-browser'/)
    expect(graphs.get(INDEX_ENTRY)).not.toContain('src/shared/agent-browser.ts')
  })
})