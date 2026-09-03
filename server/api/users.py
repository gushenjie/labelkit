"""Workspace member management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from server.api.deps import get_current_user, require_admin
from server.api.schemas import UserCreate, UserListOut, UserOut, UserUpdate
from server.db.database import get_db
from server.db.models import UserRole, UserStatus
from server.services.user_service import UserDTO, UserService

router = APIRouter(prefix="/api/users", tags=["users"])


def _user_out(user: UserDTO) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        status=user.status,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.get("", response_model=UserListOut)
def list_users(
    status_filter: UserStatus | None = Query(default=None, alias="status"),
    role: UserRole | None = Query(default=None),
    q: str | None = Query(default=None),
    _admin: UserDTO = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserListOut:
    result = UserService(db).list_users(status=status_filter, role=role, query=q)
    return UserListOut(
        summary={
            "total": result.summary.total,
            "active": result.summary.active,
            "admins": result.summary.admins,
        },
        items=[_user_out(item) for item in result.items],
    )


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    _admin: UserDTO = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserOut:
    service = UserService(db)
    try:
        user = service.create_user(
            username=body.username,
            display_name=body.display_name,
            password=body.password,
            role=body.role,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    return _user_out(UserService.to_dto(user))


@router.get("/{user_id}", response_model=UserOut)
def get_user(
    user_id: str,
    current_user: UserDTO = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserOut:
    if current_user.role != UserRole.ADMIN and current_user.id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权查看该成员")
    user = UserService(db).get_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="成员不存在")
    return _user_out(UserService.to_dto(user))


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    body: UserUpdate,
    current_user: UserDTO = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserOut:
    service = UserService(db)
    user = service.get_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="成员不存在")

    is_self = current_user.id == user_id
    is_admin = current_user.role == UserRole.ADMIN
    if not is_admin and not is_self:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权修改该成员")

    if not is_admin and any(value is not None for value in (body.role, body.status)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可修改角色或状态")

    try:
        updated = service.update_user(
            user,
            display_name=body.display_name,
            password=body.password,
            role=body.role if is_admin else None,
            status=body.status if is_admin else None,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    return _user_out(UserService.to_dto(updated))


@router.delete("/{user_id}")
def delete_user(
    user_id: str,
    _admin: UserDTO = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    service = UserService(db)
    user = service.get_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="成员不存在")
    try:
        service.delete_user(user)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    return {"ok": True}
