/**
 * The wire contract of the pane: an address bar that reaches a native browser view is
 * a navigation oracle unless the scheme rules are enforced on the way in, and every
 * gesture must be one of the declared ones. These are the decisions the main process
 * makes before it touches Electron.
 */
import { describe, expect, it } from 'vitest'
import {
  isAgentBrowserPaneAction,
  isAgentBrowserPaneState,
  paneNavigationNotice,
  resolvePaneNavigationUrl,
  type AgentBrowserTab
} from '../src/shared/agent-browser'

const tab: AgentBrowserTab = {
  id: 'a',
  title: 'A',
  url: 'https://example.com/',
  active: true,
  loading: false,
  canGoBack: true,
  canGoForward: false
}

const paneState = (over: Partial<Parameters<typeof isAgentBrowserPaneState>[0]> = {}) => ({
  visible: true,
  tabs: [tab],
  paneWidth: 800,
  chromeHeight: 72,
  lang: 'zh',
  theme: 'dark',
  notice: '',
  ...over
})

describe('resolvePaneNavigationUrl', () => {
  it('treats typed hostnames as web addresses', () => {
    expect(resolvePaneNavigationUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(resolvePaneNavigationUrl('  Example.com/Path?Q=1 ')).toEqual({
      ok: true,
      url: 'https://example.com/Path?Q=1'
    })
    expect(resolvePaneNavigationUrl('http://example.com/x?y=1#z')).toEqual({
      ok: true,
      url: 'http://example.com/x?y=1#z'
    })
  })

  it('keeps the blank page addressable', () => {
    expect(resolvePaneNavigationUrl('about:blank')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('reads a host and port as a host and port, not as a scheme', () => {
    expect(resolvePaneNavigationUrl('localhost:3000/api')).toEqual({
      ok: true,
      url: 'http://localhost:3000/api'
    })
    expect(resolvePaneNavigationUrl('127.0.0.1:8080')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/' })
    expect(resolvePaneNavigationUrl('example.com:8443/tls')).toEqual({
      ok: true,
      url: 'https://example.com:8443/tls'
    })
  })

  it('refuses schemes that would read the local machine or run host handlers', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,hi',
      'vscode://open',
      'powershell://x',
      'mailto:someone@example.com'
    ]) {
      expect(resolvePaneNavigationUrl(url), url).toEqual({ ok: false, reason: 'scheme' })
    }
    // A UNC path is not a web address in any reading of it.
    expect(resolvePaneNavigationUrl('\\\\server\\share')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses nonsense and credentials hidden in a link', () => {
    expect(resolvePaneNavigationUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(resolvePaneNavigationUrl('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(resolvePaneNavigationUrl(42)).toEqual({ ok: false, reason: 'empty' })
    expect(resolvePaneNavigationUrl('https://user:pass@example.com')).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(resolvePaneNavigationUrl('not a url at all')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('explains a rejection in the language the pane is showing', () => {
    expect(paneNavigationNotice('scheme', 'zh')).toMatch(/http/)
    expect(paneNavigationNotice('invalid', 'en')).not.toBe('')
  })
})

describe('isAgentBrowserPaneAction', () => {
  it('accepts the gestures the strip declares', () => {
    for (const action of [
      { type: 'activate-tab', tabId: 'a' },
      { type: 'close-tab', tabId: 'a' },
      { type: 'new-tab', url: '' },
      { type: 'navigate', url: 'example.com' },
      { type: 'reload' },
      { type: 'go-back' },
      { type: 'go-forward' },
      { type: 'set-pane-width', width: 600 },
      { type: 'hide' }
    ]) {
      expect(isAgentBrowserPaneAction(action), JSON.stringify(action)).toBe(true)
    }
  })

  it('rejects anything that could name a file, a channel or negative geometry', () => {
    for (const value of [
      null,
      'hide',
      {},
      { type: 'read-file', path: 'C:/secrets' },
      { type: 'invoke', channel: 'x', args: [] },
      { type: 'activate-tab' },
      { type: 'close-tab', tabId: '' },
      { type: 'navigate', url: 7 },
      { type: 'set-pane-width', width: -40 },
      { type: 'set-pane-width', width: Number.NaN },
      { type: 'set-pane-width', width: '800' }
    ]) {
      expect(isAgentBrowserPaneAction(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('isAgentBrowserPaneState', () => {
  it('accepts a full state built by main', () => {
    expect(isAgentBrowserPaneState(paneState())).toBe(true)
  })

  it('rejects partial or invented shapes', () => {
    expect(isAgentBrowserPaneState({ visible: true, tabs: [] })).toBe(false)
    expect(isAgentBrowserPaneState(paneState({ lang: 'de' as never }))).toBe(false)
    expect(isAgentBrowserPaneState(paneState({ tabs: [{ id: 'a' }] as never }))).toBe(false)
    expect(isAgentBrowserPaneState(paneState({ paneWidth: -1 }))).toBe(false)
    expect(isAgentBrowserPaneState(paneState({ notice: 7 as never }))).toBe(false)
  })
})