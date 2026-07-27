"""Suggestion API."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from server.core.suggest import suggest_frame_count
from server.db.database import get_db

router = APIRouter(prefix="/api/projects/{project_id}/suggest", tags=["suggest"])


@router.get("/frame-count")
def get_frame_count_suggestion(project_id: str, db: Session = Depends(get_db)):
    return suggest_frame_count(db, project_id)
