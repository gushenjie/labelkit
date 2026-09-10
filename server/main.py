"""FastAPI application entry."""

from __future__ import annotations

import atexit
import logging
import traceback
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from server.api import audit, auth, datasets, frames, materials, media, model_previews, models, projects, public_datasets, settings, suggest, system, tasks, users
from server.api.deps import get_current_user
from server.config import settings as app_settings
from server.core.dataset_service import reconcile_dataset_version_files
from server.db.database import SessionLocal, init_db
from server.worker.task_worker import TaskWorker

_UPLOAD_DEBUG_LOG = Path(app_settings.data_dir) / "model_upload_debug.log"


def _debug_log(message: str) -> None:
    try:
        _UPLOAD_DEBUG_LOG.parent.mkdir(parents=True, exist_ok=True)
        with _UPLOAD_DEBUG_LOG.open("a", encoding="utf-8") as handle:
            handle.write(message + "\n")
    except Exception:
        pass


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logging.getLogger("labelkit.model_upload").setLevel(logging.INFO)

init_db()

with SessionLocal() as _db:
    TaskWorker.reconcile_stale_tasks(_db)
    reconcile_dataset_version_files(_db)

app = FastAPI(title=app_settings.app_name, version="0.2.0")


@app.middleware("http")
async def capture_upload_failures(request: Request, call_next):
    if "/models/upload" in request.url.path:
        _debug_log(f"REQUEST {request.method} {request.url.path} content-type={request.headers.get('content-type')}")
    try:
        response = await call_next(request)
    except Exception:
        _debug_log(f"UNHANDLED {request.method} {request.url.path}\n{traceback.format_exc()}")
        raise
    if "/models/upload" in request.url.path:
        _debug_log(f"RESPONSE {request.method} {request.url.path} status={response.status_code}")
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, (HTTPException, StarletteHTTPException, RequestValidationError)):
        raise exc
    _debug_log(f"EXCEPTION_HANDLER {request.method} {request.url.path}\n{traceback.format_exc()}")
    logging.exception("未处理异常 | %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"服务器内部错误：{exc}"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=app_settings.cors_origins,
    allow_origin_regex=app_settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_auth = [Depends(get_current_user)]

app.include_router(projects.router, dependencies=_auth)
app.include_router(auth.router)
app.include_router(users.router, dependencies=_auth)
app.include_router(audit.router, dependencies=_auth)
app.include_router(media.router, dependencies=_auth)
app.include_router(frames.router, dependencies=_auth)
app.include_router(materials.router, dependencies=_auth)
app.include_router(datasets.router, dependencies=_auth)
app.include_router(datasets.global_router, dependencies=_auth)
app.include_router(public_datasets.router, dependencies=_auth)
app.include_router(tasks.router, dependencies=_auth)
app.include_router(tasks.global_router, dependencies=_auth)
app.include_router(models.router, dependencies=_auth)
app.include_router(models.global_router, dependencies=_auth)
app.include_router(model_previews.router)
app.include_router(settings.router, dependencies=_auth)
app.include_router(suggest.router, dependencies=_auth)
app.include_router(system.router, dependencies=_auth)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": app_settings.app_name}


def _shutdown_cleanup() -> None:
    TaskWorker.shutdown_cleanup()
    model_previews.preview_manager.close_all()


app.router.add_event_handler("shutdown", _shutdown_cleanup)
atexit.register(TaskWorker.shutdown_cleanup)
