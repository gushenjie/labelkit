# LabelKit

LLM-powered YOLO labeling pipeline: **label → review → fix → human spot-check**.

> Dataset grows automatically. Human effort approaches zero.

## Quick Start

```bash
cd labelkit
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
export DASHSCOPE_API_KEY=your_key   # Qwen via DashScope

# Full pipeline on gazi-yolo project
labelkit run -c projects/gazi-yolo.yaml

# Or step by step
labelkit label  -c projects/gazi-yolo.yaml --backend vlm --limit 10
labelkit review -c projects/gazi-yolo.yaml
labelkit fix    -c projects/gazi-yolo.yaml
labelkit stats  -c projects/gazi-yolo.yaml
labelkit serve  -c projects/gazi-yolo.yaml   # http://127.0.0.1:8765
labelkit export -c projects/gazi-yolo.yaml
```

## Architecture

```
CLI (label/review/fix/run)  →  state.json + YOLO txt
Web UI (serve)              →  human spot-check (Y/N)
```

### Frame States

| State | Meaning |
|-------|---------|
| `unlabeled` | Not yet processed |
| `llm_labeled` | Labeled, pending review |
| `auto_ok` | Passed LLM + rule review |
| `auto_fixed` | Fixed and re-approved |
| `needs_human` | Failed review, needs human |
| `human_ok` | Human confirmed (protected) |
| `human_wrong` | Human rejected |

### Backends

- **`vlm`** — Qwen2.5-VL via DashScope (default, cold start)
- **`yolo`** — Your trained `.pt` model (fast, free); low-confidence frames fallback to VLM

## Project Config

See [`projects/gazi-yolo.yaml`](projects/gazi-yolo.yaml). Key fields:

```yaml
images: path/to/images    # train/ val/ subdirs
labels: path/to/labels
classes:
  - id: 0
    name: bucket
    prompt: "describe what to box"
vlm:
  model: qwen-vl-max
yolo:
  model: path/to/best.pt
  conf_accept: 0.8
```

## Web UI

- Filter by status (`needs_human`, `auto_ok`, etc.)
- **Y** confirm · **N** reject · **LLM 重标** single-frame relabel
- Shows LLM review notes

## Export

```bash
labelkit export -c projects/gazi-yolo.yaml --out ../gazi-yolo/data/export
```

Copies confirmed frames (auto_ok + auto_fixed + human_ok) for training.

## License

MIT
