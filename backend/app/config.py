"""Config + environment loading. One place for paths and settings."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def _load_dotenv() -> None:
    """Minimal .env reader (KEY=VALUE lines) so we do not need python-dotenv."""
    env = ROOT_DIR / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


@lru_cache(maxsize=1)
def get_config() -> dict:
    path = Path(os.environ.get("NIGHTWAY_CONFIG", BACKEND_DIR / "config.yaml"))
    if not path.is_absolute():
        path = ROOT_DIR / path
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["_data_dir"] = str((BACKEND_DIR / cfg.get("data_dir", "../data")).resolve())
    poly_rel = cfg.get("area_polygon")
    if poly_rel:
        poly_path = (BACKEND_DIR / poly_rel).resolve()
        if not poly_path.exists():
            poly_path = (ROOT_DIR / poly_rel).resolve()
        if not poly_path.exists():
            raise FileNotFoundError(
                f"Configured area_polygon file '{poly_rel}' was not found at {poly_path}. "
                "Silent fallback to circle is not permitted when area_polygon is configured."
            )
        from .adapters.area import load_area
        area = load_area(poly_path, buffer_m=cfg.get("area_buffer_m", 300))
        cfg["center"] = area.centroid
        cfg["radius_m"] = round(area.max_distance_to_vertex(), 1)
        cfg["_area"] = area
    return cfg


def data_dir() -> Path:
    return Path(get_config()["_data_dir"])

