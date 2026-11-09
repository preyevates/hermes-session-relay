"""Run every shipped event suite and Python script; optionally compare historical code.

Run: python3 -I -B tests/run_regressions.py [--baseline f98060c]
No installed plugin or live gateway is used. Baseline extraction stays in TMPDIR.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run_suite(root, javascript_tests):
    results = []
    commands = [["node", str(test)] for test in javascript_tests]
    commands += [
        ["python3", "-I", "-B", str(root / "tests" / name)]
        for name in (
            "test_auto_handoff.py",
            "test_auto_reset.py",
            "gateway_adversarial.py",
        )
    ]
    for command in commands:
        env = dict(os.environ, RELAY_ROOT=str(root), PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run(
            command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=120
        )
        output = (
            (result.stdout + result.stderr)
            .replace(str(root), "<tested-root>")
            .replace(str(ROOT), "<repo>")
            .replace(str(Path.home()), "~")
        )
        counts = re.search(
            r"(\d+) (?:passed|checks), (\d+) (?:failed|failures)", output
        )
        results.append(
            {
                "suite": Path(command[-1]).name,
                "exit_code": result.returncode,
                "counts": [int(n) for n in counts.groups()] if counts else None,
                "output": output,
            }
        )
        print(
            f"{root.name}: {results[-1]['suite']} exit={result.returncode} counts={results[-1]['counts']}"
        )
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline")
    args = parser.parse_args()
    js_tests = sorted((ROOT / "tests").glob("*.mjs"))
    report: dict = {"candidate": run_suite(ROOT, js_tests)}
    if args.baseline:
        # Git owns the fixture bytes. Never replace failed retrieval with synthetic code.
        with tempfile.TemporaryDirectory(
            prefix="relay-baseline-", dir=os.environ.get("TMPDIR")
        ) as tmp:
            base = Path(tmp)
            archive = base / "source.tar"
            with archive.open("wb") as target:
                subprocess.run(
                    ["git", "archive", args.baseline],
                    cwd=ROOT,
                    stdout=target,
                    check=True,
                )
            with tarfile.open(archive) as source:
                source.extractall(base, filter="data")
            for name in (
                "test_auto_handoff.py",
                "test_auto_reset.py",
                "gateway_adversarial.py",
            ):
                shutil.copyfile(ROOT / "tests" / name, base / "tests" / name)
            report["baseline_commit"] = subprocess.check_output(
                ["git", "rev-parse", args.baseline], cwd=ROOT, text=True
            ).strip()
            report["baseline"] = run_suite(base, js_tests)
    # This file is a generated execution record, not a fixture or a guessed transcript.
    destination = ROOT / "docs" / "test-results.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(any(r["exit_code"] for r in report["candidate"]))
