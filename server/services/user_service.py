"""用户账号管理服务。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import bcrypt
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from server.db.models import User, UserRole, UserStatus


@dataclass(frozen=True)
class UserDTO:
    id: str
    username: str
    display_name: str
    role: UserRole
    status: UserStatus
    created_at: datetime
    last_login_at: datetime | None


@dataclass(frozen=True)
class UserListSummaryDTO:
    total: int
    active: int
    admins: int


@dataclass(frozen=True)
class UserListDTO:
    summary: UserListSummaryDTO
    items: list[UserDTO]


class UserService:
    def __init__(self, db: Session) -> None:
        self._db = db

    @staticmethod
    def hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        try:
            return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
        except ValueError:
            return False

    @staticmethod
    def to_dto(user: User) -> UserDTO:
        return UserDTO(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role,
            status=user.status,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )

    def get_by_id(self, user_id: str) -> User | None:
        return self._db.get(User, user_id)

    def get_by_username(self, username: str) -> User | None:
        return self._db.query(User).filter(User.username == username).first()

    def authenticate(self, username: str, password: str) -> User | None:
        user = self.get_by_username(username.strip())
        if user is None:
            return None
        if user.status != UserStatus.ACTIVE:
            return None
        if not self.verify_password(password, user.password_hash):
            return None
        user.last_login_at = datetime.now(timezone.utc)
        self._db.commit()
        self._db.refresh(user)
        return user

    def bootstrap_admin(self, username: str, password: str, display_name: str = "管理员") -> User | None:
        if self._db.query(User).count() > 0:
            return None
        user = User(
            username=username,
            display_name=display_name,
            password_hash=self.hash_password(password),
            role=UserRole.ADMIN,
            status=UserStatus.ACTIVE,
        )
        self._db.add(user)
        self._db.commit()
        self._db.refresh(user)
        return user

    def list_users(
        self,
        *,
        status: UserStatus | None = None,
        role: UserRole | None = None,
        query: str | None = None,
    ) -> UserListDTO:
        base_query = self._db.query(User)
        if status is not None:
            base_query = base_query.filter(User.status == status)
        if role is not None:
            base_query = base_query.filter(User.role == role)
        if query:
            keyword = f"%{query.strip()}%"
            base_query = base_query.filter(
                or_(User.username.ilike(keyword), User.display_name.ilike(keyword))
            )

        users = base_query.order_by(User.created_at.asc()).all()
        summary = UserListSummaryDTO(
            total=self._db.query(func.count(User.id)).scalar() or 0,
            active=self._db.query(func.count(User.id)).filter(User.status == UserStatus.ACTIVE).scalar() or 0,
            admins=self._db.query(func.count(User.id)).filter(User.role == UserRole.ADMIN).scalar() or 0,
        )
        return UserListDTO(summary=summary, items=[self.to_dto(user) for user in users])

    def count_active_annotators(self) -> int:
        return (
            self._db.query(func.count(User.id))
            .filter(
                User.status == UserStatus.ACTIVE,
                User.role.in_([UserRole.ANNOTATOR, UserRole.REVIEWER]),
            )
            .scalar()
            or 0
        )

    def create_user(
        self,
        *,
        username: str,
        display_name: str,
        password: str,
        role: UserRole,
    ) -> User:
        normalized_username = username.strip()
        if self.get_by_username(normalized_username):
            raise ValueError("登录名已存在")
        user = User(
            username=normalized_username,
            display_name=display_name.strip(),
            password_hash=self.hash_password(password),
            role=role,
            status=UserStatus.ACTIVE,
        )
        self._db.add(user)
        self._db.commit()
        self._db.refresh(user)
        return user

    def update_user(
        self,
        user: User,
        *,
        display_name: str | None = None,
        password: str | None = None,
        role: UserRole | None = None,
        status: UserStatus | None = None,
    ) -> User:
        if display_name is not None:
            user.display_name = display_name.strip()
        if password:
            user.password_hash = self.hash_password(password)
        if role is not None:
            if user.role == UserRole.ADMIN and role != UserRole.ADMIN:
                self._ensure_not_last_admin(user)
            user.role = role
        if status is not None:
            if user.role == UserRole.ADMIN and status == UserStatus.DISABLED:
                self._ensure_not_last_admin(user)
            user.status = status
        self._db.commit()
        self._db.refresh(user)
        return user

    def delete_user(self, user: User) -> None:
        if user.role == UserRole.ADMIN:
            self._ensure_not_last_admin(user)
        self._db.delete(user)
        self._db.commit()

    def _ensure_not_last_admin(self, user: User) -> None:
        if user.role != UserRole.ADMIN:
            return
        admin_count = (
            self._db.query(func.count(User.id))
            .filter(User.role == UserRole.ADMIN, User.status == UserStatus.ACTIVE)
            .scalar()
            or 0
        )
        if admin_count <= 1:
            raise ValueError("不能移除或禁用最后一个管理员")
