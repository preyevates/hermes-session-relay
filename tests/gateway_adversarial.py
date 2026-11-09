"""Offline, no gateway calls. Run python3 -I -B harness/gateway_adversarial.py."""

import importlib.util
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace as NS

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "reviewed_relay", root.parent / "__init__.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Context:
    def __init__(self):
        self.hooks = {}
        self.injected = []

    def get_config(self, k, default=None):
        return {"auto_handoff": True}.get(k, default)

    def inject_message(self, text, **kw):
        self.injected.append((text, kw))
        return True

    def register_tool(self, **kw):
        pass

    def register_hook(self, n, f):
        self.hooks[n] = f

    def on_unload(self, f):
        pass


with tempfile.TemporaryDirectory(prefix="gateway-", dir=root) as directory:
    data = Path(directory)
    mod._data_dir = lambda: data
    entry = NS(
        session_id="old", session_key="route", origin=NS(platform=NS(value="telegram"))
    )
    store = NS(lookup_by_session_key=lambda route: entry, list_sessions=lambda: [])
    runner = NS(session_store=store, _running_agents={})
    mod._gateway_runner = lambda: runner
    mod._scan_log = lambda path: {}
    mod._last_user_word_ts = lambda sid: 0
    ctx = Context()
    mod._write_pending("old", "fresh valid handoff")
    mod._save_auto_state(
        {"old": {"stage": "triggered", "route": "route", "ts": time.time() - 21 * 60}}
    )
    runner._running_agents = {"route": object()}
    mod._auto_tick(ctx)
    assert mod._pending_path("old").exists()
    assert "old" in mod._load_auto_state()
    print("PASS G2 active turn retains pending note and trigger state")

    runner._running_agents = {}
    mod._pending_path("old").write_text("{invalid json")
    mod._save_auto_state(
        {"old": {"stage": "triggered", "route": "route", "ts": time.time()}}
    )
    reset = []

    def schedule(r, e):
        reset.append(mod._read_pending(e.session_id))
        return True

    mod._schedule_reset = schedule
    mod._auto_tick(ctx)
    assert reset == []
    print("PASS G3 unreadable note cannot authorize reset")

    mod._start_watchdog = lambda ctx: NS(set=lambda: None)
    mod.register(ctx)
    event = NS(
        text="unauthorized sender in shared thread",
        internal=False,
        source=NS(platform=NS(value="telegram")),
    )
    gateway = NS(
        _session_key_for_source=lambda s: "route",
        _is_user_authorized_for_source=lambda s: False,
    )
    mod._write_carry(
        "route", session_id="old", text="private carry", platform="telegram"
    )
    result = ctx.hooks["pre_gateway_dispatch"](
        event=event, gateway=gateway, session_store=store
    )
    assert result["action"] == "rewrite" and mod._read_carry("route") is None
    assert not gateway._is_user_authorized_for_source(event.source)
    print("KNOWN G4 (documented, not fixed): carry consumed before authorization")

    # Load only the host's stdlib-only wire codec, not the gateway or any profile.
    wire_spec = importlib.util.spec_from_file_location(
        "host_wire", Path.home() / ".hermes/hermes-agent/hermes_cli/plugin_host_wire.py"
    )
    wire = importlib.util.module_from_spec(wire_spec)
    wire_spec.loader.exec_module(wire)
    mod._write_carry(
        "route", session_id="old", text="private carry", platform="telegram"
    )
    result = ctx.hooks["pre_gateway_dispatch"](
        event=event,
        gateway=wire.Opaque("GatewayRunner"),
        session_store=wire.Opaque("SessionStore"),
    )
    assert result is None and mod._read_carry("route") is not None
    print("KNOWN G5 (documented, not fixed): isolated host cannot resolve carry")

print(
    "4 checks, 0 failed (2 fixes and 2 documented limitations); temporary data removed"
)
