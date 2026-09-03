"""Local workspace authentication endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from server.api.deps import get_current_user, token_service
from server.api.schemas import AuthSessionOut, LoginRequest
from server.config import settings
from server.core.audit import record_audit
from server.db.database import get_db
from server.db.models import UserStatus
from server.services.user_service import UserDTO, UserService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=AuthSessionOut)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> AuthSessionOut:
    service = UserService(db)
    user = service.get_by_username(body.username.strip())
    if user is not None and user.status == UserStatus.DISABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已禁用，请联系管理员",
        )
    authenticated = service.authenticate(body.username.strip(), body.password)
    if authenticated is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号或密码错误",
        )
    session = token_service.issue_session(
        user_id=authenticated.id,
        username=authenticated.username,
        display_name=authenticated.display_name,
        role=authenticated.role,
    )
    record_audit(
        db,
        actor=authenticated.username,
        action="auth.login",
        resource_type="auth",
        summary=f"用户登录：{authenticated.username}",
    )
    return _session_out(session, include_token=True)


@router.get("/session", response_model=AuthSessionOut)
def get_session(current_user: UserDTO = Depends(get_current_user)) -> AuthSessionOut:
    return AuthSessionOut(
        id=current_user.id,
        username=current_user.username,
        display_name=current_user.display_name,
        role=current_user.role.value,
        expires_at=0,
        token=None,
    )


def _session_out(session, *, include_token: bool) -> AuthSessionOut:
    return AuthSessionOut(
        id=session.user_id,
        username=session.username,
        display_name=session.display_name,
        role=session.role.value,
        expires_at=session.expires_at,
        token=session.token if include_token else None,
    )
