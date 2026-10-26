"""Download + build every cached dataset for the city in backend/config.yaml.

    backend/.venv/Scripts/python scripts/fetch_all.py [--force]

Order: places (Nominatim) -> zones -> weather + weather grid (Open-Meteo) -> POIs (Overpass) ->
street graphs (OSMnx) -> night lights (NASA GIBS) -> transit (OSM relations / estimated) -> synthetic incidents.
Run it once before the event (needs internet); the demo itself is fully offline.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ["geocode_places.py", "area.py", "fetch_weather.py", "fetch_weather_grid.py", "fetch_pois.py", "fetch_graph.py",
         "fetch_viirs.py", "build_transit.py", "gen_incidents.py"]


def main():
    extra = [a for a in sys.argv[1:] if a == "--force"]
    for step in STEPS:
        print(f"== {step}")
        args = [sys.executable, str(HERE / step)] + (extra if step in ("fetch_pois.py", "fetch_graph.py") else [])
        if subprocess.call(args) != 0:
            sys.exit(f"{step} failed")
    print("All data cached in data/. You can now run the backend offline.")


if __name__ == "__main__":
    main()
