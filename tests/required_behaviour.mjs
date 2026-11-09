import assert from 'node:assert/strict'
import { rig, flush } from './attempt_host.mjs'
let passed = 0,
  failed = 0
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
const hidden = (r) => r.log.submits.filter((p) => p.display_kind === 'hidden')
await test('R2 failed/interrupted/missing-status events never start', async () => {
  const r = rig()
  for (const status of ['failed', 'interrupted', undefined])
    await r.event('message.complete', { session_id: 'rA', payload: { text: 'ordinary', status } })
  await r.advance(3000)
  assert.equal(hidden(r).length, 0)
})
await test('R2 automatic starts at precise threshold, not stale cheap gauge', async () => {
  const r = rig({ pct: 20 })
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.context_breakdown' ? Promise.resolve({ context_percent: 50 }) : orig(m, p)
  await r.human()
  assert.equal(hidden(r).length, 1)
})
await test('R2 manual works below threshold', async () => {
  const r = rig({ pct: 5 })
  await r.manual()
  assert.equal(hidden(r).length, 1)
})
await test('R4 wrong or missing chat id cannot supply note', async () => {
  const r = rig()
  await r.human()
  const text = `Session Relay ${r.token()} hand-off\nWrong turn`
  await r.event('message.complete', { session_id: 'rB', payload: { text, status: 'complete' } })
  await r.event('message.complete', { payload: { text, status: 'complete' } })
  assert.equal(r.log.creates.length, 0)
  await r.reply('Session Relay <token> hand-off\nRight turn')
  assert.equal(r.log.creates.length, 1)
})
await test('R4 mismatched human receipt cannot supply note', async () => {
  const r = rig()
  await r.human()
  await r.complete('rA', `Session Relay ${r.token()} hand-off\nHuman turn`, 'complete', 99)
  assert.equal(r.log.creates.length, 0)
  await r.reply('Session Relay <token> hand-off\nActual hidden reply')
  assert.equal(r.log.creates.length, 1)
})
await test('R4 no receipt fallback handles first non-human completion only', async () => {
  const r = rig()
  await r.human()
  await r.event('message.complete', {
    session_id: 'rA',
    payload: { text: `Session Relay ${r.token()} hand-off\nFallback`, status: 'complete' }
  })
  assert.equal(r.log.creates.length, 1)
})
await test('R4 fallback never consumes later human-originated completion', async () => {
  const r = rig()
  await r.human()
  r.sessions.get('rA').messages.push({ role: 'user', text: 'redirect', row_id: 9000 })
  await r.event('message.complete', {
    session_id: 'rA',
    payload: { text: `Session Relay ${r.token()} hand-off\nUnrelated`, status: 'complete' }
  })
  assert.equal(r.log.creates.length, 0)
})
for (const bad of [
  'Session Relay wrong hand-off\nWrong token',
  '**Session Relay <token> hand-off**\nBold',
  'Explanation\nSession Relay <token> hand-off\nPrompt',
  'Session Relay <token> hand-off',
  'Session Relay <token> not yet:',
  'Session Relay <token> no hand-off:'
])
  await test('R5 fail closed ' + bad, async () => {
    const r = rig()
    await r.human()
    await r.reply(bad)
    assert.equal(r.log.creates.length + r.log.newChats.length, 0)
  })
await test('R5 allows one whole-reply fence; seeds no first protocol line', async () => {
  const r = rig()
  await r.human()
  await r.reply('```text\nSession Relay <token> hand-off\nOnly the prompt\n```')
  assert.equal(r.log.submits[1].text, 'Only the prompt')
})
await test('R6 only next human turn re-arms deferral; no warning/pause', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> not yet: needs an answer')
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
  assert.equal(r.log.notes.length, 0)
  r.render()
  await r.advance(31000)
  assert.equal(hidden(r).length, 1)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await test('R7 failed hidden admission pauses only its chat', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'prompt.submit' && p.session_id === 'rA' ? Promise.reject(Error('no admission')) : orig(m, p)
  await r.human()
  await r.human()
  assert.equal(
    r.log.requests.filter((x) => x.method === 'prompt.submit' && x.p.session_id === 'rA').length,
    0
  )
  assert.equal(Object.keys(r.store.get('pauses')).length, 1)
  r.focus()
  await r.human('rB')
  assert.equal(hidden(r).length, 1)
})
await test('R8 duplicate completion creates exactly one successor', async () => {
  const r = rig()
  await r.human()
  const text = `Session Relay ${r.token()} hand-off\nOne note`
  await Promise.all([r.complete('rA', text), r.complete('rA', text)])
  assert.equal(r.log.creates.length, 1)
  assert.equal(r.log.opens.length, 1)
})
await test('R8 open failure retains mark and identifies existing successor', async () => {
  const r = rig()
  await r.human()
  r.host.openSession = async () => {
    throw Error('open fail')
  }
  await r.reply('Session Relay <token> hand-off\nNote')
  assert.equal(Object.keys(r.store.get('relayed')).length, 1)
  assert.ok(r.log.notes.some((n) => n.message.includes(r.log.creates[0].stored)))
})
await test('R10 at 30 minutes running warns then checks at 5 minute cadence', async () => {
  const r = rig()
  await r.human()
  await r.advance(30 * 60000)
  assert.equal(r.log.notes.filter((n) => n.message.includes('taking long')).length, 1)
  await r.advance(4 * 60000)
  assert.equal(r.log.notes.filter((n) => n.message.includes('taking long')).length, 1)
  await r.advance(60000)
  assert.equal(r.log.notes.filter((n) => n.message.includes('taking long')).length, 2)
  await r.reply('Session Relay <token> hand-off\nLate note')
  assert.equal(r.log.creates.length, 1)
})
await test('R10 stopped without text releases, does not time out newer attempt', async () => {
  const r = rig()
  await r.human()
  r.busy('rA', false)
  await r.advance(30 * 60000)
  assert.equal(Object.keys(r.store.get('attempts')).length, 0)
  assert.ok(r.log.notes.some((n) => n.message.includes('no hand-off arrived')))
  await r.human()
  await r.reply('Session Relay <token> hand-off\nLater note')
  assert.equal(r.log.creates.length, 1)
})
await test('R11 reset clears timers, attempts, marks and pauses', async () => {
  const r = rig()
  await r.human()
  r.reset()
  await r.advance(36 * 60000)
  assert.equal(Object.keys(r.store.get('attempts')).length, 0)
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
  assert.equal(r.log.notes.filter((n) => n.message.includes('taking long')).length, 0)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await test('R12 reload after confirmed seed never resends or creates again', async () => {
  const r = rig()
  await r.human()
  r.host.openSession = () => new Promise(() => {})
  await r.reply('Session Relay <token> hand-off\nPersistent note')
  r.dispose()
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  assert.equal(r2.log.creates.length, 0)
  assert.equal(r2.log.submits.length, 0)
  assert.equal(r2.log.opens.length, 1)
})
await test('R1 unresolved modern owner fails closed; legacy profile-only still supported', async () => {
  const r = rig({ owner: null })
  await r.human()
  assert.equal(hidden(r).length, 0)
  delete r.host.state.focusedSessionOwner
  await r.human()
  assert.equal(hidden(r).length, 1)
})
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
