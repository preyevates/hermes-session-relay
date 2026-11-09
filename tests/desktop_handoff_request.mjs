// The old source-substring tests are now whole-plugin request/protocol events.
import assert from 'node:assert/strict'
import { rig } from './attempt_host.mjs'
let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log('PASS ' + name)
}
await check('request names skill, check, prompt, percentage', async () => {
  const r = rig()
  await r.human()
  for (const s of ['hermes-optimize-handoff', 'check', '`prompt`', '50%'])
    assert.ok(r.log.submits[0].text.includes(s))
})
await check('tools allowed; finish then commit/push then skill', async () => {
  const r = rig()
  await r.human()
  const t = r.log.submits[0].text
  assert.ok(!/no tools|do not start or continue/i.test(t))
  assert.ok(t.includes('commit and push'))
  assert.ok(t.indexOf('First finish') < t.indexOf('Then load'))
})
await check('request carries all three token-bound first lines', async () => {
  const r = rig()
  await r.human()
  for (const s of [' hand-off', ' not yet:', ' no hand-off:'])
    assert.ok(r.log.submits[0].text.includes('Session Relay ' + r.token() + s))
})
await check('unknown context manual request uses dash', async () => {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) => (m === 'session.context_breakdown' ? Promise.resolve({}) : orig(m, p))
  await r.manual()
  assert.ok(r.log.submits[0].text.includes('—'))
})
await check('whole code fence removed', async () => {
  const r = rig()
  await r.human()
  await r.reply('```text\nSession Relay <token> hand-off\nMode: build.\n```')
  assert.equal(r.log.submits[1].text, 'Mode: build.')
})
await check('internal code fence in prompt preserved', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> hand-off\nMode: build.\n```\ncode\n```\nMore.')
  assert.equal(r.log.submits[1].text, 'Mode: build.\n```\ncode\n```\nMore.')
})
await check('exact refusal opens nothing', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> no hand-off: check failed')
  assert.equal(r.log.creates.length, 0)
})
for (const status of ['interrupted', 'failed'])
  await check(status + ' ends wait and pauses', async () => {
    const r = rig()
    await r.human()
    await r.reply('', status)
    assert.equal(Object.keys(r.store.get('attempts')).length, 0)
    assert.equal(Object.keys(r.store.get('pauses')).length, 1)
  })
await check('empty reply releases without pause', async () => {
  const r = rig()
  await r.human()
  await r.reply('')
  assert.equal(Object.keys(r.store.get('attempts')).length, 0)
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
})
await check('mark absent until confirmed seed', async () => {
  const r = rig()
  await r.human()
  assert.equal(Object.keys(r.store.get('relayed') || {}).length, 0)
  await r.reply('Session Relay <token> hand-off\nNote')
  assert.equal(Object.keys(r.store.get('relayed')).length, 1)
})
await check('pause is 15 minutes and reset clears it', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> no hand-off: nope')
  const deadline = Object.values(r.store.get('pauses'))[0]
  assert.ok(deadline > Date.now() + 14 * 60000 && deadline <= Date.now() + 15 * 60000)
  r.reset()
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
})
await check('not yet no warning, pause or chat', async () => {
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> not yet: approval')
  assert.equal(r.log.notes.length, 0)
  assert.equal(Object.keys(r.store.get('pauses')).length, 0)
  assert.equal(r.log.creates.length, 0)
})
await check('reset invalidates waiting attempt', async () => {
  const r = rig()
  await r.human()
  const token = r.token()
  r.reset()
  await r.complete('rA', `Session Relay ${token} hand-off\nOld note`)
  assert.equal(r.log.creates.length, 0)
})
console.log(`${passed} passed, 0 failed`)
