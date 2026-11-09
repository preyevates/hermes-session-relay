// Fable's 21 adversarial checks adapted to the token/receipt contract and
// amended exact-session rule 8. Each prior BUG is required absent; sound paths
// are required present. Effects run on every relevant render (shared fixture).
import assert from 'node:assert/strict'
import { rig, flush } from './attempt_host.mjs'
let passed = 0,
  failed = 0
const hidden = (r) => r.log.submits.filter((p) => p.display_kind === 'hidden')
const marked = (r) => Object.values(r.store.get('relayed') || {}).some(Boolean)
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
async function asked(r) {
  await r.human()
  assert.equal(hidden(r).length, 1)
}
await test('F1 not-yet does not re-ask on chip/completion timer', async () => {
  const r = rig()
  await asked(r)
  await r.reply('Session Relay <token> not yet: need approval')
  r.render()
  await r.advance(3000)
  assert.equal(hidden(r).length, 1)
  assert.equal(r.log.creates.length, 0)
  assert.equal(r.log.notes.length, 0)
})
await test('F1 second not-yet with no human cannot re-ask', async () => {
  const r = rig()
  await asked(r)
  const token = r.token()
  await r.reply('Session Relay <token> not yet: need approval')
  await r.complete('rA', `Session Relay ${token} not yet: still waiting`)
  assert.equal(hidden(r).length, 1)
})
for (const [label, text] of [
  ['bold', '**Session Relay <token> not yet:** needs approval'],
  ['explain-then-line', 'I checked.\nSession Relay <token> not yet: need approval'],
  ['ordinary-answer', 'Sure. The options are A, B and C.']
])
  await test('F2 reject ' + label, async () => {
    const r = rig()
    await asked(r)
    await r.reply(text)
    assert.equal(r.log.creates.length + r.log.newChats.length, 0)
    assert.equal(marked(r), false)
  })
await test('F2 quoted control words inside valid note are data', async () => {
  const r = rig()
  await asked(r)
  await r.reply(
    'Session Relay <token> hand-off\nMode: build.\nEarlier Session Relay: no hand-off: no longer applies.'
  )
  assert.equal(r.log.creates.length, 1)
  assert.ok(r.log.submits[1].text.startsWith('Mode: build.'))
})
await test('F5 failed seed never marks, retains note, explains copy', async () => {
  const r = rig()
  await asked(r)
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'prompt.submit' && p.session_id !== 'rA' ? Promise.reject(Error('seed failed')) : orig(m, p)
  await r.reply('Session Relay <token> hand-off\nKeep this note')
  assert.equal(marked(r), false)
  assert.equal(r.log.opens.length, 0)
  assert.ok(Object.values(r.store.get('savedNotes')).some((n) => n.note === 'Keep this note'))
  assert.ok(r.log.notes.some((n) => n.message.includes('Copy saved note')))
})
await test('F4 two chats can wait concurrently', async () => {
  const r = rig({ pct: 60 })
  await asked(r)
  r.focus()
  await r.human('rB')
  assert.equal(hidden(r).length, 2)
  assert.equal(Object.keys(r.store.get('attempts')).length, 2)
})
await test('F6 reload live wait handles completion without re-asking', async () => {
  const r = rig()
  await asked(r)
  const token = r.token()
  r.dispose()
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  await r2.complete('rA', `Session Relay ${token} hand-off\nRecovered`)
  assert.equal(r2.log.creates.length, 1)
  assert.equal(hidden(r2).length, 0)
})
await test('F6 backend remint recovery matches stored id', async () => {
  const r = rig()
  await asked(r)
  const token = r.token()
  r.dispose()
  const s = r.sessions.get('rA')
  r.sessions.delete('rA')
  r.sessions.set('rA2', s)
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  await r2.complete('rA2', `Session Relay ${token} hand-off\nReminted`)
  assert.equal(r2.log.creates.length, 1)
  assert.equal(hidden(r2).length, 0)
})
await test('F10 long title reserves increment space', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? Promise.resolve({ title: 'x'.repeat(39) }) : orig(m, p)
  await asked(r)
  await r.reply('Session Relay <token> hand-off\nA note')
  assert.equal(r.log.titles[0][1], 'x'.repeat(38) + '-2')
})
await test('F11 unrelated recent row never renamed', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.list'
      ? Promise.resolve({ sessions: [{ id: 'his-new-chat', source: 'desktop', preview: 'Weekend plans' }] })
      : orig(m, p)
  await asked(r)
  await r.reply('Session Relay <token> hand-off\nA note')
  await r.advance(5000)
  assert.deepEqual(
    r.log.titles.map((t) => t[0]),
    [r.log.creates[0].id] // session.title is runtime-scoped in the host
  )
})
await test('sound cancellation pauses chat', async () => {
  const r = rig()
  await asked(r)
  await r.reply('', 'interrupted')
  await r.human()
  assert.equal(hidden(r).length, 1)
  assert.equal(r.log.creates.length, 0)
})
await test('sound refusal pauses 15 minutes then human turn can retry', async () => {
  const r = rig()
  await asked(r)
  await r.reply('Session Relay <token> no hand-off: failed check')
  await r.human()
  assert.equal(hidden(r).length, 1)
  await r.advance(16 * 60000)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await test('sound confirmed mark prevents later automatic relay', async () => {
  const r = rig()
  await asked(r)
  await r.reply('Session Relay <token> hand-off\nA note')
  assert.equal(marked(r), true)
  await r.human()
  assert.equal(hidden(r).length, 1)
})
await test('F9 old timeout never warns newer attempt', async () => {
  const r = rig()
  await asked(r)
  await r.reply('Session Relay <token> not yet: need answer')
  await r.advance(20 * 60000)
  await r.human()
  await r.advance(11 * 60000)
  assert.equal(r.log.notes.filter((n) => n.message.includes('taking long')).length, 0)
  await r.reply('Session Relay <token> hand-off\nSecond note')
  assert.equal(r.log.creates.length, 1)
})
await test('F7 owner captured before title awaits', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) => {
    if (m === 'session.title' && !('title' in p)) r.focus()
    return orig(m, p)
  }
  await asked(r)
  await r.reply('Session Relay <token> hand-off\nAlpha note')
  assert.equal(r.log.opens[0].options.route.profile, 'alpha')
})
await test('F8 poll with rising context never submits', async () => {
  const r = rig({ pct: 30 })
  r.render()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.context_breakdown' ? Promise.resolve({ context_percent: 60 }) : orig(m, p)
  await r.advance(32000)
  r.render()
  await flush()
  assert.equal(hidden(r).length, 0)
})
await test('F1 five not-yet duplicates never loop without human input', async () => {
  const r = rig()
  await asked(r)
  const token = r.token()
  for (let i = 0; i < 5; i++) await r.complete('rA', `Session Relay ${token} not yet: need approval`)
  assert.equal(hidden(r).length, 1)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await test('F3 empty completion releases without pause; ordinary answer never seeded', async () => {
  const r = rig()
  await asked(r)
  await r.reply('')
  assert.equal(Object.keys(r.store.get('attempts')).length, 0)
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
  await r.advance(10 * 60000)
  await r.human('rA', 'The capital of Peru is Lima.')
  assert.equal(r.log.creates.length + r.log.newChats.length, 0)
  assert.equal(hidden(r).length, 2)
})
await test('F8 opening idle full chat to read never submits', async () => {
  const r = rig()
  r.render()
  r.focus()
  await r.advance(3000)
  r.render()
  await flush()
  assert.equal(hidden(r).length, 0)
})
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
