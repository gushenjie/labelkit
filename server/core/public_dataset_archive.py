"""Safe archive and download primitives for untrusted public datasets."""

from __future__ import annotations

import hashlib
import ipaddress
import os
import shutil
import socket
import stat
import tarfile
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


MIN_FREE_BYTES = 5 * 1024**3
MAX_ARCHIVE_FILES = 2_000_000
MAX_COMPRESSION_RATIO = 1_000


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


def validate_public_https(url: str, *, trusted_hosts: set[str] | None = None) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("只允许不含凭据的 HTTPS 下载地址")
    hostname = parsed.hostname.lower().rstrip(".")
    if trusted_hosts and not any(hostname == host or hostname.endswith(f".{host}") for host in trusted_hosts):
        raise RuntimeError(f"下载域名不在允许列表: {hostname}")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise RuntimeError(f"无法解析下载域名: {hostname}") from error
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise RuntimeError(f"下载地址解析到非公网 IP: {address}")


def stream_download(
    url: str,
    destination: Path,
    *,
    trusted_hosts: set[str] | None = None,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> tuple[int, str]:
    validate_public_https(url, trusted_hosts=trusted_hosts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            validate_public_https(newurl, trusted_hosts=trusted_hosts)
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    request = urllib.request.Request(url, headers={"User-Agent": "LabelKit/0.2"})
    opener = urllib.request.build_opener(ValidatingRedirectHandler())
    try:
        with opener.open(request, timeout=60) as response:
            final_url = response.geturl()
            validate_public_https(final_url, trusted_hosts=trusted_hosts)
            expected = int(response.headers.get("Content-Length", "0")) or None
            ensure_disk_space(destination.parent, expected or 0)
            digest = hashlib.sha256()
            written = 0
            with partial.open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    if cancelled and cancelled():
                        raise RuntimeError("任务已取消")
                    ensure_disk_space(destination.parent)
                    output.write(chunk)
                    digest.update(chunk)
                    written += len(chunk)
                    if progress:
                        progress(written, expected)
            if expected is not None and written != expected:
                raise RuntimeError(f"下载长度不一致: expected={expected}, actual={written}")
        os.replace(partial, destination)
        return written, digest.hexdigest()
    except Exception:
        partial.unlink(missing_ok=True)
        raise
