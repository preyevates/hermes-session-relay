/** Session Relay: owner-qualified, durable hand-off attempts. No draft/composer writes.
 * Host contract and receipt limits: docs/host-contract.md. */
import {
  atom,
  Button,
  cn,
  haptic,
  host,
  ListRow,
  SegmentedControl,
  Tip,
  ToggleRow,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect } from 'react'

const ID = 'session-relay'
const TITLE_LIMIT = 40
const DEFAULTS = { auto: true, threshold: 45 }
const NOTE_TIMEOUT_MS = 1800000
const RECHECK_MS = 300000
const CANCEL_COOLDOWN_MS = 900000
const PCT_REFRESH_MS = 30000
const HANDOFF_SKILL = 'hermes-optimize-handoff'

function handoffRequest(pct, token) {
  const prefix = 'Session Relay ' + token
  return [
    '[Session Relay plugin — service message]',
    'Context usage in this session: ' + (pct == null ? '—' : pct + '%') + '.',
    'Do not start new work. First finish the work in hand, if it can finish without his answer: complete it, then commit and push what it changed.',
    'Then load the skill `' +
      HANDOFF_SKILL +
      '` and follow its Procedure: put lasting results in their homes, write the hand-off from its template, and run its `check` until it exits 0.',
    'Use exactly one of these first lines (with this token), with no preamble or markdown emphasis:',
    prefix + ' hand-off',
    'After that first line, put only the `prompt` the check printed, exactly as printed. The plugin creates and seeds the new chat itself.',
    prefix + ' not yet: <what is needed from him to finish>',
    'Use not yet if finishing needs his answer; nothing opens and the next request waits for his next completed reply.',
    prefix + ' no hand-off: <reason the check cannot pass>',
    'Use no hand-off for any other failure. Anything outside this protocol opens no chat.'
  ].join('\n')
}
function nextTitle(raw) {
  const t = String(raw || '').trim()
  if (!t) return ''
  const m = t.match(/^(.*?)(\d+)(\D*)$/)
  if (!m) return t.slice(0, TITLE_LIMIT - 2) + '-2'
  const n = String(parseInt(m[2], 10) + 1)
  const num = m[2].length > 1 && m[2].startsWith('0') ? n.padStart(m[2].length, '0') : n
  const suffix = num + m[3]
  return m[1].slice(0, Math.max(0, TITLE_LIMIT - suffix.length)) + suffix
}
function unfence(reply) {
  const t = String(reply || '').replace(/\r\n/g, '\n')
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  return m ? m[1] : t
}
function noteOutcome(payload, token) {
  const p = payload || {}
  if (p.status !== 'complete') return { kind: 'cancelled' }
  const text = unfence(typeof p.text === 'string' ? p.text : '')
  if (!text.trim()) return { kind: 'empty' }
  const [line, ...rest] = text.split('\n')
  const prefix = 'Session Relay ' + token
  if (line === prefix + ' hand-off' && rest.join('\n').trim()) return { kind: 'note', note: rest.join('\n') }
  if (
    line.startsWith(prefix + ' not yet: ') &&
    line.slice((prefix + ' not yet: ').length).trim() &&
    !rest.length
  )
    return { kind: 'deferred' }
  if (
    line.startsWith(prefix + ' no hand-off: ') &&
    line.slice((prefix + ' no hand-off: ').length).trim() &&
    !rest.length
  )
    return { kind: 'refused' }
  return { kind: 'invalid' }
}
const readAtom = (name, fallback = null) => host.state[name]?.get?.() ?? fallback
const ownerKey = (owner) =>
  typeof owner === 'string' ? ['profile', owner] : [owner.connectionId, owner.profile]
const chatKey = (owner, storedId) => JSON.stringify([...ownerKey(owner), storedId])

