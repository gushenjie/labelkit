from fastapi.testclient import TestClient

from server.config import settings
from server.main import app


client = TestClient(app)


def _login_headers() -> dict[str, str]:
    response = client.post(
        "/api/auth/login",
        json={"username": settings.login_username, "password": settings.login_password},
    )
    assert response.status_code == 200
    token = response.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_default_account_can_login_and_validate_session():
    response = client.post(
        "/api/auth/login",
        json={"username": settings.login_username, "password": settings.login_password},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["username"] == settings.login_username
    assert payload["display_name"]
    assert payload["role"] == "admin"
    assert payload["token"]

    session_response = client.get(
        "/api/auth/session",
        headers={"Authorization": f"Bearer {payload['token']}"},
    )
    assert session_response.status_code == 200
    session_payload = session_response.json()
    assert session_payload["username"] == settings.login_username
    assert session_payload["role"] == "admin"
    assert session_payload["token"] is None


def test_invalid_password_is_rejected():
    response = client.post(
        "/api/auth/login",
        json={"username": settings.login_username, "password": "incorrect"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "账号或密码错误"


def test_invalid_session_token_is_rejected():
    response = client.get(
        "/api/auth/session",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401

    malformed_response = client.get(
        "/api/auth/session",
        headers={"Authorization": "Bearer !!!.not-base64"},
    )
    assert malformed_response.status_code == 401


def test_protected_api_requires_login():
    response = client.get("/api/projects")
    assert response.status_code == 401


def test_query_token_can_access_protected_api():
    """img/src 无法带 Authorization，允许用 query token 访问受保护接口。"""
    login = client.post(
        "/api/auth/login",
        json={"username": settings.login_username, "password": settings.login_password},
    )
    assert login.status_code == 200
    token = login.json()["token"]

    response = client.get(f"/api/projects?token={token}")
    assert response.status_code == 200
    assert isinstance(response.json(), list)

    invalid = client.get("/api/projects?token=invalid-token")
    assert invalid.status_code == 401
