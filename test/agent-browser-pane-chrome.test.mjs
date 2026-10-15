// @vitest-environment jsdom
/**
 * The pane chrome is the tab strip and address bar of a native browser view, so its
 * two dangerous behaviours are: painting untrusted strings (page titles and URLs come
 * from whatever site the model opens) and reporting a gesture as if it worked.
 *
 * `build/AGENTS.md` says a page test does not replace visual acceptance; it does prove
 * the strings land as text, the zh/en and light/dark switch works, and every control
 * maps to exactly one declared action.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

// The page is a build input, not a module: read it the way the browser does.
const html = readFileSync(join(process.cwd(), 'build', 'agent-browser-pane.html'), 'utf8')

const tab = (over = {}) => ({
  id: 'tab-1',
  title: 'Example',
  url: 'https://example.com/',
  active: true,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over
})

const paneState = (over = {}) => ({
  visible: true,
  tabs: [tab()],
  paneWidth: 800,
  chromeHeight: 72,
  lang: 'en',
  theme: 'light',
  notice: '',
  ...over
})

const settle = async () => {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let dom = null

/** Events must come from the page's own realm, so every test keeps its `page`. */
function mount(state = paneState(), options = {}) {
  const gestures = []
  const pushes = []
  const respond = options.respond ?? (() => state)
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/agent-browser-pane.html',
    beforeParse(window) {
      if (options.noBridge) return
      window.dshAgentBrowserPane = {
        getState: async () => state,
        applyAction: async (action) => {
          gestures.push(action)
          return respond(action, state)
        },
        onState: (listener) => {
          pushes.push(listener)
          return () => {}
        }
      }
    }
  })
  const page = dom.window
  return {
    page,
    document: page.document,
    gestures,
    push: (value) => {
      for (const listener of pushes) listener(value)
    }
  }
}

afterEach(() => {
  if (dom) dom.window.close()
  dom = null
})

const click = (page, node) => node.dispatchEvent(new page.Event('click', { bubbles: true }))
const type = (page, node, value) => {
  node.value = value
  node.dispatchEvent(new page.Event('input', { bubbles: true }))
}
const pressKey = (page, node, key) =>
  node.dispatchEvent(new page.KeyboardEvent('keydown', { key, bubbles: true }))
const pointer = (page, node, type_, clientX) => {
  const event = new page.MouseEvent(type_, { bubbles: true, clientX })
  node.dispatchEvent(Object.assign(event, { pointerId: 1 }))
  return event
}
const nextFrames = async (page, count = 3) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => page.requestAnimationFrame(() => resolve()))
  }
}

