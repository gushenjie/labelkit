from fastapi.testclient import TestClient

from server.config import settings
from server.main import app


client = TestClient(app)


def _login_headers(username: str = settings.login_username, password: str = settings.login_password) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


def test_admin_can_create_list_and_disable_member():
    headers = _login_headers()
    suffix = "annotator01"

    create_response = client.post(
        "/api/users",
        headers=headers,
        json={
            "username": f"test_{suffix}",
            "display_name": "测试标注员",
            "password": "test-pass-123",
            "role": "annotator",
        },
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["username"] == f"test_{suffix}"
    assert created["role"] == "annotator"

    list_response = client.get("/api/users", headers=headers)
    assert list_response.status_code == 200
    payload = list_response.json()
    assert payload["summary"]["total"] >= 2
    assert any(item["id"] == created["id"] for item in payload["items"])

    disable_response = client.patch(
        f"/api/users/{created['id']}",
        headers=headers,
        json={"status": "disabled"},
    )
    assert disable_response.status_code == 200
    assert disable_response.json()["status"] == "disabled"

    login_disabled = client.post(
        "/api/auth/login",
        json={"username": f"test_{suffix}", "password": "test-pass-123"},
    )
    assert login_disabled.status_code == 403

    delete_response = client.delete(f"/api/users/{created['id']}", headers=headers)
    assert delete_response.status_code == 200


def test_cannot_remove_last_admin():
    headers = _login_headers()
    users = client.get("/api/users", headers=headers).json()["items"]
    admin = next(item for item in users if item["role"] == "admin")

    downgrade = client.patch(
        f"/api/users/{admin['id']}",
        headers=headers,
        json={"role": "viewer"},
    )
    assert downgrade.status_code == 400
    assert "最后一个管理员" in downgrade.json()["detail"]

    delete_admin = client.delete(f"/api/users/{admin['id']}", headers=headers)
    assert delete_admin.status_code == 400
