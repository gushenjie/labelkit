"""Stateless local authentication tokens for workspace users."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from server.db.models import UserRole


@dataclass(frozen=True)
class AuthSessionDTO:
    user_id: str
    username: str
    display_name: str
    role: UserRole
    expires_at: int
    token: str


class TokenService:
    def __init__(self, secret: str, session_hours: int = 12) -> None:
        self._secret = secret.encode("utf-8")
        self._session_seconds = max(session_hours, 1) * 60 * 60

    def issue_session(
        self,
        *,
        user_id: str,
        username: str,
        display_name: str,
        role: UserRole,
    ) -> AuthSessionDTO:
        expires_at = int(time.time()) + self._session_seconds
        payload = json.dumps(
            {
                "sub": username,
                "uid": user_id,
                "role": role.value,
                "exp": expires_at,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        encoded_payload = self._encode(payload)
        token = f"{encoded_payload}.{self._sign(encoded_payload)}"
        return AuthSessionDTO(
            user_id=user_id,
            username=username,
            display_name=display_name,
            role=role,
            expires_at=expires_at,
            token=token,
        )

    def validate_token(self, token: str) -> AuthSessionDTO | None:
        try:
            encoded_payload, encoded_signature = token.split(".", 1)
            expected_signature = self._sign(encoded_payload)
            if not hmac.compare_digest(encoded_signature, expected_signature):
                return None
            payload = json.loads(self._decode(encoded_payload))
            username = str(payload["sub"])
            user_id = str(payload["uid"])
            role = UserRole(str(payload["role"]))
            expires_at = int(payload["exp"])
        except (binascii.Error, KeyError, TypeError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None
        if expires_at <= int(time.time()):
            return None
        return AuthSessionDTO(
            user_id=user_id,
            username=username,
            display_name=username,
            role=role,
            expires_at=expires_at,
            token=token,
        )

    def _sign(self, payload: str) -> str:
        signature = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
        return self._encode(signature)

    @staticmethod
    def _encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

    @staticmethod
    def _decode(value: str) -> str:
        padding = "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(value + padding).decode("utf-8")
