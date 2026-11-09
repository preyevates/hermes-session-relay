// Astra's Desktop adversarial scenarios, adapted to positive regression assertions.
import assert from 'node:assert/strict'
import { rig, flush } from './attempt_host.mjs'
let passed = 0,
  failed = 0
const hidden = (r) => r.log.submits.filter((p) => p.display_kind === 'hidden')
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('PASS ' + name)
  } catch (e) {
    failed++
    console.log('FAIL ' + name + ': ' + e.message)
  }
}
await test('D1 not-yet waits for next human reply even with busy chip transition', async () => {
  const r = rig()
  await r.human()
  r.busy('rA', true)
  await r.reply('Session Relay <token> not yet: approval')
  r.busy('rA', false)
  await r.advance(3000)
  assert.equal(hidden(r).length, 1)
  assert.equal(r.log.notes.length, 0)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await test('D2 profile switched during title RPC never steals owner', async () => {
  const r = rig()
  let release
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
  await r.human()
  r.focus()
  release({ title: 'Work-1' })
  await flush()
  await r.reply('Session Relay <token> hand-off\nAlpha')
  assert.equal(r.log.opens[0].options.route.profile, 'alpha')
})
await test('D3 become busy during title RPC aborts admission', async () => {
  const r = rig()
  let release
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
  await r.human()
  r.busy('rA', true)
  release({ title: 'Work-1' })
  await flush()
  assert.equal(hidden(r).length, 0)
})
await test('D4 replacing new draft cannot receive note; exact successor only', async () => {
  const r = rig()
  await r.human()
  const orig = r.host.request
  r.host.request = (m, p) => {
    if (m === 'session.create') r.focus(null, null, 'beta')
    return orig(m, p)
  }
  await r.reply('Session Relay <token> hand-off\nAlpha private note')
  assert.equal(r.log.composed.length, 0)
  assert.equal(r.log.submits[1].session_id, r.log.creates[0].id)
  assert.equal(r.log.opens[0].options.route.profile, 'alpha')
})
await test('D5 title failure never falls back to focused runtime', async () => {
  const r = rig()
  await r.human()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && 'title' in p ? Promise.reject(Error('title failed')) : orig(m, p)
  r.focus()
  await r.reply('Session Relay <token> hand-off\nNote')
  assert.equal(r.log.opens[0].id, r.log.creates[0].stored)
  assert.equal(
    r.log.requests.filter((x) => x.method === 'session.title' && x.p.session_id === 'rB').length,
    0
  )
})
await test('D6 unconfirmed durable first message never marks', async () => {
  const r = rig()
  await r.human()
  const orig = r.host.request
  r.host.request = async (m, p) => {
    const result = await orig(m, p)
    if (m === 'session.activate' && p.session_id.startsWith('child'))
      return { ...result, messages: result.messages.map(({ row_id, ...m }) => m) }
    return result
  }
  await r.reply('Session Relay <token> hand-off\nNote')
  assert.equal(Object.keys(r.store.get('relayed') || {}).length, 0)
  assert.equal(r.log.opens.length, 0)
})
await test('D7 stale first timer cannot abandon second wait', async () => {
  const r = rig()
  await r.human()
  await r.advance(10 * 60000)
  await r.reply('Session Relay <token> no hand-off: failed')
  await r.advance(16 * 60000)
  await r.human()
  await r.advance(5 * 60000)
  assert.equal(
    r.log.notes.some((n) => n.message.includes('no hand-off arrived')),
    false
  )
  await r.reply('Session Relay <token> hand-off\nSecond note')
  assert.equal(r.log.creates.length, 1)
})
await test('D8 reset cancels delayed title continuation', async () => {
  const r = rig()
  let release
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
  await r.human()
  r.reset()
  release({ title: 'Work-1' })
  await flush()
  assert.equal(hidden(r).length, 0)
  assert.equal(Object.keys(r.store.get('attempts')).length, 0)
})
await test('D9 reload preserves pause for same owner and stored id', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> no hand-off: missing')
  r.dispose()
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  r2.render()
  await r2.human()
  assert.equal(hidden(r2).length, 0)
  await r2.advance(16 * 60000)
  await r2.human()
  assert.equal(hidden(r2).length, 1)
})
await test('D10 full connection owner retained despite source switch', async () => {
  const owner = { connectionId: 'remote-A', profile: 'alpha' }
  const r = rig({ owner })
  r.host.profileRoutes = async () => [
    { connectionId: 'remote-A', mode: 'remote', profile: 'alpha', targetProfile: 'backend-alpha' }
  ]
  await r.human()
  r.focus('rB', 'sB', 'alpha', 'remote-B')
  await r.reply('Session Relay <token> hand-off\nRemote note')
  assert.equal(r.log.opens[0].options.route.connectionId, 'remote-A')
  for (const req of r.log.requests.filter((x) => ['prompt.submit', 'session.create'].includes(x.method)))
    assert.equal(req.owner.connectionId, 'remote-A')
})
for (const text of [
  'Session Relay <token> not yeti; continuing summary',
  'Session Relay <token> no hand-offer; continuing summary',
  'Session Relay <token> not yesterday',
  'I cannot do this.\nSession Relay <token> no hand-off: check failed'
])
  await test('D11 exact delimiter rejects ' + text, async () => {
    const r = rig()
    await r.human()
    await r.reply(text)
    assert.equal(r.log.creates.length + r.log.newChats.length, 0)
    assert.ok(Object.values(r.store.get('pauses') || {}).length)
  })
await test('D12 title increment preserved at limit', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? Promise.resolve({ title: 'x'.repeat(40) }) : orig(m, p)
  await r.human()
  await r.reply('Session Relay <token> hand-off\nNote')
  assert.equal(r.log.titles[0][1], 'x'.repeat(38) + '-2')
})
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
