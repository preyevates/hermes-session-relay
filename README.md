# Session Relay — a Hermes Agent plugin

![Session Relay: hand off a long-running chat to a fresh session](assets/banner.png)

**Hand your long-running chat over to a fresh session before the context window fills up.**

> **Fork note (`estate/handoff-skill`, estate.9).** The automatic threshold defaults to 85% (choices 70/80/85/90; a saved older choice falls back to 85%), for a host that compacts later, such as `compression.threshold: 0.95`. Desktop tracks persisted, owner-qualified attempts, not the focused chat: only a completed human turn above the threshold (or ⚡ at any level) asks once. The agent finishes existing work, runs `hermes-optimize-handoff`'s check, and replies with exactly `Session Relay <token> hand-off` plus the check's prompt, `Session Relay <token> not yet: <what is needed>`, or `Session Relay <token> no hand-off: <reason>`; one whole-reply code fence is allowed. Anything else opens nothing. Not-yet waits silently for the next human completion; refusal, cancellation and failure pause that chat for 15 minutes. The successor is created and seeded through its captured owner, confirmed by exact durable first-message identity, then marked, titled and opened; no composer/draft or recent-row fallback is used. Attempts and pauses survive reloads, Reset invalidates in-flight work, and missing skills skip automatic requests. The successor opens in the asking chat's profile (its create request names the profile, as Desktop's own New Chat does, so a backend serving several profiles cannot open it in the default one), in its workspace and on its model, provider, reasoning and service tier, not the profile default, and is titled through its runtime id; leading blank lines and trailing whitespace in the reply are ignored. Accepted limit: Hermes Desktop gives plugins no atomic check-idle-and-submit, so a request can still collide with work started in the same chat from another window at the same instant. See [host contract and limits](docs/host-contract.md). Upstream: [ikuro4kin-dev/hermes-session-relay](https://github.com/ikuro4kin-dev/hermes-session-relay).
>
> **Gateway limits (watchdog off by default).** G2/G3 are fixed: an active turn keeps its note past the nominal deadline, and an invalid note cannot authorize reset. G1 remains: opt-in watchdog reset uses a stale idle snapshot and can interrupt new work. G4 remains (Frasier-approved scope): carry is consumed before authorization/durable admission, so shared-thread denial or failed ingress can lose it. G5 remains: `plugins.isolation=host` cannot expose the live runner/store used by gateway carry/watchdog. Do not enable the watchdog for this build or weaken isolation to bypass this limitation. Gateway request wording uses the same finish-first/token protocol, but its legacy tool/carry/web mechanism is not the Desktop attempt engine and has no promise of Desktop deferral/recovery parity.

Hermes compacts a conversation when its context reaches `compression.threshold` of the model window (50% by default). Compaction keeps a summary and drops details; after two or three compactions a long working session turns into a soup of half-remembered facts and duplicated messages. Session Relay solves the same problem the other way round: as the context approaches the threshold, the agent writes a hand-off note and opens a **new chat** that starts with that note — while the old chat stays untouched and readable.

## How it works

1. The desktop half displays context usage without starting work from the gauge.
2. After a completed human turn above the threshold (85% by default), it submits one **hidden service message** with a per-attempt token. The reply must follow the fork protocol above.
3. The plugin uses owner-routed `session.create` and `prompt.submit` to seed the exact successor, verifies its durable first user message, then calls `host.openSession` on that exact stored id. It never types into a draft.
4. Only that successor is titled with the old title's number incremented — `Bugfix-6` → `Bugfix-7`.
5. A toast announces the new chat or explains where to copy a retained note after a failed confirmation.
6. The ⚡ chip in the status bar starts a relay manually, below the threshold too.

Nothing is deleted: the previous session remains in the sidebar as the full record.

On channels outside the desktop app (Telegram and other messaging platforms) the flow is manual: the agent prepares the hand-off, you send `/new`, and the gateway half attaches the note to the first ordinary message you send in the new session — that message opens with the hand-off as its heading block.

## Requirements

- **Desktop contract verified at Hermes v0.23.0, `2bd378ed1b`**; the gateway half retains its upstream compatibility scope.
- No agent tool is required by Desktop: it uses public owner-routed SDK calls (`requestProfile`, `profileRoutes`, `retainProfile`, `openSession`). The gateway half ships its own `session_relay_handoff` tool.

## Package layout

This is a **unified package**: one plugin, two halves.

```
session-relay/
├── plugin.yaml      # manifest (name, version, declared hooks/tools)
├── __init__.py      # gateway half: per-chat hand-off store, carry after /new, pre_gateway_dispatch hook
└── desktop/
    └── plugin.js    # desktop half: context meter, threshold, service message
```

## Install

**From Git (recommended):**

```bash
hermes plugins install https://github.com/ikuro4kin-dev/hermes-session-relay
```

This puts the package in `$HERMES_HOME/plugins/session-relay/`. Then:

1. **Gateway half (optional)** — enable it in `config.yaml`:

   ```yaml
   plugins:
     enabled: [session-relay]
     entries:
       session-relay:
         allow_gateway_injection: true
   ```

2. **Desktop half** — open Hermes Desktop → **Capabilities → Plugins → Rescan**, then enable **Session Relay**. Both halves are opt-in and default to off.
3. Restart the gateway after enabling the Python half (`hermes gateway restart`).

**Desktop-only, without the gateway half:** copy `desktop/plugin.js` to
`$HERMES_HOME/desktop-plugins/session-relay/plugin.js` (Windows: `%LOCALAPPDATA%\hermes\desktop-plugins\session-relay\plugin.js`) and enable the plugin in **Settings → Plugins**. No build step, no dependencies: it is a single ESM file.

## Settings (desktop)

| Setting | Meaning |
|---|---|
| **Automatic relay** | Fire the hand-off automatically when the threshold is reached. |
| **Trigger threshold** | 70 / 80 / 85 / 90 %. The default is 85 %; keep it below `compression.threshold`, raised to suit (for example 0.95), so the relay fires before Hermes compacts. A saved choice outside these options falls back to 85 %. |
| **Reset marks** | Forget that a relay already ran for the current session (useful for testing). |

## Using the gateway half (Telegram and other channels)

1. Ask the agent for a relay / hand-off for the current conversation. It calls the **`session_relay_handoff`** tool with the note as `text`; the note is stored in `$HERMES_HOME/plugin-data/session-relay/` under the chat's session id.
2. Send `/new` (or `/reset`).
3. The plugin parks the prepared hand-off for this chat and gives the new session the previous title with the number incremented.
4. Your next ordinary message in that chat — not a command — opens with the hand-off as its heading block. This is deliberate: a brand-new session has not committed a turn yet, and the gateway's session authority refuses to seed one (`not_found`), so the note rides the first real message instead of being lost.
5. A hand-off is bound to the chat that prepared it (its session id): only that chat can pick it up — a note written in another conversation is never attached. A parked note is dropped when the chat has moved on (another `/new`, a restored session).
6. A prepared hand-off is valid for 24 hours; if it is older, it is ignored.

The tool lives in the `session_relay` toolset. It is enabled with the plugin; if you turned the toolset off in `hermes tools`, turn it back on for the platform you use.

## Automatic hand-off on messaging channels

Opt-in and off by default. When enabled, a watchdog thread inside the gateway checks every routed chat on the configured platforms once a tick:

- **context** — the size of the chat's last API call as a share of the model's context window (read from the tail of `logs/agent.log`);
- **quiet** — no turn for at least `auto_min_idle_seconds`, and no turn in flight for that chat;
- **same surface** — the last turn of that session was driven by that same platform, so a session the desktop drove is never reset here.

Past the threshold the plugin sends one service turn that asks the agent to write the hand-off. As soon as the note is stored and the turn is over, the chat's session is reset through the gateway's own `/new` funnel (no title, no text). Your next ordinary message in that chat opens with the hand-off — the same carry step the manual flow uses. Nothing is injected, reset or rewritten while a turn is running.

Settings live under `plugins.entries.session-relay.settings`:

| Setting | Default | Meaning |
|---|---|---|
| `auto_handoff` | `false` | Master switch; read on every tick, so it needs no restart. |
| `auto_threshold_percent` | `85` | Share of the model's context window that triggers the relay. |
| `auto_min_idle_seconds` | `60` | The chat must have been quiet for this long. |
| `auto_poll_seconds` | `60` | Watchdog tick. |
| `auto_channels` | `["telegram"]` | Platforms to watch (`telegram`, `api_server`, …). |

Set them with `hermes config set`, for example:

```
hermes config set plugins.entries.session-relay.settings.auto_handoff true
hermes config set plugins.entries.session-relay.settings.auto_threshold_percent 85
```

A session is relayed at most once per day: the watchdog remembers the session ids it triggered in `auto_state.json` in the plugin's own data folder, so a gateway restart cannot fire the same relay twice.

## Disclosure

What the plugin does with your data and tokens:

- Each relay submits **one service message to the agent**, which starts a normal agent turn — this consumes model tokens like any other turn.
- The hand-off text is produced by the agent from the current conversation and submitted into the new chat's composer; it becomes the first user message of the new session.
- The desktop half keeps two keys in the plugin's own storage: `prefs` (your settings) and `relayed` (session ids already relayed, pruned after 30 days).
- The gateway half writes one hand-off file per chat under `$HERMES_HOME/plugin-data/session-relay/` (hand-off text, the chat's session id, timestamp); after `/new` it moves the note into a per-chat carry file and deletes it once the chat's next message has picked it up (or when the chat has moved on). Files older than 24 hours are pruned.
- The automatic watchdog reads the **tail of `logs/agent.log`** (session id, size of the last API call, model, platform) to decide whether a chat is full; it writes `auto_state.json` in its own data folder (session ids already relayed, pruned after 24 hours). It never reads message text and never leaves the machine.
- No network calls, no telemetry, no shell access, no access to files outside the plugin's own folder, its `plugin-data` directory and the log tail above. Everything else goes through Hermes's own plugin APIs.

## Limitations

- Both halves rely on Hermes plugin APIs (`session.context_breakdown`, `prompt.submit`, `host.newChat`, `host.composer`, the `message.complete` event, and the `on_session_reset` + `pre_gateway_dispatch` hooks). A future Hermes release may change them — the plugin would need an update.
- The automatic trigger works on the desktop and, opt-in, on gateway channels (`auto_handoff`). The gateway half measures context from the log line Hermes writes after each API call; a release that renames that line would leave the watchdog idle while the manual flow keeps working.
- The relay runs only when the session is idle (it never interrupts a running turn).

## License

MIT — see [LICENSE](LICENSE).
