"""Provider adapters for public dataset discovery and downloads."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

from server.config import settings
from server.core.public_dataset_archive import (
    DOWNLOAD_MAX_ATTEMPTS,
    ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS,
    clear_download_meta,
    ensure_disk_space,
    is_download_retryable,
    read_download_meta,
    sha256_file,
    stream_download,
)
from server.core.public_dataset_types import PublicDatasetCandidateDTO, PublicImportDTO


PERMISSIVE_LICENSES = {
    "cc0-1.0",
    "cc0",
    "cc-by-4.0",
    "cc by 4.0",
    "mit",
    "apache-2.0",
    "apache 2.0",
    "bsd-2-clause",
    "bsd-3-clause",
}

# Deterministic Chinese → English hints for public dataset search (Roboflow/Kaggle).
ZH_SEARCH_TERMS = {
    "鸟窝": "bird nest",
    "鸟巢": "bird nest",
    "鸟类": "bird",
    "鸟": "bird",
    "烟雾": "smoke",
    "烟火": "smoke fire",
    "火焰": "fire flame",
    "火苗": "fire flame",
    "火灾": "fire",
    "安全帽": "hard hat helmet",
    "反光衣": "reflective vest",
    "入侵": "intrusion person",
    "跌倒": "fall detection",
    "抽烟": "smoking",
    "睡岗": "sleeping on duty",
    "线路": "power line",
    "拉线": "guy wire",
    "绝缘子": "insulator",
    "马路": "road street",
    "道路": "road",
    "检测": "detection",
    "识别": "detection",
}


def _has_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)


def localize_search_query(text: str) -> str:
    """Replace known Chinese CV terms with English search keywords."""
    result = text.strip()
    if not result:
        return result
    for zh, en in sorted(ZH_SEARCH_TERMS.items(), key=lambda item: len(item[0]), reverse=True):
        if zh in result:
            result = result.replace(zh, f" {en} ")
    result = re.sub(r"\s+", " ", result).strip()
    if _has_cjk(result):
        # Drop residual CJK so Universe/Kaggle keyword search stays English-first.
        ascii_parts = re.findall(r"[A-Za-z0-9_+\-:>]+", result)
        if ascii_parts:
            return " ".join(ascii_parts)
    return result


SEMANTIC_ALIASES: tuple[frozenset[str], ...] = (
    frozenset({"bird nest", "birdnest", "nest", "nid", "鸟窝", "鸟巢", "feszek", "bird"}),
    frozenset({"smoke", "烟雾", "smog", "fume"}),
    frozenset({"fire", "火灾", "flame", "烟火", "火焰", "火苗"}),
    frozenset({"hard hat", "helmet", "safety helmet", "安全帽"}),
    frozenset({"reflective vest", "safety vest", "反光衣", "vest"}),
    frozenset({"person", "people", "human", "行人", "人员"}),
)


def _tokenize(text: str) -> set[str]:
    normalized = re.sub(r"[_\-/]+", " ", (text or "").lower())
    parts = re.findall(r"[a-z0-9\u4e00-\u9fff]+", normalized)
    tokens = set(parts)
    # Keep multi-word phrases that appear as contiguous text for alias matching.
    compact = normalized.replace(" ", "")
    if compact:
        tokens.add(compact)
    joined = " ".join(parts)
    if joined:
        tokens.add(joined)
    return tokens


def _expand_aliases(tokens: set[str]) -> set[str]:
    expanded = set(tokens)
    for group in SEMANTIC_ALIASES:
        if tokens & group:
            expanded |= set(group)
    return expanded


def _image_count_score(image_count: int | None) -> float:
    if not image_count or image_count <= 0:
        return 0.0
    # Prefer workable demo sizes; very tiny and huge noisy sets score lower.
    if image_count < 50:
        return 0.15
    if image_count < 200:
        return 0.45
    if image_count <= 5000:
        return 0.85 + min(0.15, math.log10(image_count) / 20)
    if image_count <= 20000:
        return 0.7
    return 0.45


def _license_score(license_name: str) -> float:
    value = (license_name or "").strip().lower()
    if value in PERMISSIVE_LICENSES or value in {"cc by 4.0", "cc-by-4.0", "cc0", "cc0-1.0", "mit"}:
        return 1.0
    if "cc by" in value or value.startswith("cc-by"):
        return 0.85
    if value in {"", "unknown", "none"}:
        return 0.2
    return 0.35


def score_public_candidate(
    candidate: PublicDatasetCandidateDTO,
    *,
    query: str,
    category_names: list[str],
    task_type: str | None = None,
) -> tuple[float, str]:
    """Heuristic recommendation score in [0, 1] plus a short reason."""
    query_tokens = _expand_aliases(_tokenize(query) | _tokenize(" ".join(category_names)))
    title_tokens = _expand_aliases(_tokenize(candidate.title) | _tokenize(candidate.description))
    class_tokens = _expand_aliases({token for name in candidate.classes for token in _tokenize(name)})

    class_overlap = len(query_tokens & class_tokens) / max(len(query_tokens), 1)
    title_overlap = len(query_tokens & title_tokens) / max(len(query_tokens), 1)
    relevance = max(class_overlap, title_overlap)
    focused = 1.0 if 1 <= len(candidate.classes) <= 5 else (0.55 if len(candidate.classes) <= 15 else 0.25)
    task_match = 1.0 if task_type and candidate.task_type == task_type else (0.7 if not task_type else 0.2)
    image_score = _image_count_score(candidate.image_count)
    license_score = _license_score(candidate.license_name)
    popularity = 0.0
    if candidate.downloads:
        popularity += min(0.6, math.log10(max(candidate.downloads, 1)) / 5)
    if candidate.stars:
        popularity += min(0.4, math.log10(max(candidate.stars, 1) + 1) / 4)

    score = (
        0.34 * min(1.0, class_overlap * 2.2)
        + 0.18 * min(1.0, title_overlap * 2.0)
        + 0.16 * image_score
        + 0.12 * license_score
        + 0.10 * task_match
        + 0.05 * focused
        + 0.05 * min(1.0, popularity)
    )
    score = max(0.0, min(1.0, score))
    if relevance <= 0:
        score *= 0.2
    elif relevance < 0.08:
        score *= 0.45

    reasons: list[str] = []
    if class_overlap > 0:
        reasons.append("类别匹配")
    if title_overlap > 0.15:
        reasons.append("标题相关")
    if candidate.image_count and 200 <= candidate.image_count <= 10000:
        reasons.append("样本量合适")
    elif candidate.image_count and candidate.image_count >= 50:
        reasons.append("有标注样本")
    if license_score >= 0.8:
        reasons.append("许可友好")
    if task_match >= 1.0:
        reasons.append("任务类型一致")
    if not reasons:
        reasons.append("综合匹配")
    return score, " · ".join(reasons[:3])


def rank_public_candidates(
    candidates: list[PublicDatasetCandidateDTO],
    *,
    query: str,
    category_names: list[str],
    task_type: str | None = None,
) -> list[PublicDatasetCandidateDTO]:
    ranked: list[PublicDatasetCandidateDTO] = []
    for candidate in candidates:
        score, reason = score_public_candidate(
            candidate,
            query=query,
            category_names=category_names,
            task_type=task_type,
        )
        ranked.append(replace(candidate, score=score, recommendation_reason=reason))
    ranked.sort(key=lambda item: (item.score, item.image_count or 0), reverse=True)
    if ranked:
        top = ranked[0]
        ranked[0] = replace(
            top,
            recommendation_reason=(f"最推荐 · {top.recommendation_reason}" if top.recommendation_reason else "最推荐"),
        )
    return ranked


def _is_untranslated_cjk(text: str) -> bool:
    cleaned = text.strip()
    return bool(cleaned) and _has_cjk(cleaned) and not re.search(r"[A-Za-z]", cleaned)


def expand_search_query(query: str, category_names: list[str]) -> str:
    """Translate/expand a search phrase when configured; fail back deterministically.

    User query is primary. Project category names are optional hints only and must not
    override a clearly different search intent (e.g. searching smoke inside a nest project).
    """
    primary = localize_search_query(query.strip())
    category_hint = localize_search_query(" ".join(dict.fromkeys(category_names)).strip())
    if _is_untranslated_cjk(primary) and category_hint and not _is_untranslated_cjk(category_hint):
        fallback = category_hint
    else:
        fallback = primary or category_hint
    api_key = settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        return fallback
    try:
        from openai import OpenAI

        # Text expansion should not depend on the vision model used for labeling.
        text_model = os.environ.get("LABELKIT_TEXT_MODEL", "qwen-plus")
        response = OpenAI(api_key=api_key, base_url=settings.vlm_base_url, timeout=15).chat.completions.create(
            model=text_model,
            temperature=0,
            max_tokens=100,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Convert the request into one concise English computer-vision dataset search query "
                        "for Roboflow/Kaggle. ASCII English only. Prefer concrete object names "
                        "(e.g. bird nest, smoke, hard hat). The request topic is authoritative; "
                        "project_classes are optional hints and must be ignored when unrelated. "
                        "Return plain text only; never decide licensing."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"request": query, "project_classes": category_names},
                        ensure_ascii=False,
                    ),
                },
            ],
        )
        expanded = (response.choices[0].message.content or "").strip().strip('"')
        expanded = localize_search_query(expanded[:300]) if expanded else ""
        return expanded or fallback
    except Exception:
        return fallback


def suggest_mapping_with_llm(
    source_classes: tuple[dict, ...], target_categories: tuple[dict, ...]
) -> dict[str, int | None] | None:
    api_key = settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        return None
    try:
        from openai import OpenAI

        response = OpenAI(api_key=api_key, base_url=settings.vlm_base_url, timeout=15).chat.completions.create(
            model=settings.vlm_model,
            temperature=0,
            response_format={"type": "json_object"},
            max_tokens=500,
            messages=[
                {
                    "role": "system",
                    "content": "Return a JSON object mapping every source class_id string to an existing target class_id integer or null. Use semantic aliases; do not create classes.",
                },
                {"role": "user", "content": json.dumps({"source": source_classes, "targets": target_categories}, ensure_ascii=False)},
            ],
        )
        raw = json.loads(response.choices[0].message.content or "{}")
        source_ids = {str(item["class_id"]) for item in source_classes}
        target_ids = {int(item["class_id"]) for item in target_categories}
        if set(raw) != source_ids:
            return None
        result = {key: (None if value is None else int(value)) for key, value in raw.items()}
        if any(value is not None and value not in target_ids for value in result.values()):
            return None
        return result
    except Exception:
        return None


def license_fingerprint(provider: str, source_ref: str, version: str, name: str, url: str) -> str:
    value = json.dumps(
        [provider, source_ref, version, name.strip().lower(), url.strip()],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def requires_manual_license_confirmation(name: str) -> bool:
    return name.strip().lower() not in PERMISSIVE_LICENSES


def provider_status() -> list[dict]:
    kaggle_config = Path.home() / ".kaggle" / "kaggle.json"
    kaggle_access_token = Path.home() / ".kaggle" / "access_token"
    roboflow_available = bool(os.environ.get("ROBOFLOW_API_KEY"))
    return [
        {
            "provider": "kaggle",
            "available": bool(
                os.environ.get("KAGGLE_API_TOKEN")
                or (os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"))
                or kaggle_config.is_file()
                or kaggle_access_token.is_file()
            ),
            "discovery": True,
            "url_import": False,
        },
        {
            "provider": "roboflow",
            "available": roboflow_available,
            "discovery": True,
            "url_import": True,
        },
    ]


def _attribute(value, name: str, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _first_attribute(value, *names: str, default=None):
    for name in names:
        result = _attribute(value, name, None)
        if result is not None:
            return result
    return default


def _dataset_version(api, ref: str, dataset) -> str:
    direct = _first_attribute(
        dataset,
        "currentVersionNumber",
        "current_version_number",
        default=None,
    )
    if direct not in {None, ""}:
        return str(direct)
    try:
        payload = json.loads(api.dataset_status(ref, format="json(current_version_number)"))
        version = payload.get("current_version_number")
    except Exception as error:
        raise RuntimeError("Kaggle 未返回可固定的数据集版本") from error
    if version in {None, ""}:
        raise RuntimeError("Kaggle 未返回可固定的数据集版本")
    return str(version)


def _kaggle_api():
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
    except ImportError as error:
        raise RuntimeError("未安装 Kaggle 官方客户端，请安装 server requirements") from error
    api = KaggleApi()
    try:
        api.authenticate()
    except SystemExit as error:
        # Newer kaggle CLI calls exit(1) when credentials are missing.
        raise RuntimeError("Kaggle 凭据不可用；请配置 KAGGLE_API_TOKEN 或官方凭据文件") from error
    except Exception as error:
        raise RuntimeError("Kaggle 凭据不可用；请配置 KAGGLE_API_TOKEN 或官方凭据文件") from error
    return api


def discover_kaggle(query: str, *, limit: int = 12) -> list[PublicDatasetCandidateDTO]:
    api = _kaggle_api()
    try:
        datasets = api.dataset_list(search=query, sort_by="hottest", page=1)
    except Exception as error:
        raise RuntimeError(f"Kaggle 检索失败: {error}") from error
    candidates: list[PublicDatasetCandidateDTO] = []
    for index, dataset in enumerate(list(datasets)[:limit]):
        ref = str(_attribute(dataset, "ref", ""))
        if not ref:
            continue
        title = str(_attribute(dataset, "title", ref))
        license_name = str(_first_attribute(dataset, "licenseName", "license_name", default="unknown") or "unknown")
        size = _first_attribute(dataset, "totalBytes", "total_bytes", "size", default=None)
        try:
            version = _dataset_version(api, ref, dataset)
        except RuntimeError:
            continue
        candidates.append(
            PublicDatasetCandidateDTO(
                provider="kaggle",
                source_ref=ref,
                source_version=version,
                source_url=f"https://www.kaggle.com/datasets/{ref}",
                title=title,
                description=str(_attribute(dataset, "subtitle", "") or ""),
                license_name=license_name,
                license_url=f"https://www.kaggle.com/datasets/{ref}",
                download_bytes=int(size) if size is not None else None,
                image_count=None,
                task_type=None,
                updated_at=str(_first_attribute(dataset, "lastUpdated", "last_updated", default="") or ""),
                score=max(0.0, 1.0 - index / max(limit, 1)),
                requires_manual_license_confirmation=requires_manual_license_confirmation(license_name),
            )
        )
    return candidates


def inspect_kaggle_ref(source_ref: str) -> PublicDatasetCandidateDTO:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source_ref):
        raise RuntimeError("Kaggle 数据集引用必须为 owner/dataset")
    api = _kaggle_api()
    try:
        search_term = source_ref.split("/", 1)[1].replace("-", " ")
        matches = list(api.dataset_list(search=search_term, page=1))
        dataset = next((item for item in matches if str(_attribute(item, "ref", "")) == source_ref), None)
        if dataset is None:
            raise RuntimeError("数据集不在 Kaggle 检索结果中")
    except Exception as error:
        raise RuntimeError(f"Kaggle 元数据读取失败: {type(error).__name__}") from error
    license_name = str(_first_attribute(dataset, "licenseName", "license_name", default="unknown") or "unknown")
    size = _first_attribute(dataset, "totalBytes", "total_bytes", "size", default=None)
    version = _dataset_version(api, source_ref, dataset)
    return PublicDatasetCandidateDTO(
        provider="kaggle",
        source_ref=source_ref,
        source_version=version,
        source_url=f"https://www.kaggle.com/datasets/{source_ref}",
        title=str(_attribute(dataset, "title", source_ref)),
        description=str(_attribute(dataset, "subtitle", "") or ""),
        license_name=license_name,
        license_url=f"https://www.kaggle.com/datasets/{source_ref}",
        download_bytes=int(size) if size is not None else None,
        image_count=None,
        task_type=None,
        updated_at=str(_first_attribute(dataset, "lastUpdated", "last_updated", default="") or ""),
        requires_manual_license_confirmation=requires_manual_license_confirmation(license_name),
    )


ROBOFLOW_URL_RE = re.compile(
    r"^https://(?:universe|app)\.roboflow\.com/([^/?#]+)/([^/?#]+)(?:/(?:dataset/)?(\d+))?/?(?:[?#].*)?$",
    re.IGNORECASE,
)

ROBOFLOW_TASK_FILTER = {
    "detect": "object detection",
    "classify": "classification",
}


def parse_roboflow_url(url: str) -> tuple[str, str, str]:
    match = ROBOFLOW_URL_RE.match(url.strip())
    if not match or not match.group(3):
        raise RuntimeError("Roboflow URL 必须包含 workspace、project 和固定数字版本")
    return match.group(1), match.group(2), match.group(3)


def roboflow_dataset_url(workspace: str, project: str, version: str) -> str:
    """Return the canonical fixed-version Roboflow Universe dataset URL."""
    return f"https://universe.roboflow.com/{workspace}/{project}/dataset/{version}"


def _roboflow_json(path: str) -> dict:
    key = os.environ.get("ROBOFLOW_API_KEY", "")
    if not key:
        raise RuntimeError("未配置 ROBOFLOW_API_KEY")
    separator = "&" if "?" in path else "?"
    url = f"https://api.roboflow.com/{path}{separator}api_key={urllib.parse.quote(key)}"
    request = urllib.request.Request(url, headers={"User-Agent": "LabelKit/0.2"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Roboflow API 请求失败: HTTP {error.code}") from error
    except Exception as error:
        raise RuntimeError(f"Roboflow API 请求失败: {type(error).__name__}") from error


def _roboflow_post_json(path: str, body: dict) -> dict:
    key = os.environ.get("ROBOFLOW_API_KEY", "")
    if not key:
        raise RuntimeError("未配置 ROBOFLOW_API_KEY")
    separator = "&" if "?" in path else "?"
    url = f"https://api.roboflow.com/{path}{separator}api_key={urllib.parse.quote(key)}"
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"User-Agent": "LabelKit/0.2", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Roboflow API 请求失败: HTTP {error.code}") from error
    except Exception as error:
        raise RuntimeError(f"Roboflow API 请求失败: {type(error).__name__}") from error


def _first_http_url(*values) -> str | None:
    for value in values:
        text = str(value or "").strip()
        if text.startswith("http://") or text.startswith("https://"):
            return text
    return None


def _preview_from_payload(section: dict) -> tuple[str | None, str | None]:
    if not isinstance(section, dict):
        return None, None
    thumbnail = _first_http_url(
        section.get("thumbnail"),
        section.get("cover"),
    )
    annotation_thumbnail = _first_http_url(
        section.get("annotationThumbnail"),
        section.get("annotation_thumbnail"),
        section.get("preview"),
        section.get("annotation"),
    )
    return thumbnail, annotation_thumbnail


def _preview_from_image_record(image: dict) -> tuple[str | None, str | None]:
    urls = image.get("urls") if isinstance(image.get("urls"), dict) else {}
    thumbnail = _first_http_url(
        urls.get("thumb"),
        urls.get("thumbnail"),
        urls.get("original"),
        image.get("thumb"),
        image.get("url"),
    )
    annotation_thumbnail = _first_http_url(
        urls.get("annotation"),
        urls.get("annotated"),
        image.get("annotation"),
    )
    return thumbnail, annotation_thumbnail


def _roboflow_sample_preview(workspace: str, project: str) -> tuple[str | None, str | None]:
    """从公开 Universe 项目拉取一张样例图作为预览。"""
    try:
        payload = _roboflow_post_json(
            f"{workspace}/{project}/search",
            {
                "limit": 1,
                "offset": 0,
                "in_dataset": True,
                "fields": ["id", "annotations", "name"],
            },
        )
    except RuntimeError:
        return None, None
    results = payload.get("results") or []
    if not results or not isinstance(results[0], dict):
        return None, None
    first = results[0]
    image_id = str(first.get("id") or "").strip()
    direct_url = _first_http_url(first.get("url"))
    if image_id:
        try:
            detail = _roboflow_json(f"{workspace}/{project}/images/{image_id}")
            thumbnail, annotation_thumbnail = _preview_from_image_record(detail.get("image") or {})
            if thumbnail or annotation_thumbnail:
                return thumbnail, annotation_thumbnail
        except RuntimeError:
            pass
    if direct_url:
        return None, direct_url
    return None, None


def fetch_roboflow_preview(source_ref: str, version: str) -> tuple[str | None, str | None]:
    """补全 Universe 检索结果缺失的缩略图。"""
    if "/" not in source_ref:
        raise RuntimeError("Roboflow 数据集引用必须为 workspace/project")
    workspace, project = source_ref.split("/", 1)
    # A real image that belongs to the dataset is more trustworthy than a
    # project-level cover/icon, which Roboflow may reuse across projects.
    sample_thumbnail, sample_annotation = _roboflow_sample_preview(workspace, project)
    if sample_thumbnail or sample_annotation:
        return sample_thumbnail, sample_annotation
    thumbnail: str | None = None
    annotation_thumbnail: str | None = None
    try:
        detail = _roboflow_json(f"{workspace}/{project}/{version}")
        # Only accept version-scoped metadata here. Project metadata may be a
        # workspace logo or a stale cover unrelated to this fixed version.
        for section in (detail.get("version") or {}, detail):
            section_thumb, section_annot = _preview_from_payload(section)
            thumbnail = thumbnail or section_thumb
            annotation_thumbnail = annotation_thumbnail or section_annot
    except RuntimeError:
        pass
    return thumbnail, annotation_thumbnail


def _roboflow_task_type(raw_type: str) -> str | None:
    return {
        "object-detection": "detect",
        "single-label-classification": "classify",
        "classification": "classify",
    }.get(str(raw_type or ""))


def _fetch_roboflow_version_splits(workspace: str, project: str, version: str) -> dict[str, int] | None:
    try:
        payload = _roboflow_json(f"{workspace}/{project}/{version}")
    except RuntimeError:
        return None
    version_data = payload.get("version") or {}
    raw_splits = version_data.get("splits")
    if not isinstance(raw_splits, dict):
        return None
    splits: dict[str, int] = {}
    for key, value in raw_splits.items():
        if value in {None, ""}:
            continue
        try:
            splits[str(key)] = int(value)
        except (TypeError, ValueError):
            continue
    return splits or None


def roboflow_splits_usable_for_task(splits: dict[str, int], task_type: str | None) -> bool:
    """检测任务至少需要 train + val/test 之一；分类任务只要有图片即可。"""
    if task_type != "detect":
        return True
    train_count = int(splits.get("train") or 0)
    val_count = int(splits.get("valid") or splits.get("val") or 0)
    test_count = int(splits.get("test") or 0)
    if train_count <= 0:
        return False
    return val_count > 0 or test_count > 0


def roboflow_train_only_reason(splits: dict[str, int]) -> str:
    train_count = int(splits.get("train") or 0)
    return f"仅有训练集（{train_count} 张），缺少验证集，不适合检测项目导入"


def discover_roboflow(
    query: str,
    *,
    task_type: str | None = None,
    limit: int = 12,
) -> tuple[list[PublicDatasetCandidateDTO], int]:
    """Search Roboflow Universe by natural language and fix each hit to latestVersion.

    检索阶段不做逐条 version/splits 校验（外网串行会超过前端超时）；
    仅有训练集的数据集在 inspect/fetch 时再拦截。
    """
    if not os.environ.get("ROBOFLOW_API_KEY"):
        raise RuntimeError("未配置 ROBOFLOW_API_KEY")
    cleaned = query.strip()
    if not cleaned:
        return [], 0
    parts = [cleaned]
    task_filter = ROBOFLOW_TASK_FILTER.get(task_type or "")
    if task_filter and task_filter not in cleaned.lower():
        parts.append(task_filter)
    search_q = " ".join(parts)
    payload = _roboflow_json(f"universe/search?q={urllib.parse.quote(search_q)}&page=1")
    results = payload.get("results") or []
    candidates: list[PublicDatasetCandidateDTO] = []
    for item in list(results)[:limit]:
        if not isinstance(item, dict):
            continue
        mapped_type = _roboflow_task_type(str(item.get("type") or ""))
        if mapped_type is None:
            continue
        if task_type in {"detect", "classify"} and mapped_type != task_type:
            continue
        version = item.get("latestVersion")
        if version in {None, ""}:
            continue
        source_url = str(item.get("url") or "").rstrip("/")
        match = ROBOFLOW_URL_RE.match(f"{source_url}/{version}")
        if not match:
            continue
        workspace, project, fixed_version = match.group(1), match.group(2), match.group(3)
        raw_classes = item.get("classes") or []
        if isinstance(raw_classes, dict):
            classes = tuple(str(name) for name in raw_classes.keys())
        else:
            classes = tuple(str(name) for name in raw_classes)
        license_name = str(item.get("license") or "unknown")
        fixed_url = roboflow_dataset_url(workspace, project, str(fixed_version))
        stars = item.get("stars")
        downloads = item.get("downloads")
        views = item.get("views")
        thumbnail = _first_http_url(item.get("thumbnail"), item.get("cover"))
        annotation_thumbnail = _first_http_url(
            item.get("annotationThumbnail"),
            item.get("annotation_thumbnail"),
            item.get("preview"),
        )
        candidates.append(
            PublicDatasetCandidateDTO(
                provider="roboflow",
                source_ref=f"{workspace}/{project}",
                source_version=str(fixed_version),
                source_url=fixed_url,
                title=str(item.get("name") or project),
                description=str(item.get("description") or item.get("annotation") or ""),
                license_name=license_name,
                license_url=fixed_url,
                download_bytes=None,
                image_count=int(item["images"]) if item.get("images") not in {None, ""} else None,
                task_type=mapped_type,
                classes=classes,
                updated_at="",
                score=0.0,
                requires_manual_license_confirmation=requires_manual_license_confirmation(license_name),
                stars=int(stars) if stars not in {None, ""} else None,
                downloads=int(downloads) if downloads not in {None, ""} else None,
                views=int(views) if views not in {None, ""} else None,
                thumbnail=thumbnail,
                annotation_thumbnail=annotation_thumbnail,
            )
        )
    return candidates, 0


def inspect_roboflow_url(url: str, *, task_type: str | None = None) -> PublicDatasetCandidateDTO:
    workspace, project, version = parse_roboflow_url(url)
    fixed_url = roboflow_dataset_url(workspace, project, version)
    payload = _roboflow_json(f"{workspace}/{project}/{version}")
    project_data = payload.get("project") or {}
    version_data = payload.get("version") or {}
    mapped_task_type = _roboflow_task_type(str(project_data.get("type") or ""))
    if mapped_task_type is None:
        raise RuntimeError(f"暂不支持 Roboflow 任务类型: {project_data.get('type') or 'unknown'}")
    splits = _fetch_roboflow_version_splits(workspace, project, version)
    effective_task_type = task_type or mapped_task_type
    if splits is not None and effective_task_type == "detect" and not roboflow_splits_usable_for_task(splits, effective_task_type):
        raise RuntimeError(roboflow_train_only_reason(splits))
    raw_classes = version_data.get("classes") or project_data.get("classes") or []
    classes = tuple(raw_classes if isinstance(raw_classes, list) else raw_classes.keys())
    license_name = str(project_data.get("license") or "unknown")
    return PublicDatasetCandidateDTO(
        provider="roboflow",
        source_ref=f"{workspace}/{project}",
        source_version=version,
        source_url=fixed_url,
        title=str(project_data.get("name") or project),
        description=str(project_data.get("annotation") or ""),
        license_name=license_name,
        license_url=fixed_url,
        download_bytes=None,
        image_count=int(version_data.get("images") or project_data.get("images") or 0) or None,
        task_type=mapped_task_type,
        classes=classes,
        requires_manual_license_confirmation=requires_manual_license_confirmation(license_name),
    )


def download_kaggle(
    import_record: PublicImportDTO,
    download_dir: Path,
    *,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> tuple[list[Path], int, str]:
    if cancelled and cancelled():
        raise RuntimeError("任务已取消")
    download_dir.mkdir(parents=True, exist_ok=True)
    ensure_disk_space(download_dir, import_record.expected_download_bytes or 0)
    fixed_ref = f"{import_record.source_ref}/{import_record.source_version}"
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "kaggle",
            "datasets",
            "download",
            fixed_ref,
            "-p",
            str(download_dir),
            "-q",
            "-o",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
    )
    try:
        while process.poll() is None:
            if cancelled and cancelled():
                _terminate_process_tree(process.pid)
                raise RuntimeError("任务已取消")
            ensure_disk_space(download_dir)
            written = sum(path.stat().st_size for path in download_dir.rglob("*") if path.is_file())
            if progress:
                progress(written, import_record.expected_download_bytes)
            time.sleep(0.25)
        if process.returncode != 0:
            raise RuntimeError(f"Kaggle 下载失败: CLI exit {process.returncode}")
    except Exception:
        if process.poll() is None:
            _terminate_process_tree(process.pid)
        raise
    archives = sorted(path for path in download_dir.iterdir() if path.is_file() and not path.name.endswith(".part"))
    if not archives:
        raise RuntimeError("Kaggle 未返回可下载文件")
    total = sum(path.stat().st_size for path in archives)
    digest = hashlib.sha256()
    for path in archives:
        digest.update(path.name.encode("utf-8"))
        digest.update(sha256_file(path).encode("ascii"))
    return archives, total, digest.hexdigest()


def _terminate_process_tree(pid: int) -> None:
    import psutil

    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    processes = parent.children(recursive=True)
    processes.append(parent)
    for process in processes:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(processes, timeout=3)
    for process in alive:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass


def download_roboflow(
    import_record: PublicImportDTO,
    download_dir: Path,
    *,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> tuple[list[Path], int, str]:
    workspace, project = import_record.source_ref.split("/", 1)
    format_name = "yolov5pytorch" if import_record.workflow_metadata.get("task_type") != "classify" else "folder"
    archive = download_dir / "roboflow-dataset.zip"
    partial = archive.with_suffix(archive.suffix + ".part")
    if archive.is_file() and archive.stat().st_size > 0:
        written = archive.stat().st_size
        checksum = sha256_file(archive)
        return [archive], written, checksum
    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_MAX_ATTEMPTS + 1):
        if cancelled and cancelled():
            raise RuntimeError("任务已取消")
        link = ""
        if partial.is_file() and partial.stat().st_size > 0:
            meta = read_download_meta(partial)
            link = str(meta.get("url") or "").strip()
        if not link:
            payload = _roboflow_json(f"{workspace}/{project}/{import_record.source_version}/{format_name}")
            link = ((payload.get("export") or {}).get("link") or "").strip()
            if not link:
                raise RuntimeError("Roboflow 未返回导出下载地址")
        try:
            written, checksum = stream_download(
                link,
                archive,
                trusted_hosts=ROBOFLOW_DOWNLOAD_TRUSTED_HOSTS,
                cancelled=cancelled,
                progress=progress,
                max_attempts=1,
            )
            return [archive], written, checksum
        except Exception as error:
            last_error = error
            if not is_download_retryable(error):
                break
            if attempt >= DOWNLOAD_MAX_ATTEMPTS:
                break
            if partial.is_file() and partial.stat().st_size <= 0:
                partial.unlink(missing_ok=True)
                clear_download_meta(partial)
            time.sleep(min(2**attempt, 10))
    if last_error:
        raise last_error
    raise RuntimeError("Roboflow 下载失败")


def download_public_import(
    import_record: PublicImportDTO,
    download_dir: Path,
    *,
    cancelled: Callable[[], bool] | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> tuple[list[Path], int, str]:
    if import_record.provider == "kaggle":
        return download_kaggle(
            import_record,
            download_dir,
            cancelled=cancelled,
            progress=progress,
        )
    if import_record.provider == "roboflow":
        return download_roboflow(
            import_record, download_dir, cancelled=cancelled, progress=progress
        )
    raise RuntimeError(f"不支持的公开数据源: {import_record.provider}")
