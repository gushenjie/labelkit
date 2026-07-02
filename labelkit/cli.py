#!/usr/bin/env python3
"""LabelKit CLI entry point."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from labelkit.env_loader import load_env
from labelkit.config import load_config
from labelkit.store import StateStore
from labelkit.tasks.export import run_export
from labelkit.tasks.fix import run_fix
from labelkit.tasks.label import run_label
from labelkit.tasks.review import run_review


def _config_path(value: str) -> Path:
    return Path(value).resolve()


def cmd_label(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    store.sync_frames()
    stats = run_label(
        config, store,
        backend_name=args.backend,
        only=args.only,
        limit=args.limit,
        force=args.force,
    )
    print(f"label done: {stats}")
    return 0


def cmd_review(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    store.sync_frames()
    stats = run_review(config, store, only=args.only, limit=args.limit)
    print(f"review done: {stats}")
    return 0


def cmd_fix(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    store.sync_frames()
    stats = run_fix(
        config, store,
        backend_name=args.backend,
        only=args.only,
        limit=args.limit,
    )
    print(f"fix done: {stats}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    store.sync_frames()
    print("=== label ===")
    print(run_label(config, store, backend_name=args.backend, only=args.only, limit=args.limit))
    print("=== review ===")
    print(run_review(config, store, only=args.only, limit=args.limit))
    print("=== fix ===")
    print(run_fix(config, store, backend_name=args.backend, only=args.only, limit=args.limit))
    print("=== stats ===")
    print(store.stats())
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    store.sync_frames()
    stats = store.stats()
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = StateStore(config)
    out = Path(args.out).resolve() if args.out else None
    result = run_export(config, store, out, include_auto_ok=not args.human_only)
    print(f"export done: {result}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from labelkit.webapp.app import run_server
    run_server(args.config, port=args.port, open_browser=not args.no_browser)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="labelkit", description="LLM-powered YOLO labeling pipeline")
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--config", "-c", required=True, help="Path to labelkit.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    p_label = sub.add_parser("label", parents=[parent], help="Auto-label frames")
    p_label.add_argument("--backend", choices=["vlm", "yolo"], default="vlm")
    p_label.add_argument("--only", default=None)
    p_label.add_argument("--limit", type=int, default=0)
    p_label.add_argument("--force", action="store_true")
    p_label.set_defaults(func=cmd_label)

    p_review = sub.add_parser("review", parents=[parent], help="LLM review labeled frames")
    p_review.add_argument("--only", default=None)
    p_review.add_argument("--limit", type=int, default=0)
    p_review.set_defaults(func=cmd_review)

    p_fix = sub.add_parser("fix", parents=[parent], help="Auto-fix failed frames")
    p_fix.add_argument("--backend", choices=["vlm", "yolo"], default="vlm")
    p_fix.add_argument("--only", default=None)
    p_fix.add_argument("--limit", type=int, default=0)
    p_fix.set_defaults(func=cmd_fix)

    p_run = sub.add_parser("run", parents=[parent], help="Run label → review → fix pipeline")
    p_run.add_argument("--backend", choices=["vlm", "yolo"], default="vlm")
    p_run.add_argument("--only", default=None)
    p_run.add_argument("--limit", type=int, default=0)
    p_run.set_defaults(func=cmd_run)

    p_stats = sub.add_parser("stats", parents=[parent], help="Show frame status counts")
    p_stats.set_defaults(func=cmd_stats)

    p_export = sub.add_parser("export", parents=[parent], help="Export confirmed labels")
    p_export.add_argument("--out", default=None)
    p_export.add_argument("--human-only", action="store_true")
    p_export.set_defaults(func=cmd_export)

    p_serve = sub.add_parser("serve", parents=[parent], help="Start review web UI")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.add_argument("--no-browser", action="store_true")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    loaded = load_env(args.config)
    if loaded:
        print(f"已加载本地配置: {', '.join(loaded)}")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
