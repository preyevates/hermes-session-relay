// Former preview matcher checks are superseded: preview/source/recency may
// never establish successor identity. These nine event checks use exact IDs.
import assert from 'node:assert/strict'
import { rig } from './attempt_host.mjs'
let passed = 0
for (const source of ['local', 'unknown', 'desktop', 'gui', 'cron', 'subagent', null, '', 'api_server']) {
  const r = rig()
  const orig = r.host.request
  r.host.request = (m, p) =>
    m === 'session.list'
      ? Promise.resolve({
          sessions: [
            { id: 'unrelated', source, preview: 'Same opening words', started_at: Date.now() / 1000 }
          ]
        })
      : orig(m, p)
  await r.human()
  await r.reply('Session Relay <token> hand-off\nSame opening words')
  await r.advance(5000)
  assert.equal(r.log.creates.length, 1)
  assert.equal(r.log.opens[0].id, r.log.creates[0].stored)
  assert.deepEqual(
    r.log.titles.map((t) => t[0]),
    [r.log.creates[0].id] // session.title is runtime-scoped in the host
  )
  assert.equal(
    r.log.requests.some((r) => r.method === 'session.list'),
    false
  )
  passed++
  console.log('PASS exact successor; ignores unrelated ' + source + ' row')
}
console.log(`${passed} passed, 0 failed`)
