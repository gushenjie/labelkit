"""Project material readiness policy shared by versioning and task entrypoints."""

from __future__ import annotations

from dataclasses import dataclass

from server.repositories.material_repository import MaterialBlockerDTO, MaterialRepository


@dataclass(frozen=True)
class MaterialReadinessDTO:
    ready: bool
    blockers: tuple[MaterialBlockerDTO, ...]


class MaterialReadinessError(RuntimeError):
    def __init__(self, blockers: tuple[MaterialBlockerDTO, ...]):
        super().__init__("仍有素材批次未准备完成")
        self.blockers = blockers


class MaterialReadinessService:
    def __init__(self, repository: MaterialRepository):
        self._repository = repository

    def inspect(self, project_id: str) -> MaterialReadinessDTO:
        blockers = self._repository.blockers(project_id)
        return MaterialReadinessDTO(ready=not blockers, blockers=blockers)

    def assert_current_pool_ready(self, project_id: str) -> None:
        result = self.inspect(project_id)
        if not result.ready:
            raise MaterialReadinessError(result.blockers)


def readiness_error_detail(error: MaterialReadinessError) -> dict:
    return {
        "message": str(error),
        "blockers": [
            {
                "batch_id": item.batch_id,
                "title": item.title,
                "status": item.status,
                "next_action": item.next_action,
            }
            for item in error.blockers
        ],
    }
