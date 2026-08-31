from __future__ import annotations

from unittest.mock import patch

import pytest

from server.core.public_dataset_archive import ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS, validate_public_https


def test_validate_public_https_skips_ip_check_for_trusted_roboflow_cdn():
    with patch("server.core.public_dataset_archive.socket.getaddrinfo") as getaddrinfo:
        getaddrinfo.side_effect = AssertionError("trusted provider should not resolve IP")
        validate_public_https(
            "https://source.roboflow.com/dataset.zip",
            trusted_hosts=ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS,
        )


def test_validate_public_https_rejects_fake_ip_for_untrusted_host():
    with patch(
        "server.core.public_dataset_archive.socket.getaddrinfo",
        return_value=[(2, 1, 6, "", ("198.18.0.71", 443))],
    ):
        with pytest.raises(RuntimeError, match="fake-ip"):
            validate_public_https("https://example.com/file.zip")


def test_validate_public_https_rejects_unlisted_provider_host():
    with pytest.raises(RuntimeError, match="不在允许列表"):
        validate_public_https(
            "https://evil.example/file.zip",
            trusted_hosts=ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS,
        )


def test_stream_download_retries_on_truncated_response(tmp_path, monkeypatch):
    calls = {"count": 0}

    class FakeResponse:
        def __init__(self, body: bytes, *, content_length: int | None = None, status: int = 200) -> None:
            self._body = body
            self._content_length = content_length if content_length is not None else len(body)
            self.status = status

        def geturl(self) -> str:
            return "https://app.roboflow.com/dataset.zip"

        def getcode(self) -> int:
            return self.status

        @property
        def headers(self) -> dict[str, str]:
            if self.status == 206:
                start = 7
                end = start + len(self._body) - 1
                total = end + 1
                return {
                    "Content-Length": str(len(self._body)),
                    "Content-Range": f"bytes {start}-{end}/{total}",
                }
            return {"Content-Length": str(self._content_length)}

        def read(self, size: int = -1) -> bytes:
            if size < 0:
                chunk, self._body = self._body, b""
                return chunk
            chunk, self._body = self._body[:size], self._body[size:]
            return chunk

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_open(request, timeout=None):
        calls["count"] += 1
        if calls["count"] == 1:
            return FakeResponse(b"partial", content_length=107)
        range_header = request.headers.get("Range", "")
        if range_header == "bytes=7-":
            return FakeResponse(b"-bytes", status=206)
        return FakeResponse(b"complete-bytes")

    monkeypatch.setattr("server.core.public_dataset_archive.validate_public_https", lambda *args, **kwargs: None)
    monkeypatch.setattr("server.core.public_dataset_archive.ensure_disk_space", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "server.core.public_dataset_archive.urllib.request.build_opener",
        lambda *args, **kwargs: type("Opener", (), {"open": staticmethod(fake_open)})(),
    )

    from server.core.public_dataset_archive import stream_download

    destination = tmp_path / "dataset.zip"
    written, checksum = stream_download("https://app.roboflow.com/dataset.zip", destination, max_attempts=2)
    assert calls["count"] == 2
    assert written == len(b"partial" + b"-bytes")
    assert destination.exists()