export default {
  id: ID,
  name: 'Session Relay',
  register(ctx) {
    const prefs = atom({ ...DEFAULTS, ...ctx.storage.get('prefs', {}) })
    const $relay = atom({ phase: 'idle', title: '' })
    const $pct = atom(null)
    let generation = ctx.storage.get('attemptGeneration', 0)
    let serial = 0
    const attempts = new Map()
    const timers = new Map()
    const retained = new Map()
    const recovering = new Set()
    const pauses = { ...ctx.storage.get('pauses', {}) }
    const seen = { ...ctx.storage.get('seenHumanRows', {}) }
    const ownRows = { ...ctx.storage.get('ownRows', {}) }
    const missingSkill = new Set()
    const observedChats = new Map()
    function rememberFocus() {
      const runtimeId = readAtom('focusedSessionId'),
        storedId = readAtom('focusedStoredSessionId')
      const raw = host.state.focusedSessionOwner
        ? readAtom('focusedSessionOwner')
        : readAtom('focusedSessionProfile', readAtom('profile'))
      if (!runtimeId || !storedId || !raw) return null
      const owner = typeof raw === 'string' ? raw : { ...raw }
      const chat = { runtimeId, storedId, owner }
      observedChats.set(runtimeId, chat)
      return chat
    }
    rememberFocus()
    const readRelayed = () => ctx.storage.get('relayed', {}) || {}
    const persist = () => {
      ctx.storage.set('attempts', Object.fromEntries(attempts))
      ctx.storage.set('pauses', pauses)
      ctx.storage.set('seenHumanRows', seen)
      ctx.storage.set('ownRows', ownRows)
    }
    const update = (patch) => {
      prefs.set({ ...prefs.get(), ...patch })
      ctx.storage.set('prefs', prefs.get())
    }
    let disposed = false
    const live = (a) => !disposed && attempts.get(a.key)?.id === a.id && a.generation === generation
    ctx.onDispose(() => {
      disposed = true
      for (const cancel of timers.values()) cancel()
      for (const release of retained.values()) release()
      timers.clear()
      retained.clear()
      // Preserve durable attempts for the next instance; late continuations are inert.
    })
    const isBusy = (id) => readAtom('busyBySession', {})[id] === true
    const cancelTimer = (a) => {
      timers.get(a.id)?.()
      timers.delete(a.id)
    }
    const end = (a, { pause = false, message = '', kind = 'info' } = {}) => {
      if (!live(a)) return
      cancelTimer(a)
      retained.get(a.id)?.()
      retained.delete(a.id)
      attempts.delete(a.key)
      if (pause) pauses[a.key] = Date.now() + CANCEL_COOLDOWN_MS
      persist()
      $relay.set({ phase: 'idle', title: '' })
      if (message) host.notify({ kind, message })
    }
    const fail = (a, reason) => {
      if (!live(a)) return
      if (a.note) {
        const notes = { ...ctx.storage.get('savedNotes', {}) }
        notes[a.key] = { note: a.note, owner: a.owner, storedId: a.storedId, successor: a.successor || null }
        ctx.storage.set('savedNotes', notes)
      }
      end(a, {
        pause: true,
        message:
          'Session relay: ' +
          reason +
          (a.note
            ? ' The note is kept in Settings → Session Relay → Copy saved note. Or copy the reply in the old chat without its first protocol line.'
            : ' Automatic relay pauses in this chat for 15 minutes.')
      })
    }
    const validStart = (a) => {
      if (!live(a)) return false
      if (isBusy(a.runtimeId)) {
        end(a)
        return false
      }
      return true
    }
    const rpc = (a, method, params = {}) => host.requestProfile(a.route || a.owner, method, params)
    const resolveRoute = async (a) => {
      if (typeof a.owner === 'string') return a.owner
      const routes = await host.profileRoutes()
      if (!live(a)) return null
      const matches = routes.filter(
        (r) => r.connectionId === a.owner.connectionId && r.profile === a.owner.profile
      )
      if (matches.length !== 1) throw Error('The asking chat owner is no longer uniquely routable.')
      return { ...matches[0] }
    }
    function capture(
      runtimeId = readAtom('focusedSessionId'),
      storedId = readAtom('focusedStoredSessionId'),
      ownerOverride = undefined
    ) {
      if (!runtimeId || !storedId) return null
      const ownerAtom = host.state.focusedSessionOwner
      const raw =
        ownerOverride ??
        (ownerAtom ? ownerAtom.get() : readAtom('focusedSessionProfile', readAtom('profile')))
      // A modern host's ambiguous null owner is not a profile-only fallback.
      if (!raw) return null
      const owner = typeof raw === 'string' ? raw : { ...raw }
      const key = chatKey(owner, storedId)
      if (attempts.has(key)) return null
      const id =
        Date.now().toString(36) + '-' + (++serial).toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const a = {
        id,
        token: id.slice(-6),
        generation,
        runtimeId,
        storedId,
        owner,
        key,
        phase: 'admitting',
        startedAt: Date.now(),
        deadline: Date.now() + NOTE_TIMEOUT_MS
      }
      attempts.set(key, a)
      persist() // Synchronous reservation precedes every await.
      return a
    }
    async function precisePercent(a) {
      const res = await rpc(a, 'session.context_breakdown', { session_id: a.runtimeId })
      return typeof res?.context_percent === 'number' ? res.context_percent : null
    }
    async function refreshPct() {
      rememberFocus()
      const runtimeId = readAtom('focusedSessionId'),
        storedId = readAtom('focusedStoredSessionId')
      const raw = host.state.focusedSessionOwner
        ? readAtom('focusedSessionOwner')
        : readAtom('focusedSessionProfile', readAtom('profile'))
      if (!runtimeId || !storedId || !raw) {
        $pct.set(null)
        return
      }
      const owner = typeof raw === 'string' ? raw : { ...raw }
      try {
        const a = { runtimeId, storedId, owner }
        // Read-only gauge does not create/resume an attempt.
        if (typeof owner !== 'string') {
          const routes = await host.profileRoutes()
          a.route = routes.find((r) => r.connectionId === owner.connectionId && r.profile === owner.profile)
          if (!a.route) return
        }
        const pct = await precisePercent(a)
        if (
          readAtom('focusedSessionId') === runtimeId &&
          chatKey(raw, storedId) ===
            chatKey(
              readAtom('focusedSessionOwner', readAtom('focusedSessionProfile')),
              readAtom('focusedStoredSessionId')
            )
        )
          $pct.set(pct)
      } catch {
        /* A failed gauge is not permission to submit. */
      }
    }
    async function start(a, manual, event) {
      try {
        if (!validStart(a)) return
        const p = prefs.get()
        if (!manual && (!p.auto || readRelayed()[a.key] || (pauses[a.key] || 0) > Date.now())) {
          end(a)
          return
        }
        a.route = await resolveRoute(a)
        if (!validStart(a)) return
        // Keep the exact route alive: requestProfile's per-call lease is insufficient.
        if (host.retainProfile) {
          const release = await host.retainProfile(a.route)
          if (!validStart(a)) {
            release()
            return
          }
          retained.set(a.id, release)
        }
        const snapshot = await rpc(a, 'session.activate', { session_id: a.runtimeId })
        if (!validStart(a)) return
        if (snapshot.session_key !== a.storedId) {
          fail(a, 'The asking chat runtime no longer matches its stored id.')
          return
        }
        if (snapshot.running) {
          end(a)
          return
        }
        const messages = snapshot.messages || []
        a.baseline = Math.max(0, ...messages.map((m) => Number(m.row_id) || 0))
        if (!manual) {
          const userId = event?.payload?.persisted_turn?.user_row_id
          const user =
            userId != null
              ? messages.find((m) => m.role === 'user' && m.row_id === userId)
              : [...messages].reverse().find((m) => m.role === 'user')
          if (
            !user ||
            user.display_kind === 'hidden' ||
            (ownRows[a.key] || []).includes(user.row_id) ||
            (seen[a.key] || 0) >= user.row_id
          ) {
            end(a)
            return
          }
          seen[a.key] = user.row_id
          persist()
          if (host.skills?.list) {
            const scope =
              typeof a.owner === 'string'
                ? a.owner
                : { connectionId: a.owner.connectionId, profile: a.route.targetProfile }
            const skills = await host.skills.list(scope)
            if (!validStart(a)) return
            if (!skills.some((s) => s.name === HANDOFF_SKILL && s.enabled !== false)) {
              const ownerId = JSON.stringify(ownerKey(a.owner))
              if (!missingSkill.has(ownerId)) {
                missingSkill.add(ownerId)
                host.notify({
                  kind: 'info',
                  message:
                    'Session relay: ' +
                    HANDOFF_SKILL +
                    ' is not available in the asking profile; automatic request skipped.'
                })
              }
              end(a)
              return
            }
          }
        }
        const pct = await precisePercent(a)
        if (!validStart(a)) return
        if (!manual && (pct == null || pct < p.threshold)) {
          end(a)
          return
        }
        const title = await rpc(a, 'session.title', { session_id: a.runtimeId })
        if (!validStart(a)) return
        a.newTitle = nextTitle(title?.title)
        const admission = await rpc(a, 'session.activate', { session_id: a.runtimeId, omit_messages: true })
        if (!validStart(a)) return
        if (admission.session_key !== a.storedId || admission.running) {
          end(a)
          return
        }
        a.phase = 'submitting'
        a.submittedAt = Date.now()
        a.deadline = a.submittedAt + NOTE_TIMEOUT_MS
        persist()
        // No await between this final admission guard and submission.
        if (!validStart(a)) return
        const receipt = await rpc(a, 'prompt.submit', {
          session_id: a.runtimeId,
          text: handoffRequest(pct, a.token),
          display_kind: 'hidden'
        })
        if (!live(a)) return
        if (receipt?.status !== 'streaming') {
          fail(
            a,
            'The hand-off request was not admitted as a new turn. Nothing will be retried automatically.'
          )
          return
        }
        a.userRowId = receipt.user_row_id || null
        if (a.userRowId) ownRows[a.key] = [...(ownRows[a.key] || []), a.userRowId].slice(-100)
        a.phase = 'waiting'
        persist()
        $relay.set({ phase: 'started', title: a.newTitle })
        arm(a, Math.max(0, a.deadline - Date.now()))
        if (a.earlyEvent) {
          const e = a.earlyEvent
          delete a.earlyEvent
          await completeAttempt(a, e)
        }
      } catch (e) {
        fail(a, 'Could not start: ' + String(e.message || e))
      }
    }
    function relayNow(opts) {
      const a = capture()
      if (a) void start(a, Boolean(opts?.manual), opts?.event)
    }
    async function seed(a) {
      if (!live(a)) return
      a.phase = 'creating'
      persist()
      cancelTimer(a)
      try {
        const child = await rpc(a, 'session.create', {
          source: 'desktop',
          hidden: false,
          follow_profile_config: true,
          idempotency_key: 'session-relay:' + a.id
        })
        if (!live(a)) return
        if (!child.session_id || !child.stored_session_id)
          throw Error('The gateway returned no exact successor identity.')
        a.successor = { runtimeId: child.session_id, storedId: child.stored_session_id }
        a.phase = 'seeding'
        persist()
        const before = await rpc(a, 'session.activate', { session_id: a.successor.runtimeId })
        if (!live(a)) return
        if (
          before.running ||
          isBusy(a.successor.runtimeId) ||
          (before.messages || []).some((m) => m.role === 'user')
        )
          throw Error('The successor is no longer an empty idle chat.')
        a.phase = 'seed-submitting'
        persist()
        const receipt = await rpc(a, 'prompt.submit', { session_id: a.successor.runtimeId, text: a.note })
        if (!live(a)) return
        if (receipt?.status !== 'streaming') throw Error('The successor did not admit the note.')
        a.seedRowId = receipt.user_row_id
        a.phase = 'confirming'
        persist()
        await confirmSuccessor(a)
      } catch (e) {
        fail(a, 'Could not confirm the successor: ' + String(e.message || e))
      }
    }
    async function confirmSuccessor(a) {
      const snap = await rpc(a, 'session.activate', { session_id: a.successor.runtimeId })
      if (!live(a)) return
      if (snap.session_key !== a.successor.storedId) throw Error('The successor identity changed.')
      const first = (snap.messages || []).find((m) => m.role === 'user')
      if (
        !first ||
        !Number.isInteger(first.row_id) ||
        first.text !== a.note ||
        (a.seedRowId && first.row_id !== a.seedRowId)
      )
        throw Error('The exact successor has no durable first-message confirmation.')
      ctx.storage.set('relayed', { ...readRelayed(), [a.key]: Date.now() })
      a.phase = 'confirmed'
      persist()
      await finishSuccessor(a)
    }
    async function finishSuccessor(a) {
      if (!live(a)) return
      let title = a.newTitle || 'new chat'
      try {
        if (a.newTitle) await rpc(a, 'session.title', { session_id: a.successor.storedId, title: a.newTitle })
      } catch {
        host.notify({
          kind: 'info',
          message: 'Session relay: the successor exists, but its title could not be changed.'
        })
      }
      if (!live(a)) return
      try {
        await host.openSession(a.successor.storedId, {
          ...(typeof a.route === 'string' ? { profile: a.route } : { route: a.route }),
          awaitHydration: true,
          expectHistory: true
        })
        if (!live(a)) return
        end(a, { message: 'Session relay ready: "' + title + '".', kind: 'success' })
      } catch {
        end(a, {
          message:
            'Session relay: the chat exists as "' +
            title +
            '" (' +
            a.successor.storedId +
            '), but could not be opened. Select it in the chat list.'
        })
      }
    }
    async function completeAttempt(a, event) {
      if (!live(a)) return
      if (recovering.has(a.id) && !event.reconciled) {
        a.recoveryEvent = event
        return
      }
      if (a.phase === 'submitting') {
        a.earlyEvent = event
        return
      }
      if (a.phase !== 'waiting') return
      const p = event.payload || {}
      const receipt = p.persisted_turn
      if (a.userRowId && receipt?.user_row_id != null && receipt.user_row_id !== a.userRowId) return
      // With no receipt, prove no visible human turn followed our hidden submit.
      if (!(a.userRowId && receipt?.user_row_id)) {
        try {
          const snap = await rpc(a, 'session.activate', { session_id: a.runtimeId })
          if (!live(a) || a.phase !== 'waiting') return
          if (
            (snap.messages || []).some(
              (m) => m.role === 'user' && m.display_kind !== 'hidden' && m.row_id > a.baseline
            )
          )
            return
        } catch (e) {
          fail(a, 'Could not correlate the hand-off reply.')
          return
        }
      }
      if (!live(a) || a.phase !== 'waiting') return
      const outcome = noteOutcome(p, a.token)
      if (outcome.kind === 'deferred') {
        end(a)
        return
      }
      if (outcome.kind === 'empty') {
        end(a, { message: 'Session relay: no hand-off arrived (the turn had no reply text).' })
        return
      }
      if (outcome.kind !== 'note') {
        end(a, {
          pause: true,
          message:
            'Session relay: ' +
            (outcome.kind === 'cancelled'
              ? 'hand-off cancelled or failed.'
              : 'no hand-off; the reply was refused or did not match this request.')
        })
        return
      }
      a.note = outcome.note
      persist()
      await seed(a)
    }
    function arm(a, ms) {
      cancelTimer(a)
      timers.set(
        a.id,
        ctx.setTimeout(async () => {
          if (!live(a) || a.phase !== 'waiting') return
          try {
            const snap = await rpc(a, 'session.activate', { session_id: a.runtimeId })
            if (!live(a) || a.phase !== 'waiting') return
            if (snap.running || isBusy(a.runtimeId)) {
              host.notify({
                kind: 'warning',
                message: 'Session relay: the hand-off is taking long; still waiting for this turn.'
              })
              a.deadline = Date.now() + RECHECK_MS
              persist()
              arm(a, RECHECK_MS)
            } else end(a, { message: 'Session relay: no hand-off arrived — press ⚡ to retry.' })
          } catch {
            fail(a, 'Could not check the hand-off turn.')
          }
        }, ms)
      )
    }
    function reset() {
      generation++
      ctx.storage.set('attemptGeneration', generation)
      for (const a of attempts.values()) {
        cancelTimer(a)
        retained.get(a.id)?.()
      }
      retained.clear()
      attempts.clear()
      for (const map of [pauses, seen, ownRows]) for (const key of Object.keys(map)) delete map[key]
      ctx.storage.remove('relayed')
      persist()
      $relay.set({ phase: 'idle', title: '' })
      host.notify({ kind: 'info', message: 'Session relay: marks cleared.' })
    }
    ctx.onEvent('message.complete', (event) => {
      const id = event?.session_id || event?.payload?.session_id
      if (!id) return
      const matches = [...attempts.values()].filter((a) => a.runtimeId === id)
      if (matches.length) {
        for (const a of matches) void completeAttempt(a, event)
        return
      }
      // Backend restarts mint new runtime ids. Prove the mapping on each attempt's
      // captured route; a focus change by itself is never an ownership receipt.
      for (const a of attempts.values()) {
        if (a.phase !== 'waiting') continue
        void (async () => {
          try {
            const rows = await rpc(a, 'session.active_list')
            if (!live(a) || a.phase !== 'waiting') return
            const hits = (rows.sessions || []).filter((r) => r.session_key === a.storedId)
            if (hits.length !== 1 || hits[0].id !== id) return
            a.runtimeId = id
            persist()
            await completeAttempt(a, event)
          } catch {
            /* The attempt's deadline handles an unavailable backend. */
          }
        })()
      }
      if (event.payload?.status !== 'complete') return
      const chat = readAtom('focusedSessionId') === id ? rememberFocus() : observedChats.get(id)
      if (!chat) return // Never guess an unobserved background chat's owner.
      const a = capture(chat.runtimeId, chat.storedId, chat.owner)
      if (!a) return
      timers.set(
        a.id,
        ctx.setTimeout(() => {
          timers.delete(a.id)
          if (live(a)) void start(a, false, event)
        }, 0)
      )
    })
    async function restore() {
      for (const saved of Object.values(ctx.storage.get('attempts', {}))) {
        if (!saved?.id || !saved.key || saved.generation !== generation) continue
        const a = attempts.get(saved.key)
        if (!a || a.id !== saved.id) continue
        recovering.add(a.id)
        try {
          a.route = await resolveRoute(a)
          if (!live(a)) continue
          if (host.retainProfile) {
            const release = await host.retainProfile(a.route)
            if (!live(a)) {
              release()
              continue
            }
            retained.set(a.id, release)
          }
          // Admission interrupted before submit is safe to discard, never replay.
          if (a.phase === 'admitting') {
            end(a)
            continue
          }
          const remap = async (storedId) => {
            const rows = await rpc(a, 'session.active_list')
            if (!live(a)) return null
            const hits = (rows.sessions || []).filter((r) => r.session_key === storedId)
            if (hits.length > 1) throw Error('Ambiguous live session identity.')
            if (hits.length === 1) return hits[0].id
            const resumed = await rpc(a, 'session.resume', { session_id: storedId, lazy: true })
            if (!live(a)) return null
            return resumed.session_id
          }
          if (a.successor) {
            a.successor.runtimeId = await remap(a.successor.storedId)
            if (!live(a)) continue
            persist()
            if (a.phase === 'confirmed') await finishSuccessor(a)
            else await confirmSuccessor(a) // Read/confirm only; never send the note twice.
            continue
          }
          if (!['waiting', 'submitting'].includes(a.phase)) {
            fail(
              a,
              'Reload interrupted successor creation; check the chat list. Nothing will be sent again automatically.'
            )
            continue
          }
          a.runtimeId = await remap(a.storedId)
          if (!live(a)) continue
          const snap = await rpc(a, 'session.activate', { session_id: a.runtimeId })
          if (!live(a)) continue
          if (snap.session_key !== a.storedId) throw Error('The asking chat identity changed.')
          a.phase = 'waiting'
          persist()
          const after = (snap.messages || []).filter((m) => Number(m.row_id) > a.baseline)
          // A human redirect makes history-only turn attribution unprovable.
          if (after.some((m) => m.role === 'user' && m.display_kind !== 'hidden')) {
            fail(
              a,
              'A human turn followed the request while disconnected; the reply cannot safely be attributed.'
            )
            continue
          }
          if (snap.running) {
            arm(a, Math.max(0, a.deadline - Date.now()))
            continue
          }
          const reply = [...after].reverse().find((m) => m.role === 'assistant')
          if (reply)
            await completeAttempt(a, {
              reconciled: true,
              payload: {
                status: 'complete',
                text: reply.text,
                persisted_turn: a.userRowId ? { user_row_id: a.userRowId } : undefined
              }
            })
          else end(a, { message: 'Session relay: no hand-off arrived while disconnected.' })
        } catch (e) {
          fail(a, 'Could not recover the hand-off: ' + String(e.message || e))
        } finally {
          recovering.delete(a.id)
          const pending = a.recoveryEvent
          delete a.recoveryEvent
          if (pending && live(a) && a.phase === 'waiting') void completeAttempt(a, pending)
        }
      }
    }
    // Reserve all restored keys synchronously so a completion cannot start a second ask.
    for (const saved of Object.values(ctx.storage.get('attempts', {}))) {
      if (saved?.id && saved.generation === generation) {
        attempts.set(saved.key, { ...saved })
        recovering.add(saved.id)
      }
    }
    void restore()

    function SettingsPage() {
      useValue($relay) // Refresh confirmation and saved-note controls when an attempt ends.
      const p = useValue(prefs)
      const measured = useValue($pct)
      const u = useValue(host.state.focusedUsage)
      const storedId = useValue(host.state.focusedStoredSessionId)
      const streamed = u && typeof u.context_percent === 'number' ? u.context_percent : null
      const pct = measured != null ? measured : streamed
      const owner = readAtom('focusedSessionOwner', readAtom('focusedSessionProfile', readAtom('profile')))
      const marked = storedId && owner ? Boolean(readRelayed()[chatKey(owner, storedId)]) : false

      return jsxs('div', {
        children: [
          jsx(ToggleRow, {
            checked: p.auto,
            label: 'Automatic relay',
            description:
              'When the session context reaches the threshold, the agent writes a hand-off note and the plugin opens a new chat with that note as its first message (the title number is incremented).',
            onChange: (on) => update({ auto: on })
          }),
          jsx(ListRow, {
            title: 'Trigger threshold',
            description:
              'Hermes compacts the history at about 50%; the threshold is kept below that so the relay fires before compaction.',
            action: jsx(SegmentedControl, {
              value: String(p.threshold),
              onChange: (v) => update({ threshold: Number(v) }),
              options: [
                { id: '30', label: '30%' },
                { id: '40', label: '40%' },
                { id: '45', label: '45%' },
                { id: '50', label: '50%' }
              ]
            })
          }),
          jsx(ListRow, {
            title: 'Current state',
            description:
              pct == null
                ? 'The active session context has not been measured yet.'
                : 'Active session context: ' + pct + '%.',
            action: jsx('span', {
              className: 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)',
              children: marked ? 'relay already started' : 'relay not started yet'
            })
          }),
          jsx(ListRow, {
            title: 'Reset marks',
            description: 'Useful to retest the relay on the same session.',
            action: jsx(Button, {
              variant: 'secondary',
              size: 'sm',
              onClick: reset,
              children: 'Reset'
            })
          }),
          ...Object.entries(ctx.storage.get('savedNotes', {})).map(([key, saved]) =>
            jsx(ListRow, {
              title: 'Copy saved note',
              description:
                'Hand-off from ' + saved.storedId + '. Kept because successor confirmation failed.',
              action: jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                children: 'Copy',
                onClick: async () => {
                  const copied = await ctx.os.writeClipboard(saved.note)
                  host.notify({
                    kind: copied ? 'info' : 'warning',
                    message: copied
                      ? 'Session relay: note copied. Paste it into a new chat under the original profile.'
                      : 'Session relay: clipboard unavailable. Copy the reply in the old chat without its first protocol line.'
                  })
                }
              })
            })
          )
        ]
      })
    }

    function Chip() {
      const p = useValue(prefs)
      const measured = useValue($pct)
      const u = useValue(host.state.focusedUsage)
      const runtimeId = useValue(host.state.focusedSessionId)
      const storedId = useValue(host.state.focusedStoredSessionId)
      const owner = useValue(host.state.focusedSessionOwner || host.state.focusedSessionProfile)
      const streamed = u && typeof u.context_percent === 'number' ? u.context_percent : null
      const pct = measured != null ? measured : streamed

      useEffect(() => {
        $pct.set(null)
        void refreshPct()
      }, [runtimeId, storedId, owner?.connectionId, owner?.profile, typeof owner === 'string' ? owner : null])

      // The chip measures only. Automatic admission belongs to completed human turns.
      const near = pct != null && p && pct >= p.threshold
      const label = pct == null ? '—' : pct + '%'
      const tip =
        pct == null
          ? 'Session relay: context not measured yet. Click to start a relay manually.'
          : 'Session relay — context ' +
            pct +
            '%. Auto threshold ' +
            (p ? p.threshold : '?') +
            '%. Click to start manually.'

      return jsx(Tip, {
        label: tip,
        children: jsxs('button', {
          type: 'button',
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
            near ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)',
            'hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          onClick: () => {
            haptic('tap')
            void relayNow({ manual: true })
          },
          children: [jsx('span', { 'aria-hidden': true, children: '⚡' }), jsx('span', { children: label })]
        })
      })
    }

    // The chip must show a number even between turns: poll the same read-only
    // RPC the desktop's own context gauge uses.
    const tickPct = () => {
      void refreshPct()
      ctx.setTimeout(tickPct, PCT_REFRESH_MS)
    }
    ctx.setTimeout(tickPct, 1200)

    if (ctx.registerSettingsPage) {
      ctx.registerSettingsPage({
        id: 'main',
        title: 'Session Relay',
        icon: 'sync',
        render: SettingsPage
      })
    }

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 145,
      render: () => jsx(Chip, {})
    })
  }
}
