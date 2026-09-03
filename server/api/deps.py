"""FastAPI dependencies for authentication and authorization."""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from server.config import settings
from server.core.auth import TokenService
from server.db.database import get_db
from server.db.models import UserRole, UserStatus
from server.services.user_service import UserDTO, UserService

token_service = TokenService(secret=settings.auth_secret, session_hours=settings.auth_session_hours)


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


def _request_token(request: Request, authorization: str | None) -> str:
    """优先读 Authorization；img/src 等无法带 Header 时回退 query token。"""
    token = _bearer_token(authorization)
    if token:
        return token
    return (request.query_params.get("token") or "").strip()


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> UserDTO:
    token = _request_token(request, authorization)
    session = token_service.validate_token(token)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录状态已失效，请重新登录",
        )
    user = UserService(db).get_by_id(session.user_id)
    if user is None or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录状态已失效，请重新登录",
        )
    return UserService.to_dto(user)


def require_admin(current_user: UserDTO = Depends(get_current_user)) -> UserDTO:
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return current_user


def get_optional_actor(current_user: UserDTO = Depends(get_current_user)) -> str:
    return current_user.display_name


def get_optional_actor(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> str:
    """从 Bearer token 解析用户名，失败时返回 system。"""
    token = _bearer_token(authorization)
    session = token_service.validate_token(token)
    if session is None:
        return "system"
    user = UserService(db).get_by_id(session.user_id)
    if user is None or user.status != UserStatus.ACTIVE:
        return "system"
    return user.username
