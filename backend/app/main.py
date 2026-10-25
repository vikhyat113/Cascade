"""FastAPI entry point.

    cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000

Starts the Engine (loads the cached data in data/), runs the live loop in the
background and, if frontend/dist exists, serves the built UI on the same port.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .api.routes import ENGINE, router
from .config import ROOT_DIR, get_config
from .core.engine import Engine
from .core.world import DataMissing

log = logging.getLogger("nightway")


class SelectiveGZip:
    """gzip everything except SSE streams (gzip would buffer them)."""

    def __init__(self, app):
        self.app = app
        self.gz = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].endswith("/stream"):
            return await self.app(scope, receive, send)
        return await self.gz(scope, receive, send)


async def live_loop(tick_s: float):
    while True:
        await asyncio.sleep(tick_s)
        e = ENGINE["engine"]
        if e is None:
            continue
        try:
            await run_in_threadpool(e.tick)
        except Exception:      # keep the loop alive whatever happens
            log.exception("live tick failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_config()
    try:
        ENGINE["engine"] = await run_in_threadpool(Engine, cfg)
    except DataMissing as e:
        ENGINE["error"] = str(e)
        log.error(str(e))
    task = asyncio.create_task(live_loop(float(cfg["sim"].get("tick_s", 2.0))))
    yield
    task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="NightWay: night-time decision engine", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(SelectiveGZip)
    app.include_router(router)
    dist = ROOT_DIR / "frontend" / "dist"
    if dist.exists():
        @app.get("/scenarios", include_in_schema=False)
        def scenarios_page():
            return FileResponse(dist / "index.html")
        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.environ.get("NIGHTWAY_PORT", 8000)))
