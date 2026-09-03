"""审计日志写入工具。"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from server.db.models import AuditLog

logger = logging.getLogger(__name__)


def record_audit(
    db: Session,
    *,
    actor: str,
    action: str,
    resource_type: str,
    summary: str,
    resource_id: str | None = None,
    project_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    """写入一条审计事件，失败时不阻断主业务。"""
    try:
        db.add(
            AuditLog(
                actor=actor or "system",
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                project_id=project_id,
                summary=summary,
                metadata_json=metadata or {},
                ip=ip,
            )
        )
        db.commit()
    except Exception:
        logger.exception("审计日志写入失败 | action=%s | summary=%s", action, summary)
        db.rollback()
