/**
 * Pane geometry is the reason the embedded browser covered the chat: a native child
 * view hides whatever window area it is given, so docking only works when the window
 * itself makes room. These are the arithmetic decisions a user can see — how wide the
 * band is, which side the window grew, and when the growth is undone.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_APP_CONTENT_WIDTH,
  MIN_PANE_WIDTH,
  PANE_CHROME_HEIGHT,
  paneGeometry,
  planPaneOpen,
  planPaneRestore,
  preferredPaneWidth,
  resolvePaneWidth,
  type Rect
} from '../src/main/agent-browser/pane-layout'

const bounds = (x: number, width: number, height = 900): Rect => ({ x, y: 60, width, height })
const fullHd = { x: 0, y: 0, width: 1920, height: 1080 }

describe('preferredPaneWidth', () => {
  it('takes half the window but never less than a readable page', () => {
    expect(preferredPaneWidth(1600)).toBe(800)
    expect(preferredPaneWidth(600)).toBe(MIN_PANE_WIDTH)
  })
})

describe('resolvePaneWidth', () => {
  it('keeps the app area a usable width', () => {
    expect(resolvePaneWidth(1600, 1400)).toBe(1600 - MIN_APP_CONTENT_WIDTH)
    expect(resolvePaneWidth(1600, 100)).toBe(MIN_PANE_WIDTH)
  })

  it('reports no fit instead of crushing the page', () => {
    expect(resolvePaneWidth(MIN_PANE_WIDTH + MIN_APP_CONTENT_WIDTH - 1, MIN_PANE_WIDTH)).toBeUndefined()
  })
})

describe('planPaneOpen', () => {
  it('widens the window so the pane covers area the app never had', () => {
    const content = bounds(100, 1400)
    const wide = { x: 0, y: 0, width: 3840, height: 2160 }
    const plan = planPaneOpen({ contentBounds: content, workArea: wide, canGrow: true })

    expect(plan.canDock).toBe(true)
    expect(plan.paneWidth).toBe(700)
    expect(plan.growth).toEqual({ side: 'right', width: 700 })
    expect(plan.contentBounds).toEqual({ ...content, width: 2100 })
    // What the user sees is unchanged: the app still has its original width.
    expect((plan.contentBounds?.width ?? 0) - plan.paneWidth).toBe(content.width)
  })

  it('grows to the left when the right edge is against the screen', () => {
    const content = bounds(1220, 700)
    const plan = planPaneOpen({ contentBounds: content, workArea: fullHd, canGrow: true })

    expect(plan.growth).toEqual({ side: 'left', width: MIN_PANE_WIDTH })
    expect(plan.contentBounds).toEqual({ x: 1220 - MIN_PANE_WIDTH, y: 60, width: 700 + MIN_PANE_WIDTH, height: 900 })
    expect(plan.contentBounds?.x ?? -1).toBeGreaterThanOrEqual(fullHd.x)
  })

  it('grows only as far as the pane needs, not as far as the screen allows', () => {
    const plan = planPaneOpen({ contentBounds: bounds(0, 1000), workArea: fullHd, canGrow: true })
    expect(plan.paneWidth).toBe(500)
    expect(plan.contentBounds?.width).toBe(1500)
  })

  it('splits the existing width for a maximized window', () => {
    const content = bounds(0, 1920)
    const plan = planPaneOpen({ contentBounds: content, workArea: fullHd, canGrow: false })

    expect(plan.contentBounds).toBeNull()
    expect(plan.growth).toBeNull()
    // Half of 1920 fits inside the cap, so the app keeps 960 DIPs visible.
    expect(plan.paneWidth).toBe(960)
    expect(1920 - plan.paneWidth).toBeGreaterThanOrEqual(MIN_APP_CONTENT_WIDTH)
  })

  it('refuses to dock when neither growing nor splitting can leave a readable pair', () => {
    const plan = planPaneOpen({
      contentBounds: bounds(0, 400),
      workArea: { x: 0, y: 0, width: 400, height: 1080 },
      canGrow: true
    })

    expect(plan.contentBounds).toBeNull()
    expect(plan.canDock).toBe(false)
    expect(plan.paneWidth).toBe(0)
  })
})

describe('planPaneRestore', () => {
  it('puts the window back at the width it had before opening', () => {
    const preOpen = bounds(100, 1400)
    const growth = { side: 'right' as const, width: 700 }
    const current = { ...preOpen, width: 2100 }

    expect(planPaneRestore(current, preOpen, growth)).toEqual(preOpen)
  })

  it('leaves the window alone when the user resized it meanwhile', () => {
    const preOpen = bounds(100, 1400)
    const growth = { side: 'right' as const, width: 700 }

    expect(planPaneRestore({ ...preOpen, width: 1800 }, preOpen, growth)).toBeNull()
    expect(planPaneRestore({ ...preOpen, x: 40, width: 2100 }, preOpen, growth)).toBeNull()
  })

  it('restores the left edge it shifted when growing leftwards', () => {
    const preOpen = bounds(1220, 700)
    const growth = { side: 'left' as const, width: 420 }
    const current = { ...preOpen, x: 800, width: 1120 }

    expect(planPaneRestore(current, preOpen, growth)).toEqual(preOpen)
    // A moved window must not be teleported back.
    expect(planPaneRestore({ ...current, x: 700 }, preOpen, growth)).toBeNull()
  })

  it('does nothing when the pane never grew the window', () => {
    const preOpen = bounds(0, 1920)
    expect(planPaneRestore(preOpen, preOpen, { side: 'right', width: 0 })).toBeNull()
  })
})

describe('paneGeometry', () => {
  it('reserves the strip rows above the driven page', () => {
    const geometry = paneGeometry({ x: 0, y: 0, width: 1600, height: 900 }, 800)

    expect(geometry.chrome).toEqual({ x: 800, y: 0, width: 800, height: PANE_CHROME_HEIGHT })
    expect(geometry.page).toEqual({
      x: 800,
      y: PANE_CHROME_HEIGHT,
      width: 800,
      height: 900 - PANE_CHROME_HEIGHT
    })
  })

  it('keeps both bands the same width and inside the window', () => {
    const geometry = paneGeometry({ x: 0, y: 0, width: 500, height: 300 }, 900)
    expect(geometry.chrome.width).toBe(500)
    expect(geometry.page.width).toBe(500)
    expect(geometry.chrome.x).toBe(0)
    expect(geometry.chrome.height).toBe(Math.min(PANE_CHROME_HEIGHT, 300))
    expect(geometry.page.height).toBe(300 - PANE_CHROME_HEIGHT)
  })
})