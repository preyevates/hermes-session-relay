// Original eight event scenarios retained against the receipt-aware live-effect rig.
import assert from 'node:assert/strict'
import { rig } from './attempt_host.mjs'
let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log('PASS ' + name)
}
const hidden = (r) => r.log.submits.filter((p) => p.display_kind === 'hidden')
await check('asking profile survives later focus switch', async () => {
  const r = rig()
  await r.human()
  r.focus()
  await r.reply('Session Relay <token> hand-off\nMode: build. Take up the work.')
  assert.equal(r.log.opens[0].options.route.profile, 'alpha')
  // estate.8: the new chat is created in that profile, not in the focused or launch profile.
  assert.equal(r.log.creates[0].p.profile, 'alpha')
})
await check('stopped turn without reply releases and other chat still works', async () => {
  const r = rig()
  await r.human()
  r.busy('rA', false)
  await r.advance(31 * 60000)
  assert.ok(r.log.notes.some((n) => n.message.includes('no hand-off arrived')))
  r.focus()
  await r.human('rB')
  assert.deepEqual(
    hidden(r).map((p) => p.session_id),
    ['rA', 'rB']
  )
})
await check('running past timeout stays eligible for late note', async () => {
  const r = rig()
  await r.human()
  await r.advance(31 * 60000)
  assert.ok(r.log.notes.some((n) => n.message.includes('taking long')))
  assert.ok(!r.log.notes.some((n) => n.message.includes('no hand-off arrived')))
  await r.reply('Session Relay <token> hand-off\nLate')
  assert.equal(r.log.creates.length, 1)
})
await check('not yet opens nothing, warns nothing, no own-completion loop', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> not yet: needs approval')
  await r.advance(3000)
  assert.equal(hidden(r).length, 1)
  assert.equal(r.log.creates.length, 0)
  assert.equal(r.log.notes.length, 0)
})
await check('next human reply after not yet brings request back', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> not yet: needs approval')
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await check('quick human answer is not skipped by old deferral check', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> not yet: approval')
  r.busy('rA', true)
  await r.advance(3000)
  r.busy('rA', false)
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await check('refusal/cancel pause automatic relay for 15 minutes', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> no hand-off: check failed')
  await r.human()
  assert.equal(hidden(r).length, 1)
  await r.advance(16 * 60000)
  await r.human()
  assert.equal(hidden(r).length, 2)
  await r.reply('', 'interrupted')
  await r.human()
  assert.equal(hidden(r).length, 2)
})
await check('another chat reply is never the note', async () => {
  const r = rig()
  await r.human()
  await r.complete('rB', 'Mode: build. Elsewhere')
  assert.equal(r.log.creates.length, 0)
  await r.reply('Session Relay <token> hand-off\nRight note')
  assert.equal(r.log.creates.length, 1)
})
console.log(`${passed} passed, 0 failed`)
