/**
 * Tests for the desktop half's hand-off request (estate fork).
 *
 * The request asks the agent to write the hand-off with the hand-off skill and
 * reply with the prompt its check printed. The helpers are lifted out of
 * desktop/plugin.js the same way as in desktop_find_fresh_session.mjs.
 *
 * Run: node tests/desktop_handoff_request.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'desktop', 'plugin.js'), 'utf8')

function lift(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, `function ${name} not found in desktop/plugin.js`)
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }
  return source.slice(start, i).replace(/^function /, '')
}

function constant(name) {
  const m = source.match(new RegExp('^const ' + name + " = '([^']*)'$", 'm'))
  assert.ok(m, `const ${name} not found in desktop/plugin.js`)
  return m[1]
}

const NO_HANDOFF = constant('NO_HANDOFF')
const HANDOFF_SKILL = constant('HANDOFF_SKILL')
const handoffRequest = new Function(
  'NO_HANDOFF',
  'HANDOFF_SKILL',
  'return function handoffRequest' + lift('handoffRequest')
)(NO_HANDOFF, HANDOFF_SKILL)
// The lifted bodies are the plugin's own shipped source, as in desktop_find_fresh_session.mjs.
const unfence = new Function('return function unfence' + lift('unfence'))()
const noteOutcome = new Function(
  'NO_HANDOFF',
  'unfence',
  'return function noteOutcome' + lift('noteOutcome')
)(NO_HANDOFF, unfence)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('ok  ' + name)
}

check('the request names the hand-off skill and its check', () => {
  const msg = handoffRequest(46)
  assert.ok(msg.includes('`hermes-optimize-handoff`'))
  assert.ok(msg.includes('check'))
  assert.ok(msg.includes('`prompt`'))
  assert.ok(msg.includes('46%'))
})

check('the request no longer forbids tools: writing the hand-off needs them', () => {
  assert.ok(!/no tools/i.test(handoffRequest(50)))
})

check('the request tells the agent how to report a hand-off that cannot pass', () => {
  assert.ok(handoffRequest(null).includes('"' + NO_HANDOFF + ':"'))
  assert.ok(handoffRequest(null).includes('—'))
})

check('the old free-form note request is gone from the desktop half', () => {
  assert.ok(!source.includes('Write the hand-off note that will continue this work'))
})

check('a reply wrapped in one code block is unwrapped', () => {
  assert.equal(unfence('```text\nMode: build. Take up the work.\nDone when: x\n```'), 'Mode: build. Take up the work.\nDone when: x')
  assert.equal(unfence('  ```\nOne line.\n```  '), 'One line.')
})

check('a plain reply, or one with a code block inside, is left as it is', () => {
  assert.equal(unfence('Mode: build.\n```\ncode\n```\nMore.'), 'Mode: build.\n```\ncode\n```\nMore.')
  assert.equal(unfence('  Plain prompt.  '), 'Plain prompt.')
  assert.equal(unfence(null), '')
})

check('a failure reply is recognised by its opening words', () => {
  assert.ok((NO_HANDOFF + ': the check failed twice').startsWith(NO_HANDOFF))
  assert.ok(source.includes('note.startsWith(NO_HANDOFF)'))
})

check('a cancelled or failed turn ends the wait instead of being skipped', () => {
  assert.equal(noteOutcome({ status: 'interrupted', text: 'Operation interrupted' }).kind, 'cancelled')
  assert.equal(noteOutcome({ status: 'failed', text: '' }).kind, 'cancelled')
})

check('a finished reply is the note; an empty one is skipped; a refusal opens no chat', () => {
  assert.deepEqual(noteOutcome({ status: 'complete', text: '```\nMode: build.\n```' }), { kind: 'note', note: 'Mode: build.' })
  assert.deepEqual(noteOutcome({ text: 'Mode: build.' }), { kind: 'note', note: 'Mode: build.' })
  assert.equal(noteOutcome({ status: 'complete', text: '  ' }).kind, 'skip')
  assert.equal(noteOutcome(null).kind, 'skip')
  assert.equal(noteOutcome({ status: 'complete', text: NO_HANDOFF + ': check failed' }).kind, 'refused')
})

check('a chat is marked relayed only once its new chat has opened, never when the request is sent', () => {
  const submit = source.indexOf("host.request('prompt.submit'")
  const nextLines = source.slice(submit, source.indexOf('\n', source.indexOf('\n', submit) + 1))
  assert.ok(!nextLines.includes('markRelayed'))
  assert.equal(source.split('markRelayed(').length - 1, 1) // one call (defined as `markRelayed = id =>`)
  const open = source.indexOf('host.newChat(profile || null)')
  assert.ok(source.slice(open, open + 200).includes('markRelayed(a.storedId)'))
})

check('after a cancel the automatic relay pauses 15 minutes; the manual reset stays', () => {
  assert.ok(source.includes('const CANCEL_COOLDOWN_MS = 15 * 60000'))
  assert.ok(source.includes('cancelledAt.get(storedId) || 0) < CANCEL_COOLDOWN_MS'))
  assert.ok(source.includes("ctx.storage.remove('relayed')"))
  assert.ok(source.includes('cancelledAt.clear()'))
})

console.log(`\n${passed} checks, 0 failures`)
