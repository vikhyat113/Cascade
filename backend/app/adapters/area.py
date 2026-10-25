"""Area adapter: re-exports Area and load_area from scripts.common."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.common import Area, get_area, load_area  # noqa: E402

__all__ = ["Area", "load_area", "get_area"]
