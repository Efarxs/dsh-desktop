/**
 * Pane geometry, with no Electron in sight.
 *
 * The embedded browser is a native child view, so it always covers whatever window
 * area it is given: a web page cannot reserve space for a view that is drawn on top
 * of it. Docking therefore has two halves — move/resize the *window* so the area
 * being covered is area the app was not using, and cut the child-view rectangles out
 * of the content area below the tab strip. Both decisions are arithmetic, which is
 * why they live here instead of inside the view lifecycle code.
 */

/** A window or view rectangle in DIPs. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Row 1 of the pane chrome: tab buttons. */
export const TAB_STRIP_HEIGHT = 34
/** Row 2 of the pane chrome: back/forward/reload, address field, close. */
export const PANE_TOOLBAR_HEIGHT = 38
/** Total chrome height the page view must start below. */
export const PANE_CHROME_HEIGHT = TAB_STRIP_HEIGHT + PANE_TOOLBAR_HEIGHT

/** Half the window by default: wide enough to read a real page. */
const PANE_RATIO = 0.5
/** Below this the page is unusable, so growing stops and a narrower pane is chosen. */
export const MIN_PANE_WIDTH = 420
/** The Harness page keeps at least this much visible width. */
export const MIN_APP_CONTENT_WIDTH = 640

/** Which side of the window absorbed the extra width when the pane opened. */
export interface PaneGrowth {
  side: 'left' | 'right'
  width: number
}

export interface PaneOpenInput {
  /** Current window content bounds, in screen coordinates. */
  contentBounds: Rect
  /** Display work area for the window being docked into. */
  workArea: Rect
  /** False for maximized or fullscreen windows: they cannot be widened. */
  canGrow: boolean
}

export interface PaneOpenPlan {
  /** False when even the minimum pane would crush the app area: do not dock. */
  canDock: boolean
  /** Pane width to dock at; 0 when `canDock` is false. */
  paneWidth: number
  /** Content bounds to apply before docking, or null to leave the window alone. */
  contentBounds: Rect | null
  growth: PaneGrowth | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Preferred pane width for an app area, floored at what a real page needs. */
export function preferredPaneWidth(contentWidth: number): number {
  return Math.max(MIN_PANE_WIDTH, Math.round(contentWidth * PANE_RATIO))
}

/**
 * Fit a requested pane width into a content area, or report that it cannot fit.
 *
 * The cap is what keeps a splitter drag or a tiny window from leaving the app with a
 * sliver: the visible app area never drops under `MIN_APP_CONTENT_WIDTH`.
 */
export function resolvePaneWidth(contentWidth: number, requestedWidth: number): number | undefined {
  const max = contentWidth - MIN_APP_CONTENT_WIDTH
  if (max < MIN_PANE_WIDTH) return undefined
  return clamp(Math.round(requestedWidth), MIN_PANE_WIDTH, max)
}

/**
 * Plan the window change that makes room for the pane.
 *
 * Growing the window is the whole point: covering the right half of the chat is what
 * users reported as "挡住了主窗口". Prefer the side with more room inside the display
 * work area, and only grow by as much as the pane actually needs, so a maximized or
 * edge-anchored window falls back to splitting the width it already has.
 */
export function planPaneOpen(input: PaneOpenInput): PaneOpenPlan {
  const { contentBounds, workArea, canGrow } = input
  const desired = preferredPaneWidth(contentBounds.width)
  const roomRight = Math.max(0, workArea.x + workArea.width - (contentBounds.x + contentBounds.width))
  const roomLeft = Math.max(0, contentBounds.x - workArea.x)
  const side: PaneGrowth['side'] = roomRight >= roomLeft ? 'right' : 'left'
  const room = side === 'right' ? roomRight : roomLeft

  if (!canGrow || room < MIN_PANE_WIDTH) {
    const width = resolvePaneWidth(contentBounds.width, desired)
    if (width === undefined) return { canDock: false, paneWidth: 0, contentBounds: null, growth: null }
    return { canDock: true, paneWidth: width, contentBounds: null, growth: null }
  }

  const grownBy = Math.min(desired, room)
  const grown: Rect = side === 'right'
    ? { ...contentBounds, width: contentBounds.width + grownBy }
    : { ...contentBounds, x: contentBounds.x - grownBy, width: contentBounds.width + grownBy }
  const width = resolvePaneWidth(grown.width, grownBy)
  if (width === undefined) return { canDock: false, paneWidth: 0, contentBounds: null, growth: null }
  return { canDock: true, paneWidth: width, contentBounds: grown, growth: { side, width: grownBy } }
}

/**
 * Undo the growth from `planPaneOpen`.
 *
 * Only when the window is exactly as the pane left it: if the user resized or moved
 * it while the pane was open, restoring the remembered bounds would fight them.
 */
export function planPaneRestore(
  contentBounds: Rect,
  preOpen: Rect,
  growth: PaneGrowth
): Rect | null {
  if (growth.width <= 0) return null
  if (contentBounds.height !== preOpen.height) return null
  if (contentBounds.width !== preOpen.width + growth.width) return null
  if (growth.side === 'left' && contentBounds.x !== preOpen.x - growth.width) return null
  if (growth.side === 'right' && contentBounds.x !== preOpen.x) return null
  return { ...contentBounds, x: preOpen.x, width: preOpen.width }
}

export interface PaneGeometry {
  /** Chrome strip (tabs + toolbar) rectangle inside the content area. */
  chrome: Rect
  /** Page view rectangle: below the strip, in the right-hand band. */
  page: Rect
}

/**
 * Cut the pane area out of the content area.
 *
 * The strip has to be its own view rather than part of the Harness page: anything
 * the page paints in the pane band is covered by the native page view, so the strip
 * occupies the band's top and the driven page starts below it.
 */
export function paneGeometry(contentBounds: Rect, paneWidth: number): PaneGeometry {
  const width = Math.max(0, Math.min(Math.round(paneWidth), contentBounds.width))
  const x = contentBounds.width - width
  return {
    chrome: { x, y: 0, width, height: Math.min(PANE_CHROME_HEIGHT, contentBounds.height) },
    page: { x, y: PANE_CHROME_HEIGHT, width, height: Math.max(0, contentBounds.height - PANE_CHROME_HEIGHT) }
  }
}