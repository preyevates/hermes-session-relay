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
const unfence = new Function('return function unfence' + lift('unfence'))()

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

console.log(`\n${passed} checks, 0 failures`)
