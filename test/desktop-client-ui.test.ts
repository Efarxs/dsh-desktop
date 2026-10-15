import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

interface ClientDefinition {
  factory: (require: (id: string) => unknown) => {
    apply: (ctx: unknown) => void
    inject: string[]
  }
}

interface Rendered {
  type: unknown
  props: Record<string, unknown>
}

const clientBundlePath = path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js')
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A hook runtime small enough to stay honest: state cells survive re-renders, and
 * effects run once (the occupants below pass empty dependency lists). Enough to
 * prove a component renders nothing, mirrors pushed state, and calls the desktop
 * bridge on click — without pulling React into a Node test.
 */
function createReactRuntime() {
  const cells: unknown[] = []
  const setters: Array<(next: unknown) => void> = []
  const cleanups: Array<(() => void) | undefined> = []
  let cursor = 0
  let dirty = false
  let effectsRun = false
  let pendingEffects: Array<() => (() => void) | undefined> = []

  const react = {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): Rendered => ({ type, props: { ...props, children } }),
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const index = cursor++
      if (cells.length <= index) cells.push(initial)
      const setter = (next: unknown): void => {
        cells[index] = next
        dirty = true
      }
      setters[index] = setter
      return [cells[index], setter]
    },
    useEffect: (setup: () => (() => void) | undefined): void => {
      pendingEffects.push(setup)
    }
  }

  return {
    react,
    render(component: () => unknown): Rendered | null {
      cursor = 0
      dirty = false
      const element = component() as Rendered | null
      if (!effectsRun) {
        effectsRun = true
        const setups = pendingEffects.splice(0)
        for (const [index, setup] of setups.entries()) cleanups[index] = setup()
      } else {
        pendingEffects.splice(0)
      }
      return element
    },
    renderAfterStateChange(component: () => unknown): Rendered | null {
      expect(dirty).toBe(true)
      return this.render(component)
    },
    unmount(): void {
      for (const cleanup of cleanups.splice(0)) cleanup?.()
    }
  }
}

/** Load the client bundle in a sandbox and collect the occupants it registers. */
async function mountClient(bundle: { language: string; desktop?: Record<string, unknown> }): Promise<{
  Button: ReturnType<typeof vi.fn>
  occupant: Registration
  runtime: ReturnType<typeof createReactRuntime>
}> {
  const runtime = createReactRuntime()
  const Button = vi.fn()
  let definition: ClientDefinition | undefined
  const source = await readFile(clientBundlePath, 'utf8')
  vm.runInNewContext(source, {
    document: {
      documentElement: { lang: bundle.language },
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: vi.fn() })),
      head: { appendChild: vi.fn() }
    },
    navigator: { language: bundle.language },
    window: {
      __ModuleLoader__: {
        load: (value: ClientDefinition) => {
          definition = value
        }
      },
      ...(bundle.desktop === undefined ? {} : { dshDesktop: bundle.desktop })
    }
  })

  const plugin = definition!.factory((id: string) => {
    if (id === 'react') return runtime.react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button }
    throw new Error(`Unexpected client dependency: ${id}`)
  })

  const registrations: Registration[] = []
  plugin.apply({
    effect: (setup: () => unknown) => {
      setup()
    },
    slots: {
      inject: (_name: string, callback: () => unknown): unknown => callback(),
      register: (config: Registration['config'], component: Registration['component']): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
  })

  const occupant = registrations.find(({ config }) => config.name === 'conversation.session.header.actions')
  if (!occupant) throw new Error('the agent browser session-header occupant was not registered')
  return { Button, occupant, runtime }
}

describe('DSH Desktop client slot occupants', () => {
  it('registers one occupant per brand seat and keeps the official name mark-free', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const removeStyle = vi.fn()
    let disposeStyle: (() => void) | undefined
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const BrandWordmark = vi.fn()
    const FishLogo = vi.fn()
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { BrandWordmark, FishLogo }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({ slots, effect: (setup: () => (() => void) | undefined) => { disposeStyle = setup() } })

    expect(plugin.inject).toEqual(['slots', 'remote.session', 'sessions', 'uiWorkspace'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'conversation.session.header.actions'
    ])
    // Desktop toolbar styles have an owned lifetime; branding stays in currentColor.
    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain("[data-dsh-preset-search]")
    disposeStyle?.()
    expect(removeStyle).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarName.type).toBe(BrandWordmark)
    expect(sidebarName.props.includeMark).toBe(false)

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.height).toBe(17)
    const [markPath] = sidebarMark.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!markPath) throw new Error('Expected the sidebar brand SVG path')
    expect(markPath.type).toBe('path')
    expect(markPath.props.fill).toBe('currentColor')

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe(FishLogo)
    expect(heroMark.props.size).toBe(48)
  })

  it('drives the native agent-browser pane from the session-header entry', async () => {
    const getStatus = vi.fn(async () => ({ available: true, visible: false }))
    const toggle = vi.fn(async () => ({ available: true, visible: true }))
    let unsubscribeCalls = 0
    const onStatus = vi.fn(() => () => {
      unsubscribeCalls += 1
    })
    const { Button, occupant, runtime } = await mountClient({
      language: 'en-US',
      desktop: { agentBrowser: { getStatus, toggle, onStatus } }
    })

    // Nothing is known before the first read, so the seat stays empty rather than
    // showing a button whose state would be a guess.
    expect(runtime.render(() => occupant.component({}) as Rendered | null)).toBeNull()
    await flush()

    const hidden = runtime.renderAfterStateChange(() => occupant.component({}) as Rendered | null)
    expect(getStatus).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenCalledOnce()
    expect(hidden?.type).toBe(Button)
    expect(hidden?.props.children).toEqual(['Show Browser'])
    expect(hidden?.props['aria-pressed']).toBe(false)
    expect(String(hidden?.props.title)).toContain('Ctrl+Shift+B')

    void (hidden?.props.onClick as () => void)()
    await flush()

    // The label changes with the state, so the toggle is not carried by colour alone.
    const shown = runtime.renderAfterStateChange(() => occupant.component({}) as Rendered | null)
    expect(toggle).toHaveBeenCalledOnce()
    expect(shown?.props.children).toEqual(['Hide Browser'])
    expect(shown?.props['aria-pressed']).toBe(true)
    expect(shown?.props.disabled).toBe(false)

    runtime.unmount()
    expect(unsubscribeCalls).toBe(1)
  })

  it('renders no control when this run has no pane to open', async () => {
    const { occupant, runtime } = await mountClient({
      language: 'zh-CN',
      desktop: {
        agentBrowser: {
          getStatus: vi.fn(async () => ({ available: false, visible: false })),
          toggle: vi.fn(async () => ({ available: false, visible: false })),
          onStatus: vi.fn(() => () => undefined)
        }
      }
    })

    expect(runtime.render(() => occupant.component({}) as Rendered | null)).toBeNull()
    await flush()
    expect(runtime.renderAfterStateChange(() => occupant.component({}) as Rendered | null)).toBeNull()
  })

  it('stays inert outside the desktop shell where the bridge does not exist', async () => {
    const { occupant, runtime } = await mountClient({ language: 'en-US' })

    expect(runtime.render(() => occupant.component({}) as Rendered | null)).toBeNull()
    await flush()
    expect(runtime.render(() => occupant.component({}) as Rendered | null)).toBeNull()
  })
})