describe('agent browser pane chrome', () => {
  it('renders one tab button per target with the active one selected', async () => {
    const { document } = mount(
      paneState({
        tabs: [tab(), tab({ id: 'tab-2', title: 'Docs', url: 'https://example.com/docs', active: false })]
      })
    )
    await settle()

    const tabs = [...document.querySelectorAll('#tabs .tab')]
    expect(tabs.map((node) => node.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(tabs.map((node) => node.querySelector('.label').textContent)).toEqual(['Example', 'Docs'])
    expect(document.getElementById('address').value).toBe('https://example.com/')
  })

  it('paints page titles and rejection text as text, never as markup', async () => {
    const injected = '<img src=x onerror=alert(1)>'
    const notice = '<b>not html</b>'
    const { document, push } = mount(paneState())
    await settle()

    // One push: a second state would replace the tabs, and the point is that the
    // untrusted title and the untrusted notice never become markup.
    push(paneState({ tabs: [tab({ title: injected })], notice }))

    expect(document.querySelector('#tabs .tab .label').textContent).toBe(injected)
    expect(document.querySelectorAll('#tabs img').length).toBe(0)
    expect(document.querySelector('#tabs .tab b')).toBeNull()
    expect(document.getElementById('notice').textContent).toBe(notice)
    expect(document.getElementById('notice').querySelector('b')).toBeNull()
  })

  it('maps each control to exactly one declared gesture', async () => {
    const { page, document, gestures } = mount(
      paneState({ tabs: [tab(), tab({ id: 'tab-2', title: 'Second', active: false })] })
    )
    await settle()

    const second = document.getElementById('tab-tab-2')
    click(page, second)
    click(page, second.querySelector('.close'))
    click(page, document.getElementById('new-tab'))
    click(page, document.getElementById('back'))
    click(page, document.getElementById('forward'))
    click(page, document.getElementById('reload'))
    click(page, document.getElementById('hide'))
    await settle()

    expect(gestures).toEqual([
      { type: 'activate-tab', tabId: 'tab-2' },
      { type: 'close-tab', tabId: 'tab-2' },
      { type: 'new-tab', url: '' },
      { type: 'go-back' },
      { type: 'go-forward' },
      { type: 'reload' },
      { type: 'hide' }
    ])
  })

  it('disables back and forward until the active tab has history', async () => {
    const { document } = mount(paneState({ tabs: [tab({ canGoBack: true, canGoForward: false })] }))
    await settle()

    expect(document.getElementById('back').disabled).toBe(false)
    expect(document.getElementById('forward').disabled).toBe(true)
  })

  it('submits typed text as a navigate gesture on Enter and on Go', async () => {
    const { page, document, gestures } = mount(paneState())
    await settle()

    const address = document.getElementById('address')
    type(page, address, 'example.com/pricing')
    pressKey(page, address, 'Enter')
    click(page, document.getElementById('go'))
    await settle()

    expect(gestures).toEqual([
      { type: 'navigate', url: 'example.com/pricing' },
      { type: 'navigate', url: 'example.com/pricing' }
    ])
  })

  it('shows the rejection that came back with the response instead of a silent no-op', async () => {
    const rejected = paneState({ notice: 'Only http and https addresses can be opened here.' })
    const { page, document } = mount(paneState(), {
      respond: (action, state) => (action.type === 'navigate' ? rejected : state)
    })
    await settle()

    const address = document.getElementById('address')
    type(page, address, 'file:///C:/Windows/win.ini')
    pressKey(page, address, 'Enter')
    await settle()

    const notice = document.getElementById('notice')
    expect(notice.textContent).toContain('Only http and https')
    expect(notice.dataset.kind).toBe('error')
    expect(notice.hidden).toBe(false)
    expect(address.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('live').textContent).toContain('Only http and https')
  })

  it('keeps an unread rejection visible until the user edits the address', async () => {
    const rejected = paneState({ notice: 'That address is not valid.' })
    const { page, document, push } = mount(paneState(), {
      respond: (action) => (action.type === 'navigate' ? rejected : paneState())
    })
    await settle()

    const address = document.getElementById('address')
    type(page, address, 'not a url')
    pressKey(page, address, 'Enter')
    await settle()
    expect(document.getElementById('notice').textContent).toContain('not valid')

    // Another tab finishing loading is not an answer to the user's rejection.
    push(paneState({ tabs: [tab({ loading: true })] }))
    expect(document.getElementById('notice').textContent).toContain('not valid')

    type(page, address, 'example.com')
    expect(document.getElementById('notice').textContent).toBe('')
  })

  it('keeps typing while the page in another tab navigates', async () => {
    const { page, document, push } = mount(paneState())
    await settle()

    const address = document.getElementById('address')
    address.dispatchEvent(new page.Event('focus', { bubbles: true }))
    type(page, address, 'partial.typing')

    push(paneState({ tabs: [tab({ url: 'https://example.com/other' })] }))

    expect(address.value).toBe('partial.typing')
  })

  it('exposes the pane width on the resize handle', async () => {
    const { document } = mount(paneState({ paneWidth: 640 }))
    await settle()

    const grab = document.getElementById('grab')
    expect(grab.getAttribute('aria-label')).toBe('Resize browser pane')
    expect(grab.getAttribute('aria-valuetext')).toBe('640')
  })

  it('shows a grip without hovering, and keeps it out of the name', async () => {
    const { document } = mount(paneState())
    await settle()

    const grab = document.getElementById('grab')
    const grip = grab.querySelector('.grip')
    expect(grip).not.toBeNull()
    // The pill is decoration: the separator already carries its own label, so a
    // reader must not announce the handle twice.
    expect(grip.getAttribute('aria-hidden')).toBe('true')
    expect(grab.textContent.trim()).toBe('')

    // A splitter the user only finds by hovering is a splitter the user does not
    // have: the resting rule must paint it, and hover may only recolour it.
    const rest = (html.match(/\n {6}\.grip \{([^}]*)\}/) ?? [])[1] ?? ''
    expect(rest).toContain('background-color: var(--surface-raised)')
    expect(rest).toContain('border: 1px solid var(--line)')
    expect(rest).not.toMatch(/opacity: 0|display: none|visibility: hidden/)
    const hovered = (html.match(/\.grab:hover \.grip[^{]*\{([^}]*)\}/) ?? [])[1] ?? ''
    expect(hovered).toContain('var(--accent)')
    expect(hovered).not.toMatch(/opacity|display: |visibility/)

    // The hit area is wider than the pill so the drag target is still grabbable.
    const handle = (html.match(/\n {6}\.grab \{([^}]*)\}/) ?? [])[1] ?? ''
    expect(handle).toMatch(/width: (1[0-9]|[2-9][0-9])px/)
  })

  it('turns a drag of the edge into width gestures, one per frame', async () => {
    const { page, document, gestures } = mount(paneState({ paneWidth: 800 }))
    await settle()

    const grab = document.getElementById('grab')
    pointer(page, grab, 'pointerdown', 500)
    pointer(page, grab, 'pointermove', 470)
    pointer(page, grab, 'pointermove', 460)
    await nextFrames(page)
    pointer(page, grab, 'pointerup', 460)
    await settle()

    const widths = gestures.filter((gesture) => gesture.type === 'set-pane-width')
    expect(widths.length).toBe(1)
    expect(widths[0].width).toBe(760)
  })

  it('moves the split from the keyboard too', async () => {
    const { page, document, gestures } = mount(paneState({ paneWidth: 800 }))
    await settle()

    pressKey(page, document.getElementById('grab'), 'ArrowLeft')
    await nextFrames(page)
    await settle()

    expect(gestures).toEqual([{ type: 'set-pane-width', width: 760 }])
  })

  it('switches language and theme from the pushed state', async () => {
    const { document, push } = mount(paneState())
    await settle()
    expect(document.getElementById('go').textContent).toBe('Go')

    push(paneState({ lang: 'zh', theme: 'dark' }))
    await settle()

    expect(document.documentElement.lang).toBe('zh')
    expect(document.body.dataset.theme).toBe('dark')
    expect(document.getElementById('go').textContent).toBe('打开')
    expect(document.getElementById('new-tab').getAttribute('aria-label')).toBe('新建标签页')
    expect(document.getElementById('hide').getAttribute('aria-label')).toBe('隐藏浏览器面板')
    expect(document.getElementById('tabs').getAttribute('aria-label')).toBe('浏览器标签')
  })

  it('labels every control in both languages and both themes', async () => {
    // A missing key in one dictionary surfaces as an empty or "undefined" label, which
    // is exactly the half-finished bilingual batch build/AGENTS.md forbids.
    for (const lang of ['en', 'zh']) {
      for (const theme of ['light', 'dark']) {
        const { page, document } = mount(paneState({ lang, theme }))
        await settle()

        expect(document.documentElement.lang).toBe(lang)
        expect(document.body.dataset.theme).toBe(theme)
        const labelled = ['#new-tab', '#back', '#forward', '#reload', '#hide', '#grab']
        for (const selector of labelled) {
          const label = document.querySelector(selector).getAttribute('aria-label')
          expect(label, `${selector} in ${lang}/${theme}`).toBeTruthy()
          expect(label).not.toBe('undefined')
        }
        const go = document.getElementById('go')
        expect(go.textContent).toBeTruthy()
        expect(go.textContent).not.toBe('undefined')
        expect(document.getElementById('address').placeholder).toBeTruthy()
        expect(document.getElementById('tabs').getAttribute('aria-label')).toBeTruthy()
        page.close()
        dom = null
      }
    }
  })

  it('says so when the preload bridge never arrived', async () => {
    const { document } = mount(paneState(), { noBridge: true })
    await settle()

    // jsdom reports en-US, and without the bridge there is no Harness locale to borrow.
    expect(document.getElementById('notice').textContent).toContain('control page could not start')
    expect(document.getElementById('address').disabled).toBe(true)
    expect(document.getElementById('new-tab').disabled).toBe(true)
  })

  it('shows the loading state as text, not only as colour', async () => {
    const { document, push } = mount(paneState())
    await settle()

    push(paneState({ tabs: [tab({ loading: true })] }))

    expect(document.querySelector('#tabs .tab').getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('#tabs .tab .visually-hidden').textContent).toBe('Loading')
    expect(document.body.getAttribute('aria-busy')).toBe('true')
    expect(document.getElementById('live').textContent).toBe('Loading')
  })

  it('surfaces a bridge failure instead of leaving the strip mute', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.dshAgentBrowserPane = {
          getState: async () => {
            throw new Error('main process gone')
          },
          applyAction: async () => {
            throw new Error('main process gone')
          },
          onState: () => () => {}
        }
      }
    })
    await settle()

    const notice = dom.window.document.getElementById('notice')
    expect(notice.textContent).toContain('main process gone')
    expect(notice.dataset.kind).toBe('error')
    spy.mockRestore()
  })
})