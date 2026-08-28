"""FastAPI application entry."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.api import datasets, frames, media, models, projects, public_datasets, settings, suggest, system, tasks
from server.config import settings as app_settings
from server.db.database import SessionLocal, init_db
from server.worker.task_worker import TaskWorker

init_db()

with SessionLocal() as _db:
    TaskWorker.reconcile_stale_tasks(_db)

app = FastAPI(title=app_settings.app_name, version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=app_settings.cors_origins,
    allow_origin_regex=app_settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(media.router)
app.include_router(frames.router)
app.include_router(datasets.router)
app.include_router(public_datasets.router)
app.include_router(tasks.router)
app.include_router(tasks.global_router)
app.include_router(models.router)
app.include_router(settings.router)
app.include_router(suggest.router)
app.include_router(system.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": app_settings.app_name}
