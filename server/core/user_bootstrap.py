"""工作区用户种子数据初始化。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from server.config import settings
from server.services.user_service import UserService


def bootstrap_workspace_users(db: Session) -> None:
    UserService(db).bootstrap_admin(
        username=settings.login_username,
        password=settings.login_password,
        display_name="管理员",
    )
