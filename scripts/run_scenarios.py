"""Replay every scenario in scenarios/ deterministically and print a results table.

    python scripts/run_scenarios.py [scenario_id ...] [--json out.json]

Exit code 1 if any scenario fails its expectations or produces invalid output
(e.g. an UNKNOWN fact carrying a value).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.config import data_dir, get_config  # noqa: E402
from app.core.sim import scenarios  # noqa: E402
from app.core.world import StaticWorld  # noqa: E402


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    if out_json in args:
        args.remove(out_json)
    static = StaticWorld(get_config(), data_dir())
    scs = [s for s in scenarios.load_all() if not args or s["id"] in args]
    results = []
    for sc in scs:
        r = scenarios.run(static, sc)
        results.append(r)
    head = f"{'scenario':<34}{'pass':<6}{'changed':<9}{'transitions':<13}{'max conf drop':<15}{'weakest':<10}{'plan B':<8}{'invalid':<8}{'ms':>6}"
    print(head)
    print("-" * len(head))
    for r in results:
        print(f"{r['name'][:33]:<34}{'PASS' if r['passed'] else 'FAIL':<6}{('yes' if r['plan_changed'] else 'no'):<9}"
              f"{r['n_transitions']:<13}{r['max_confidence_drop']:<15.2f}{r['weakest_status']:<10}"
              f"{('yes' if r['plan_b_offered'] else 'no'):<8}{r['invalid_outputs']:<8}{r['duration_ms']:>6}")
    print()
    for r in results:
        failed = {k: v for k, v in r["checks"].items() if not v["pass"]}
        mark = "FAIL" if failed else "ok"
        print(f"[{mark}] {r['id']}: " + "; ".join(f"{k}={'ok' if v['pass'] else 'FAIL'} ({v['detail']})"
                                                for k, v in r["checks"].items()))
        for s in r["switches"][:2]:
            print(f"        switch: {s}")
        for t in r["status_transitions"][:3]:
            print(f"        status: {t}")
    if out_json:
        Path(out_json).write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
    sys.exit(0 if all(r["passed"] for r in results) else 1)


if __name__ == "__main__":
    main()
