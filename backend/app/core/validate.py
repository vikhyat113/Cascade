"""Output validator: the judging-critical invariants, checked on any JSON we emit.

  * a fact view with status UNKNOWN never carries a value
  * every {lo, hi} interval has lo <= hi; no NaN / infinite numbers
  * every {best, expected, worst} triple is ordered
  * confidences lie in [0, 1]
  * a plan whose critical data is UNKNOWN shows a widened (non-trivial) range
"""
from __future__ import annotations

import math
from datetime import datetime

ORDERED_KEYS = {"eta", "duration_min", "minutes"}


def _walk(obj, path, out):
    if isinstance(obj, dict):
        if obj.get("status") == "UNKNOWN" and "value" in obj and obj["value"] is not None:
            out.append(f"{path}: UNKNOWN fact carries a value ({obj['value']!r})")
        if "lo" in obj and "hi" in obj and isinstance(obj["lo"], (int, float)) and isinstance(obj["hi"], (int, float)):
            if obj["lo"] > obj["hi"] + 1e-9:
                out.append(f"{path}: interval lo {obj['lo']} > hi {obj['hi']}")
        # ordering applies to arrival times / trip durations, not to per-segment waits
        # (arriving early at a stop in the best case legitimately means a longer wait)
        if all(k in obj for k in ("best", "expected", "worst")) and path.rsplit(".", 1)[-1] in ORDERED_KEYS:
            vals = [obj[k] for k in ("best", "expected", "worst")]
            if all(isinstance(v, str) for v in vals):
                try:
                    a, b, c = (datetime.fromisoformat(v) for v in vals)
                    if not (a <= b <= c):
                        out.append(f"{path}: times not ordered best<=expected<=worst")
                except ValueError:
                    pass
            elif all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals) \
                    and not (vals[0] <= vals[1] + 1e-9 <= vals[2] + 2e-9):
                out.append(f"{path}: triple not ordered {vals}")
        if "confidence" in obj and isinstance(obj["confidence"], (int, float)):
            if not (0.0 <= obj["confidence"] <= 1.0):
                out.append(f"{path}: confidence {obj['confidence']} outside [0,1]")
        for k, v in obj.items():
            _walk(v, f"{path}.{k}", out)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _walk(v, f"{path}[{i}]", out)
    elif isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            out.append(f"{path}: non-finite number")


def validate_json(obj, root: str = "$") -> list[str]:
    out: list[str] = []
    _walk(obj, root, out)
    return out


def validate_planset(ps: dict) -> list[str]:
    out = validate_json(ps)
    for i, p in enumerate(ps.get("plans", [])):
        if not p.get("explanation"):
            out.append(f"plans[{i}]: missing explanation")
        crit_unknown = [c for c in p["trust"]["categories"] if c["critical"] and c["status"] == "UNKNOWN"]
        if crit_unknown and p["trust"]["status"] != "UNKNOWN":
            out.append(f"plans[{i}]: critical UNKNOWN data but headline status {p['trust']['status']}")
        if crit_unknown:
            width = p["safety"]["hi"] - p["safety"]["lo"]
            d = p["duration_min"]
            eta_w = (d["worst"] - d["best"]) if d["worst"] is not None and d["best"] is not None else 99
            if width < 5 and eta_w < 3:
                out.append(f"plans[{i}]: UNKNOWN {crit_unknown[0]['name']} did not widen the output range")
    return out
