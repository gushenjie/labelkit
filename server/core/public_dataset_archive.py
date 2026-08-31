"""Safe archive and download primitives for untrusted public datasets."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import stat
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


MIN_FREE_BYTES = 5 * 1024**3
MAX_ARCHIVE_FILES = 2_000_000
MAX_COMPRESSION_RATIO = 1_000
# Roboflow 导出链接常见 CDN 域名；匹配时仅校验 HTTPS 域名，不预检解析 IP（兼容 Clash fake-ip）
ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS = frozenset(
    {
        "roboflow.com",
        "amazonaws.com",
        "cloudfront.net",
        "googleapis.com",
        "googleusercontent.com",
        "storage.googleapis.com",
    }
)
FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
DOWNLOAD_MAX_ATTEMPTS = 3
DOWNLOAD_CONNECT_TIMEOUT = 30
DOWNLOAD_READ_TIMEOUT = 300
CONTENT_RANGE_TOTAL_RE = re.compile(r"/(\d+)\s*$")


def _download_meta_path(partial: Path) -> Path:
    return partial.with_name(f"{partial.name}.meta.json")


def _read_download_meta(partial: Path) -> dict:
    meta_path = _download_meta_path(partial)
    if not meta_path.is_file():
        return {}
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def read_download_meta(partial: Path) -> dict:
    return _read_download_meta(partial)


def clear_download_meta(partial: Path) -> None:
    _clear_download_meta(partial)


def _write_download_meta(partial: Path, *, url: str, expected: int | None) -> None:
    meta_path = _download_meta_path(partial)
    meta_path.write_text(
        json.dumps({"url": url, "expected": expected}, ensure_ascii=False),
        encoding="utf-8",
    )


def _clear_download_meta(partial: Path) -> None:
    _download_meta_path(partial).unlink(missing_ok=True)


def _parse_content_range_total(content_range: str | None) -> int | None:
    if not content_range:
        return None
    match = CONTENT_RANGE_TOTAL_RE.search(content_range.strip())
    if not match:
        return None
    return int(match.group(1))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_disk_space(path: Path, required_bytes: int = 0) -> None:
    path.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(path).free
    if free < required_bytes + MIN_FREE_BYTES:
        raise RuntimeError(
            f"磁盘空间不足：需要 {required_bytes + MIN_FREE_BYTES} 字节，当前可用 {free} 字节"
        )


def _safe_relative(name: str) -> Path:
    normalized = name.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise RuntimeError(f"归档包含不安全路径: {name}")
    if pure.parts and ":" in pure.parts[0]:
        raise RuntimeError(f"归档包含绝对路径: {name}")
    return Path(*pure.parts)


def inspect_archive(path: Path) -> tuple[int, int]:
    file_count = 0
    total_size = 0
    compressed_size = max(path.stat().st_size, 1)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                _safe_relative(info.filename)
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise RuntimeError(f"归档包含符号链接: {info.filename}")
                if not info.is_dir():
                    file_count += 1
                    total_size += info.file_size
    elif tarfile.is_tarfile(path):
        with tarfile.open(path, "r:*") as archive:
            for member in archive.getmembers():
                _safe_relative(member.name)
                if member.issym() or member.islnk() or member.isdev():
                    raise RuntimeError(f"归档包含不安全链接或设备: {member.name}")
                if member.isfile():
                    file_count += 1
                    total_size += member.size
    else:
        raise RuntimeError(f"不支持或无法识别的归档格式: {path.name}")
    if file_count > MAX_ARCHIVE_FILES:
        raise RuntimeError(f"归档文件数量超过限制: {file_count}")
    if total_size > compressed_size * MAX_COMPRESSION_RATIO:
        raise RuntimeError("归档压缩比异常，已拒绝解压")
    return file_count, total_size


def safe_extract(path: Path, destination: Path) -> tuple[int, int]:
    file_count, total_size = inspect_archive(path)
    ensure_disk_space(destination, total_size)
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                relative = _safe_relative(info.filename)
                target = destination / relative
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
    else:
        with tarfile.open(path, "r:*") as archive:
            for member in archive.getmembers():
                relative = _safe_relative(member.name)
                if not member.isfile():
                    continue
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError(f"无法读取归档成员: {member.name}")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
    return file_count, total_size


def _hostname_matches_trusted(hostname: str, trusted_hosts: set[str] | frozenset[str]) -> bool:
    normalized = hostname.lower().rstrip(".")
    return any(normalized == host or normalized.endswith(f".{host}") for host in trusted_hosts)


def _raise_non_global_ip_error(address: str) -> None:
    ip = ipaddress.ip_address(address)
    if ip in FAKE_IP_NETWORK:
        raise RuntimeError(
            f"下载地址被代理 DNS 解析为 fake-ip（{address}）。"
            "请关闭 Clash/Surge 的 fake-ip 模式，或将 roboflow.com 设为直连后重试"
        )
    raise RuntimeError(f"下载地址解析到非公网 IP: {address}")


def validate_public_https(
    url: str,
    *,
    trusted_hosts: set[str] | frozenset[str] | None = None,
    skip_ip_check: bool = False,
) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("只允许不含凭据的 HTTPS 下载地址")
    hostname = parsed.hostname.lower().rstrip(".")
    if trusted_hosts and not _hostname_matches_trusted(hostname, trusted_hosts):
        raise RuntimeError(f"下载域名不在允许列表: {hostname}")
    if skip_ip_check or (trusted_hosts and _hostname_matches_trusted(hostname, trusted_hosts)):
        return
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise RuntimeError(f"无法解析下载域名: {hostname}") from error
    for address in addresses:
        if not ipaddress.ip_address(address).is_global:
            _raise_non_global_ip_error(address)


def _download_once(
    url: str,
    destination: Path,
    *,
    trusted_hosts: set[str] | frozenset[str] | None = None,
    skip_ip_check: bool = False,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
    resume: bool = True,
) -> tuple[int, str]:
    validate_public_https(url, trusted_hosts=trusted_hosts, skip_ip_check=skip_ip_check)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    resume_from = partial.stat().st_size if resume and partial.is_file() else 0
    if resume_from > 0:
        meta = _read_download_meta(partial)
        if meta.get("url") and meta["url"] != url:
            resume_from = 0
            partial.unlink(missing_ok=True)
            _clear_download_meta(partial)

    class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            validate_public_https(newurl, trusted_hosts=trusted_hosts, skip_ip_check=skip_ip_check)
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    headers = {"User-Agent": "LabelKit/0.2"}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(ValidatingRedirectHandler())
    with opener.open(request, timeout=DOWNLOAD_READ_TIMEOUT) as response:
        final_url = response.geturl()
        validate_public_https(final_url, trusted_hosts=trusted_hosts, skip_ip_check=skip_ip_check)
        status = getattr(response, "status", response.getcode())
        expected_header = int(response.headers.get("Content-Length", "0")) or None
        expected_total = _parse_content_range_total(response.headers.get("Content-Range")) or expected_header
        if status == 200 and resume_from > 0:
            partial.unlink(missing_ok=True)
            _clear_download_meta(partial)
            resume_from = 0
        if expected_total:
            ensure_disk_space(destination.parent, expected_total)
        else:
            ensure_disk_space(destination.parent)
        _write_download_meta(partial, url=final_url, expected=expected_total)
        digest = hashlib.sha256()
        written = resume_from
        if resume_from > 0:
            with partial.open("rb") as existing:
                while chunk := existing.read(1024 * 1024):
                    digest.update(chunk)
        file_mode = "ab" if resume_from > 0 else "xb"
        with partial.open(file_mode) as output:
            while chunk := response.read(1024 * 1024):
                if cancelled and cancelled():
                    raise RuntimeError("任务已取消")
                ensure_disk_space(destination.parent)
                output.write(chunk)
                digest.update(chunk)
                written += len(chunk)
                if progress:
                    progress(written, expected_total)
        if expected_total is not None and written != expected_total:
            raise RuntimeError(f"下载长度不一致: expected={expected_total}, actual={written}")
    os.replace(partial, destination)
    _clear_download_meta(partial)
    return written, digest.hexdigest()


def is_download_retryable(error: Exception) -> bool:
    if isinstance(error, RuntimeError):
        message = str(error)
        if message == "任务已取消":
            return False
        return message.startswith("下载长度不一致")
    return isinstance(error, (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, socket.timeout))


def _download_retryable(error: Exception) -> bool:
    return is_download_retryable(error)


def stream_download(
    url: str,
    destination: Path,
    *,
    trusted_hosts: set[str] | frozenset[str] | None = None,
    skip_ip_check: bool = False,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
    max_attempts: int = DOWNLOAD_MAX_ATTEMPTS,
) -> tuple[int, str]:
    partial = destination.with_suffix(destination.suffix + ".part")
    last_error: Exception | None = None
    attempts = max(1, max_attempts)
    for attempt in range(1, attempts + 1):
        if cancelled and cancelled():
            raise RuntimeError("任务已取消")
        try:
            return _download_once(
                url,
                destination,
                trusted_hosts=trusted_hosts,
                skip_ip_check=skip_ip_check,
                cancelled=cancelled,
                progress=progress,
                resume=True,
            )
        except Exception as error:
            last_error = error
            if str(error) == "任务已取消" or not _download_retryable(error) or attempt >= attempts:
                break
            time.sleep(min(2**attempt, 10))
    if last_error and str(last_error).startswith("下载长度不一致"):
        partial_bytes = partial.stat().st_size if partial.is_file() else 0
        resume_hint = f"已保留 {partial_bytes} 字节断点，" if partial_bytes > 0 else ""
        raise RuntimeError(
            f"{last_error}（已自动重试 {attempts} 次，{resume_hint}可点击续传下载从断点继续）。"
            "通常是网络或代理中断大文件下载，请将 roboflow.com 设为直连后重试"
        ) from last_error
    if last_error:
        raise last_error
    raise RuntimeError("下载失败")
