# Desktop host contract and design decisions

Verified read-only against Hermes v0.23.0, commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`. No host changes, private stores, DOM access, composer writes, installation or live gateway/model calls were used for this build.

## Public route and session contracts

- `apps/desktop/src/sdk/index.ts:160–215, 580–590`: `focusedSessionOwner` is **only** `{connectionId, profile}`, not a request route. Capture it synchronously with runtime/stored IDs. Null on a modern host is ambiguous and fails closed. Only an older host without that atom falls back to the profile string.
- `sdk/index.ts:1345–1389`, `sdk/profile-request.ts:25–80`: resolve that immutable owner pair through `host.profileRoutes()` to its unique descriptor (including backend `targetProfile`); use `host.requestProfile` for every session RPC. Bare-profile routing is compatibility-only, refused by the host on ambiguous multi-source setups.
- `sdk/index.ts:1391–1427`: retain the route through the entire request/wait/create/seed/open sequence. Per-request leases alone can retire a secondary socket between RPCs. Release on end/reset/unload; invalidate local async continuations on unload without deleting durable recovery state.
- `tui_gateway/methods_session.py:65–67, 325–476`: `session.create` with `source:'desktop'`, `hidden:false`, `follow_profile_config:true`, an attempt-scoped `idempotency_key`, and no seeded transcript creates a normal empty runtime session. Its response gives `session_id` and `stored_session_id`. Empty sessions deliberately have **no row until first prompt**. `methods_prompt.py:956–973` persists the row and staged user message before returning the `streaming` receipt. This is the normal persisted sidebar chat, not hidden plumbing. Leave unseeded sessions alone.
- `methods_session.py:1138–1164`, `session_registry.py:665–685, 773–830`: `session.active_list` maps runtime `id` to durable `session_key` and status. `session.activate` returns `session_key`, running state, and the profile-aware durable display history reconciled with any memory tail. `session_history.py:316–319, 351–359` excludes hidden user rows and exposes committed `row_id` addresses. Confirmation therefore requires the exact successor `session_key`, the exact note as its first visible user message, and an integer committed `row_id` (matching the submit receipt when supplied). A merely optimistic text row is insufficient.
- `sdk/index.ts:820–862`: `host.openSession(storedId,{route,awaitHydration:true,expectHistory:true})` opens the confirmed successor. The legacy profile-string path uses `{profile}` instead. Title writes target only that successor's stored ID (`methods_session.py:1214`); no list scan or focused-runtime fallback exists.

## Trigger, admission and correlation

Automatic admission is owned by the `message.complete` event, not effects or polling. A completed human-originated turn must be proved by a visible user row in the captured session history (prefer `persisted_turn.user_row_id`, otherwise a new visible user row). Hidden/user rows already handled are excluded. Background completions use a previously observed owner; the SDK has no owner on the event itself, so an unobserved background chat is skipped rather than guessed. Gauge focus observation is read-only and never asks for a hand-off.

`methods_prompt.py:958–973` returns the staged `user_row_id`; `prompt_turn.py:902–942` and `contracts/events.py:263–305` supply `persisted_turn.user_row_id` on completion. Correlate these exact row identities whenever both exist. The fallback reads history and refuses a completion after any newer visible human user row. The per-attempt token is a second, positive reply envelope: wrong token, bold first line, explanatory text, loose delimiter or ordinary answer opens nothing. An empty completed reply ends the attempt without a pause; refusal/cancel/failure pauses only its owner-qualified chat.

All admission awaits recheck the attempt generation and busy map; there is no await between the final guard and `prompt.submit`. Reject queued/steered/non-`streaming` receipts without retry. **Host limit:** `methods_prompt.py:889–918` offers no public atomic idle-only compare-and-submit option; a separate client can start a turn in the transport gap after the final renderer guard. These guards fix the reproduced title-await race; they cannot create a server-side transaction the SDK lacks. Such a race may still submit a queued/redirected request, which is rejected as a relay receipt. No claim of atomic backend admission is made.

## Durable state and crash windows

`ctx.storage` stores owner+stored-id-keyed attempts, pauses, handled human rows, own hidden row IDs, marks, and recoverable notes. Each attempt holds its immutable id/token/generation, owner/route, source IDs, phase, start/deadline, submit receipt and eventual successor IDs/seed receipt. Each timeout has an attempt-scoped disposer. Reset bumps the generation and cancels timers and continuations; unload makes only the old instance inert, leaving persisted state for reconciliation.

On reload, reserve all recovered keys before awaiting. Resolve the same owner; remap runtime IDs via exact stored ID, lazily resume only if no live runtime exists; then read history. Wait if the turn still runs; otherwise handle the arrived protocol reply once. Never resubmit the hidden request. For any successor receipt already recorded, read/confirm it without re-seeding. An ambiguous crash during create or before seed confirmation fails closed, keeps the note, pauses the source, and directs the user to Copy saved note. No automatic request/seed retry or deletion is performed. A confirmed successor stays marked even when opening fails.

## Skill visibility

The public bridge supports it: `sdk/bridge.ts:27–32`, `api/skills.ts:14–19`, `api/client.ts:775–794` expose `host.skills.list` with an explicit connection+backend-profile scope and `enabled` flags. Missing/disabled `hermes-optimize-handoff` skips automatic admission and notices once per owner per plugin load. Manual relay remains available. Older SDKs without the bridge cannot prove availability and rely on the fail-closed reply protocol.

## Gateway limitations retained deliberately

G2 checks the running route before timeout cleanup. G3 uses `_read_pending`, including its age/session/content validation, before scheduling reset. Gateway requests finish existing work before hand-off, name the same three token forms, and keep the gateway's existing tool/web transport.

G1 (snapshot versus event-loop reset admission), G4 (pre-authorization/pre-admission carry consumption), and G5 (in-process live objects unavailable under host isolation) remain documented in the README. These require gateway admission capabilities, not renderer identity checks. The watchdog stays off by default. No setting or isolation policy was changed, and no Desktop parity is claimed for gateway recovery/deferral. The legacy web fenced transport is not Desktop's exact-session receipt engine.

## Tests and provenance

`tests/attempt_host.mjs` executes only the repository's plugin source, not page/model text. Its dependency-sensitive effect shim remains live, models the plugin-before-app completion ordering, durable row receipts and hidden-row projection, shared persistent storage, route RPCs, exact creates and unload disposal. It is not a real React renderer, compositor or live gateway.

Fable's 21 scenarios are adapted in `tests/relay_adversarial.mjs`; Astra's scenarios/delimiter controls in `tests/astra_adversarial.mjs`, with G2/G3 and known G4/G5 assertions in `tests/gateway_adversarial.py`. They require the old bugs to be absent and the old sound paths present. The three pre-existing JS suites retain their behavior scopes; obsolete preview-fallback and fail-open/source-substring assertions are replaced by exact-successor/positive-protocol event assertions. Additional suites cover the numbered contract, restarts, unload continuation, receipts, failed seed/copy recovery, timer cadence and reset.

This is **build-only** evidence. Independent reviews and separate installation approval remain gates. See `docs/test-results.json` for execution output and the old-commit failure matrix.
