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
await test('R2/F8 focus, effects and gauge poll never submit; human completion does', async () => {
  const r = rig()
  r.render()
  await flush()
  await r.advance(31000)
  r.focus()
  await flush()
  assert.equal(r.log.submits.length, 0)
  await r.human('rB')
  assert.equal(r.log.submits.length, 1)
})
await test('R1/3/11/D2/D3/D8 capture owner and cancel async admission on busy/reset', async () => {
  for (const action of ['busy', 'reset', 'switch']) {
    const r = rig()
    const orig = r.host.request
    let release
    r.host.request = (m, p) =>
      m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
    await r.human()
    assert.ok(release)
    if (action === 'busy') r.busy('rA', true)
    else if (action === 'reset') r.reset()
    else r.focus()
    release({ title: 'Work-1' })
    await flush()
    if (action !== 'switch') assert.equal(r.log.submits.length, 0)
    else {
      assert.equal(r.log.submits[0].session_id, 'rA')
      await r.reply('Session Relay <token> hand-off\nAlpha note')
      assert.equal(r.log.opens[0].options.route.profile, 'alpha')
    }
  }
})
await test('R5/8 exact envelope seeds prompt only, into exact captured-owner successor', async () => {
  const r = rig()
  await r.human()
  assert.ok(r.token())
  await r.reply('Session Relay <token> hand-off\nOnly this prompt')
  assert.equal(r.log.creates.length, 1)
  assert.equal(r.log.submits[1].text, 'Only this prompt')
  assert.equal(r.log.submits[1].session_id, r.log.creates[0].id)
  assert.equal(r.log.opens[0].id, r.log.creates[0].stored)
  assert.equal(r.log.composed.length, 0)
})
await test('R12/F6 reload reconciles already arrived reply exactly once without resubmission', async () => {
  const r = rig()
  await r.human()
  const token = r.token()
  r.dispose()
  const s = r.sessions.get('rA')
  s.running = false
  s.messages.push({
    role: 'assistant',
    row_id: 5000,
    text: `Session Relay ${token} hand-off\nRecovered note`
  })
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  await r2.advance(3000)
  assert.equal(r2.log.creates.length, 1)
  assert.equal(r2.log.submits.filter((p) => p.display_kind === 'hidden').length, 0)
  await r2.complete('rA', `Session Relay ${token} hand-off\nRecovered note`)
  assert.equal(r2.log.creates.length, 1)
})
await test('R12 backend restart remaps exact stored id, waits for same submitted row', async () => {
  const r = rig()
  await r.human()
  const token = r.token(),
    user = r.log.submits[0]
  r.dispose()
  const s = r.sessions.get('rA')
  r.sessions.delete('rA')
  r.sessions.set('rRestart', s)
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  await r2.complete('rRestart', `Session Relay ${token} hand-off\nRestart note`)
  assert.equal(r2.log.creates.length, 1)
  assert.equal(r2.log.submits.filter((p) => p.display_kind === 'hidden').length, 0)
})
await test('R13 missing skill skips automatic request, informs once; manual still works', async () => {
  const r = rig()
  r.host.skills.list = async () => []
  await r.human()
  await r.human()
  assert.equal(r.log.submits.length, 0)
  assert.equal(r.log.notes.filter((n) => n.message.includes('not available')).length, 1)
  await r.manual()
  assert.equal(r.log.submits.length, 1)
})
await test('R8 retained note has a working Copy saved note action', async () => {
  const r = rig()
  await r.human()
  const orig = r.host.request
  r.host.request = (m, p) => (m === 'session.create' ? Promise.reject(Error('offline')) : orig(m, p))
  await r.reply('Session Relay <token> hand-off\nCopy me')
  const row = r.settings().props.children.find((e) => e?.props?.title === 'Copy saved note')
  assert.ok(row)
  let copied
  r.ctx.os.writeClipboard = async (text) => {
    copied = text
    return true
  }
  await row.props.action.props.onClick()
  assert.equal(copied, 'Copy me')
})
await test('R12 live backend restart without plugin reload matches stored id', async () => {
  const r = rig()
  await r.human()
  const s = r.sessions.get('rA')
  r.sessions.delete('rA')
  r.sessions.set('rA2', s)
  r.focus('rA2', 'sA', 'alpha')
  await r.complete('rA2', `Session Relay ${r.token()} hand-off\nLive restart note`)
  assert.equal(r.log.creates.length, 1)
  assert.equal(r.log.submits.filter((p) => p.display_kind === 'hidden').length, 1)
})
await test('R2 background completion uses previously observed owner, not current focus', async () => {
  const r = rig()
  r.render()
  await flush()
  r.focus('rB', 'sB', 'beta')
  await r.human('rA')
  assert.equal(r.log.submits[0].session_id, 'rA')
  await r.reply('Session Relay <token> hand-off\nBackground note')
  assert.equal(r.log.opens[0].options.route.profile, 'alpha')
})
await test('R8 legacy profile route opens by profile option', async () => {
  const r = rig()
  delete r.host.state.focusedSessionOwner
  await r.human()
  await r.reply('Session Relay <token> hand-off\nLegacy note')
  assert.equal(r.log.opens[0].options.profile, 'alpha')
})
await test('R12 unloaded async admission cannot submit or overwrite successor instance', async () => {
  const r = rig()
  let release
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
  await r.human()
  r.dispose()
  const r2 = rig({ store: r.store, backend: r.sessions })
  await flush()
  release({ title: 'Old title' })
  await flush()
  assert.equal(r.log.submits.length, 0)
  assert.equal(r2.log.submits.length, 0)
  assert.equal(Object.keys(r2.store.get('attempts')).length, 0)
})
await test('R5 first line is exact, not whitespace-normalized; seed body preserved', async () => {
  for (const prefix of [' ', '\n']) {
    const r = rig()
    await r.human()
    await r.reply(prefix + 'Session Relay <token> hand-off\nPrompt')
    assert.equal(r.log.creates.length, 0)
  }
  const r = rig()
  await r.human()
  await r.reply('Session Relay <token> hand-off\n  Indented prompt  ')
  assert.equal(r.log.submits[1].text, '  Indented prompt  ')
})
await test('R3 runtime/stored mismatch or backend busy (even stale renderer) refuses admission', async () => {
  for (const fault of ['identity', 'busy']) {
    const r = rig()
    const orig = r.host.request
    r.host.request = async (m, p) => {
      const v = await orig(m, p)
      if (m === 'session.activate' && p.session_id === 'rA')
        return fault === 'identity' ? { ...v, session_key: 'wrong-store' } : { ...v, running: true }
      return v
    }
    await r.human()
    assert.equal(r.log.submits.length, 0)
  }
})
await test('R3 final gateway idle snapshot rejects backend turn started during title await', async () => {
  const r = rig()
  let release
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.title' && !('title' in p) ? new Promise((res) => (release = res)) : orig(m, p)
  await r.human()
  r.sessions.get('rA').running = true
  release({ title: 'Work-1' })
  await flush()
  assert.equal(r.log.submits.length, 0)
})
await test('R2 chip stays a gauge while an attempt waits', async () => {
  const r = rig()
  await r.human()
  const spans = r.render().props.children.props.children
  assert.equal(spans[1].props.children, '50%')
})
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
