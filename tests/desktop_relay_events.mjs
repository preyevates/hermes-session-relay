/**
 * Event-driven tests for the desktop half (estate fork).
 *
 * The whole of desktop/plugin.js is loaded against a fake Desktop host: fake atoms, a fake
 * gateway, a manual clock and timers. Each test plays a sequence of message.complete events
 * and checks what the plugin did, rather than matching its source text.
 *
 * The body is the plugin's own shipped source, with only its three import lines removed and
 * `export default` turned into a return; nothing outside this repository is interpolated.
 *
 * Run: node tests/desktop_relay_events.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'desktop', 'plugin.js'), 'utf8')
const body = source.replace(/^import .*$/gm, '').replace('export default {', 'return {')

let now = 1_800_000_000_000
Date.now = () => now
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r))
}

function atom(v) {
  let x = v
  return { get: () => x, set: n => { x = n }, subscribe: () => () => {} }
}

function rig({ pct = 50 } = {}) {
  const log = { submits: [], notes: [], newChats: [], composed: [] }
  const timers = []
  const handlers = {}
  const store = new Map()
  const host = {
    state: {
      focusedSessionId: atom('rA'),
      focusedStoredSessionId: atom('sA'),
      focusedSessionProfile: atom('alpha'),
      busyBySession: atom({}),
      focusedUsage: atom({ context_percent: pct })
    },
    request: async (method, params) => {
      if (method === 'session.context_breakdown') return { context_percent: pct }
      if (method === 'session.title') return { title: 'Work-1' }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'prompt.submit') {
        log.submits.push(params.session_id)
        return {}
      }
      return {}
    },
    notify: n => log.notes.push(n.message),
    notifyError: (e, m) => log.notes.push(m),
    newChat: profile => log.newChats.push(profile),
    composer: { submit: (where, text) => { log.composed.push(text); return true } }
  }
  const ctx = {
    storage: {
      get: (k, d) => (store.has(k) ? store.get(k) : d),
      set: (k, v) => store.set(k, v),
      remove: k => store.delete(k)
    },
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
    onEvent: (name, fn) => (handlers[name] = handlers[name] || []).push(fn),
    register: () => {},
    registerSettingsPage: () => {},
    os: { notify: () => {} }
  }
  const noop = () => null
  const plugin = new Function(
    'atom', 'Button', 'cn', 'haptic', 'host', 'ListRow', 'SegmentedControl', 'Tip', 'ToggleRow',
    'useValue', 'jsx', 'jsxs', 'useEffect', body
  )(atom, noop, () => '', noop, host, noop, noop, noop, noop, a => a.get(), noop, noop, noop)
  plugin.register(ctx)

  const advance = async ms => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > until) break
      timers.shift()
      now = t.at
      t.fn()
      await flush()
    }
    now = until
    await flush()
  }
  const complete = async (sessionId, text, status = 'complete') => {
    for (const fn of handlers['message.complete'] || []) fn({ session_id: sessionId, payload: { status, text } })
    await flush()
  }
  const busy = (id, on) => host.state.busyBySession.set({ ...host.state.busyBySession.get(), [id]: on })
  const focus = (runtimeId, storedId, profile) => {
    host.state.focusedSessionId.set(runtimeId)
    host.state.focusedStoredSessionId.set(storedId)
    host.state.focusedSessionProfile.set(profile)
  }
  return { log, advance, complete, busy, focus }
}

/** An ordinary reply in chat A completes above the threshold: the relay asks for the hand-off. */
async function asked(r) {
  await r.complete('rA', 'An ordinary reply.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA'])
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('ok  ' + name)
}

await check('the new chat opens under the asking chat\'s profile, even after he switches', async () => {
  const r = rig()
  await asked(r)
  r.focus('rB', 'sB', 'beta')
  await r.complete('rA', 'Mode: build. Take up the work.')
  assert.deepEqual(r.log.newChats, ['alpha'])
})

await check('a wait whose turn stopped without a reply is released, and the relay works again', async () => {
  const r = rig()
  await asked(r)
  await r.advance(31 * 60000)
  assert.ok(r.log.notes.some(m => m.includes('no hand-off arrived')))
  r.focus('rB', 'sB', 'alpha')
  await r.complete('rB', 'An ordinary reply in another chat.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA', 'rB'])
})

await check('a hand-off turn still running past the timeout is left to finish, and still opens', async () => {
  const r = rig()
  await asked(r)
  r.busy('rA', true)
  await r.advance(31 * 60000)
  assert.ok(r.log.notes.some(m => m.includes('taking long')))
  assert.ok(!r.log.notes.some(m => m.includes('no hand-off arrived')))
  r.busy('rA', false)
  await r.complete('rA', 'Mode: build. Take up the work.')
  assert.deepEqual(r.log.newChats, ['alpha'])
})

await check('"not yet" opens nothing, warns nothing, and is not re-asked by its own completion', async () => {
  const r = rig()
  await asked(r)
  await r.complete('rA', 'Session Relay: not yet: needs his Onward')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA'])
  assert.deepEqual(r.log.newChats, [])
  assert.ok(!r.log.notes.some(m => /warn|cancel|no hand-off/i.test(m)))
})

await check('after "not yet", his next reply brings the request back', async () => {
  const r = rig()
  await asked(r)
  await r.complete('rA', 'Session Relay: not yet: needs his Onward')
  await r.advance(3000)
  await r.complete('rA', 'Onward done; the work is finished.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA', 'rA'])
})

await check('a quick answer from him, still running at the check, is not the turn that gets skipped', async () => {
  const r = rig()
  await asked(r)
  await r.complete('rA', 'Session Relay: not yet: needs his Onward')
  r.busy('rA', true) // his answer is already running when the not-yet's own check comes round
  await r.advance(3000)
  r.busy('rA', false)
  await r.complete('rA', 'His answer, done.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA', 'rA'])
})

await check('"no hand-off" pauses the automatic relay; a cancel does too', async () => {
  const r = rig()
  await asked(r)
  await r.complete('rA', 'Session Relay: no hand-off: the check failed')
  await r.complete('rA', 'Another ordinary reply.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA'])
  await r.advance(16 * 60000)
  await r.complete('rA', 'A reply after the pause.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA', 'rA'])
  await r.complete('rA', '', 'interrupted')
  await r.complete('rA', 'Straight after the cancel.')
  await r.advance(3000)
  assert.deepEqual(r.log.submits, ['rA', 'rA'])
})

await check('another chat\'s reply is never taken for the hand-off', async () => {
  const r = rig()
  await asked(r)
  await r.complete('rB', 'Mode: build. A note from elsewhere.')
  assert.deepEqual(r.log.newChats, [])
  await r.complete('rA', 'Mode: build. Take up the work.')
  assert.deepEqual(r.log.newChats, ['alpha'])
})

console.log(`\n${passed} checks, 0 failures`)
