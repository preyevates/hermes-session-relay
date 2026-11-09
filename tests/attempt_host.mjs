// Whole-plugin event fixture, adapted from the Fable/Astra adversarial rigs.
// Effects remain live and dependency-sensitive; no installed host is accessed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
export const source = readFileSync(
  resolve(process.env.RELAY_ROOT || new URL('..', import.meta.url).pathname, 'desktop/plugin.js'),
  'utf8'
)
export let now = 1800000000000
Date.now = () => now
export const flush = async () => {
  for (let i = 0; i < 24; i++) await new Promise((r) => setImmediate(r))
}
const atom = (v) => ({
  get: () => v,
  set: (n) => {
    v = n
  }
})
export function rig({
  pct = 50,
  store = new Map(),
  backend = null,
  owner = { connectionId: 'local', mode: 'local', profile: 'alpha', targetProfile: 'alpha' }
} = {}) {
  const log = {
    requests: [],
    submits: [],
    creates: [],
    opens: [],
    titles: [],
    notes: [],
    composed: [],
    newChats: []
  }
  const sessions =
    backend ||
    new Map([
      ['rA', { stored: 'sA', messages: [], running: false }],
      ['rB', { stored: 'sB', messages: [], running: false }]
    ])
  let row = Math.max(1000, ...[...sessions.values()].flatMap((s) => s.messages.map((m) => m.row_id || 0))),
    seq = Math.max(0, ...[...sessions.keys()].map((id) => Number(id.match(/^child(\d+)$/)?.[1]) || 0)),
    contribution,
    settings,
    slot = 0,
    effects = [],
    timers = [],
    handlers = {},
    tree
  const host = {
    state: {
      focusedSessionId: atom('rA'),
      focusedStoredSessionId: atom('sA'),
      focusedSessionProfile: atom('alpha'),
      focusedSessionOwner: atom(owner),
      profile: atom('alpha'),
      focusedUsage: atom({ context_percent: pct }),
      busyBySession: atom({})
    },
    skills: { list: async () => [{ name: 'hermes-optimize-handoff', enabled: true }] },
    profileRoutes: async () =>
      ['alpha', 'beta'].map((profile) => ({
        connectionId: 'local',
        mode: 'local',
        profile,
        targetProfile: profile
      })),
    retainProfileSocket: () => () => {},
    retainProfile: async () => () => {},
    request: async (method, p = {}) => {
      log.requests.push({ method, p, owner: null })
      if (method === 'session.context_breakdown') return { context_percent: pct }
      if (method === 'session.title') {
        if ('title' in p) log.titles.push([p.session_id, p.title])
        return { title: 'Work-1' }
      }
      if (method === 'session.active_list')
        return {
          sessions: [...sessions].map(([id, s]) => ({
            id,
            session_key: s.stored,
            status: s.running ? 'running' : 'idle'
          }))
        }
      if (method === 'session.create') {
        const id = 'child' + ++seq,
          stored = 'stored' + seq
        sessions.set(id, { stored, messages: [], running: false })
        log.creates.push({ id, stored, p })
        return { session_id: id, stored_session_id: stored }
      }
      if (method === 'session.resume') {
        const hit = [...sessions].find(([, s]) => s.stored === p.session_id)
        if (!hit) throw Error('missing')
        return {
          session_id: hit[0],
          stored_session_id: hit[1].stored,
          messages: hit[1].messages,
          running: hit[1].running
        }
      }
      if (method === 'session.activate') {
        const s = sessions.get(p.session_id)
        if (!s) throw Error('missing')
        return {
          session_id: p.session_id,
          session_key: s.stored,
          messages: s.messages.filter((m) => m.display_kind !== 'hidden'),
          running: s.running
        }
      }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'prompt.submit') {
        const s = sessions.get(p.session_id)
        if (!s) throw Error('missing')
        const user_row_id = ++row
        s.messages.push({
          role: 'user',
          text: p.text,
          row_id: user_row_id,
          ...(p.display_kind ? { display_kind: p.display_kind } : {})
        })
        s.running = true
        log.submits.push(p)
        return { status: 'streaming', user_row_id }
      }
      return {}
    },
    notify: (n) => log.notes.push(n),
    notifyError: (e, m) => log.notes.push({ message: m }),
    newChat: (p) => log.newChats.push(p),
    composer: {
      submit: (where, text) => {
        log.composed.push({ where, text })
        return true
      }
    },
    openSession: async (id, options) => {
      log.opens.push({ id, options })
    }
  }
  host.requestProfile = async (owner, method, p) => {
    const index = log.requests.length
    const pending = host.request(method, p)
    const record = log.requests[index]
    if (record?.method === method && record.p === p) record.owner = structuredClone(owner)
    return pending
  }
  let disposers = []
  const ctx = {
    onDispose: (fn) => disposers.push(fn),
    storage: {
      get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d),
      set: (k, v) => store.set(k, structuredClone(v)),
      remove: (k) => store.delete(k)
    },
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
    onEvent: (n, fn) => (handlers[n] ??= []).push(fn),
    register: (c) => {
      if (c.id === 'chip') contribution = c
    },
    registerSettingsPage: (s) => {
      settings = s
    },
    os: { notify: () => {}, writeClipboard: async () => true }
  }
  const jsx = (type, props) => ({ type, props }),
    noop = () => null
  const useEffect = (fn, deps) => {
    const i = slot++
    if (!effects[i] || deps.some((x, j) => !Object.is(x, effects[i][j]))) {
      effects[i] = deps
      fn()
    }
  }
  const body = source
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?\n/gm, '')
    .replace('export default {', 'return {')
  // Only the inspected repository plugin is executed; no network, page, user or model text is evaluated.
  const plugin = new Function(
    'atom',
    'Button',
    'cn',
    'haptic',
    'host',
    'ListRow',
    'SegmentedControl',
    'Tip',
    'ToggleRow',
    'useValue',
    'jsx',
    'jsxs',
    'useEffect',
    body
  )(
    atom,
    noop,
    () => '',
    noop,
    host,
    noop,
    noop,
    noop,
    noop,
    (a) => a.get(),
    jsx,
    jsx,
    useEffect
  )
  plugin.register(ctx)
  const render = () => {
    slot = 0
    const el = contribution.render()
    tree = el.type(el.props)
    return tree
  }
  const manual = async () => {
    render().props.children.props.onClick()
    await flush()
  }
  const reset = () => settings.render().props.children[3].props.action.props.onClick()
  const advance = async (ms) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > until) break
      timers.shift()
      now = t.at
      if (t.live) t.fn()
      await flush()
    }
    now = until
    await flush()
  }
  const event = async (n, e) => {
    for (const f of handlers[n] || []) f(e)
    await flush()
  }
  const complete = async (id, text, status = 'complete', userId = null) => {
    const s = sessions.get(id)
    if (userId === null) {
      const u = [...s.messages].reverse().find((m) => m.role === 'user')
      userId = u?.row_id
    }
    if (text) s.messages.push({ role: 'assistant', text, row_id: ++row })
    s.running = false
    await event('message.complete', {
      session_id: id,
      payload: {
        text,
        status,
        persisted_turn: { user_row_id: userId, final_assistant_row_id: row, complete: true }
      }
    })
    host.state.busyBySession.set({ ...host.state.busyBySession.get(), [id]: false })
    render()
    await advance(2600)
  }
  const human = async (id = 'rA', text = 'An ordinary reply.') => {
    const s = sessions.get(id)
    s.messages.push({ role: 'user', text: 'His question', row_id: ++row })
    await complete(id, text, 'complete', row)
  }
  const focus = (id = 'rB', stored = 'sB', profile = 'beta', connectionId = 'local') => {
    host.state.focusedSessionId.set(id)
    host.state.focusedStoredSessionId.set(stored)
    host.state.focusedSessionProfile.set(profile)
    host.state.focusedSessionOwner.set({ connectionId, mode: 'local', profile, targetProfile: profile })
    render()
  }
  const busy = (id, on) => {
    sessions.get(id).running = on
    host.state.busyBySession.set({ ...host.state.busyBySession.get(), [id]: on })
    render()
  }
  const token = () => {
    const p = [...log.submits].reverse().find((p) => p.display_kind === 'hidden')
    return p?.text.match(/Session Relay ([a-zA-Z0-9_-]+) hand-off/)?.[1]
  }
  const reply = async (text, status = 'complete', id = 'rA') =>
    complete(id, text.replaceAll('<token>', token()), status)
  return {
    host,
    ctx,
    log,
    store,
    sessions,
    settings: () => settings.render(),
    render,
    manual,
    reset,
    advance,
    event,
    complete,
    human,
    focus,
    busy,
    token,
    reply,
    dispose: () => {
      for (const f of disposers) f()
      disposers = []
      timers = []
      handlers = {}
    }
  }
}
