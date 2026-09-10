"""FastAPI application entry."""

from __future__ import annotations

import atexit

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.api import audit, auth, datasets, frames, media, model_previews, models, projects, public_datasets, settings, suggest, system, tasks, users
from server.api.deps import get_current_user
from server.config import settings as app_settings
from server.core.dataset_service import reconcile_dataset_version_files
from server.db.database import SessionLocal, init_db
from server.worker.task_worker import TaskWorker

init_db()

with SessionLocal() as _db:
    TaskWorker.reconcile_stale_tasks(_db)
    reconcile_dataset_version_files(_db)

app = FastAPI(title=app_settings.app_name, version="0.2.0")

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
