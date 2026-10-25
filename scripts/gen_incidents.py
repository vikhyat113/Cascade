"""(Re)generate the SYNTHETIC incident history (data/incidents_synthetic.csv).

    backend/.venv/Scripts/python scripts/gen_incidents.py

Seeded from config.yaml, biased by real OSM proxies (unlit/unknown lighting,
isolation, industrial land). To use real data instead, drop a CSV with columns
lat, lon, hour[, minute, night, type] at the same path and set synthetic=0.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.config import data_dir, get_config  # noqa: E402
from app.core.world import StaticWorld  # noqa: E402


def main():
    path = data_dir() / "incidents_synthetic.csv"
    if path.exists():
        path.unlink()
    st = StaticWorld(get_config(), data_dir())       # regenerates the CSV when missing
    print(f"  wrote {path.relative_to(ROOT)}: {st.incidents.n_rows} synthetic incidents over {st.incidents.nights} nights")


if __name__ == "__main__":
    main()
