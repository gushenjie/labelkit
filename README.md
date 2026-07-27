# LabelKit

LLM 驱动的 YOLO 标注训练平台：**建项目 → 传视频 → 抽帧去重 → LLM 标注 → 人工复查 → 训练 → 模型反哺**。

> 以项目为单位隔离资源。支持目标检测与图像分类两种任务类型。

## 架构

```
Next.js 前端 (:3003)  →  FastAPI 后端 (:8010)  →  SQLite + data/projects/
```

- **后端**：`server/` — FastAPI + SQLAlchemy + 后台任务
- **前端**：`web/` — Next.js App Router + Tailwind
- **数据**：`data/labelkit.db` + `data/projects/<id>/`（gitignored）
- **旧 CLI**：`labelkit/` 保留，与新平台并存
- **UI 规范**：[`docs/UI设计规范.md`](docs/UI设计规范.md) — 全页面视觉 Token、组件、交互与响应式基线

## 快速启动

```bash
# 1. 后端
cd labelkit
source .venv/bin/activate
pip install -r server/requirements.txt
PYTHONPATH=. uvicorn server.main:app --host 127.0.0.1 --port 8010 --reload

# 2. 前端（新终端）
cd web && npm install && npm run dev
```

或使用脚本：

```bash
chmod +x scripts/start-server.sh scripts/start-web.sh
./scripts/start-server.sh   # http://127.0.0.1:8010
./scripts/start-web.sh      # http://127.0.0.1:3003
```

首次使用请在 **设置** 页配置 DashScope API Key。

## 产品流程

| 步骤 | 页面 | 说明 |
|------|------|------|
| 创建项目 | 项目列表 → 新建 | 选择 detect / classify，定义类别 |
| 素材接入 | 素材管理 | 上传视频/图片、抽帧、phash 去重 |
| 自动标注 | 自动标注 | LLM 批量标注 + 自动审查，带费用预估 |
| 人工复查 | 复查标注 | Y/N 快捷键 + **手动画框/改框**（保底） |
| 训练 | 训练模型 | 按视频切分 train/val，模型版本库 |
| 反哺 | 训练模型 | 用 pt 模型重标 human_wrong 帧 |
| 试用 | 模型试用台 | 上传图片看推理效果 |
| 导入 | 项目设置 | 导入已有 YOLO 数据集（如 gazi-yolo） |

## 帧状态

`unlabeled` → `llm_labeled` → `auto_ok` / `needs_human` → `human_ok` / `human_wrong` / `no_target`

## 迁移 gazi-yolo 数据

在项目设置 → 导入已有 YOLO 数据集，填写：

- 图片目录：`/path/to/gazi-yolo/data/images/train`
- 标签目录：`/path/to/gazi-yolo/data/labels/train`

## License

MIT
