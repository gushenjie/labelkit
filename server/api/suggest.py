"""Suggestion API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.api.schemas import TrainParamsSuggestOut, TrainParamsSuggestRequest
from server.core.suggest import suggest_frame_count
from server.core.suggest_train_params import suggest_train_params
from server.db.database import get_db

router = APIRouter(prefix="/api/projects/{project_id}/suggest", tags=["suggest"])


@router.get("/frame-count")
def get_frame_count_suggestion(project_id: str, db: Session = Depends(get_db)):
    return suggest_frame_count(db, project_id)


@router.post("/train-params", response_model=TrainParamsSuggestOut)
def post_train_params_suggestion(
    project_id: str,
    body: TrainParamsSuggestRequest | None = None,
    db: Session = Depends(get_db),
):
    request = body or TrainParamsSuggestRequest()
    try:
        result = suggest_train_params(
            db,
            project_id,
            dataset_version_id=request.dataset_version_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return TrainParamsSuggestOut.model_validate(result)
