"""The layers hold: the domain and the engine's services import neither grpc
nor asyncpg (at stage 8 the same code runs in the browser, where neither
exists), and they never read the machine's clock (rule 34): the time comes
from the Clock the engine is built with."""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "src"
PORTABLE = [SOURCE / "commerce" / "domain", SOURCE / "commerce" / "engine"]

BLOCKER = """
import importlib.abc, pkgutil, sys
class Refuse(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in ('grpc', 'asyncpg', 'grpc_health', 'grpc_tools'):
            raise ImportError('the portable layers may not import ' + name)
        return None
sys.meta_path.insert(0, Refuse())
import commerce.domain, commerce.engine
for package in (commerce.domain, commerce.engine):
    for module in pkgutil.walk_packages(package.__path__, package.__name__ + '.'):
        __import__(module.name)
print('imported', sorted(m for m in sys.modules if m.startswith(('commerce.domain', 'commerce.engine'))).__len__())
"""


def run_blocked(extra: str = "") -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", BLOCKER + extra], capture_output=True, text=True,
                          env={"PYTHONPATH": str(SOURCE), "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")},
                          timeout=120)


def test_the_domain_and_the_engine_load_without_grpc_or_asyncpg():
    ran = run_blocked()
    assert ran.returncode == 0, ran.stderr
    assert int(ran.stdout.split()[-1]) >= 20  # every module of both packages was imported


def test_the_blocker_does_refuse_them():
    # The server layer imports grpc: under the same blocker it must fail, or
    # the test above proves nothing.
    ran = run_blocked("import commerce.server.app\n")
    assert ran.returncode != 0 and "may not import grpc" in ran.stderr


READS_THE_CLOCK = {("datetime", "now"), ("datetime", "utcnow"), ("datetime", "today"), ("date", "today"),
                   ("time", "time"), ("time", "monotonic")}


def clock_reads(source: str, name: str) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            if (node.func.value.id, node.func.attr) in READS_THE_CLOCK:
                found.append(f"{name}:{node.lineno} {node.func.value.id}.{node.func.attr}()")
    return found


def test_the_portable_layers_never_read_the_machine_s_clock():
    files = [p for root in PORTABLE for p in root.rglob("*.py")]
    assert len(files) >= 20
    assert [hit for path in files for hit in clock_reads(path.read_text(encoding="utf-8"), path.name)] == []


def test_the_clock_check_finds_a_clock_read():
    source = "from datetime import datetime\nstamp = datetime.now()\n"
    assert clock_reads(source, "sample.py") == ["sample.py:2 datetime.now()"]
