#!/usr/bin/env python3
"""Helper: export confirmed labels and print gazi-yolo train command."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from labelkit.cli import cmd_export
from labelkit.config import load_config
from labelkit.store import StateStore
from labelkit.tasks.export import run_export


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--config", default="projects/gazi-yolo.yaml")
    args = ap.parse_args()
    config = load_config(args.config)
    store = StateStore(config)
    result = run_export(config, store)
    stats = store.stats()
    print("=== LabelKit Export ===")
    print(result)
    print("\n=== Status ===")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")
    gazi = config.labels_dir.parent
    print("\n=== Next: train in gazi-yolo ===")
    print(f"  cd {gazi}")
    print("  source .venv/bin/activate")
    print("  python tools/train.py --epochs 80 --device cpu")
    print("\nLabels are written in-place to data/labels/ (139 auto_ok frames ready).")
    print("Review remaining needs_human frames:")
    print(f"  labelkit serve -c {args.config}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
