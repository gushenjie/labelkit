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
# Windows PowerShell 使用：.\.venv\Scripts\Activate.ps1
pip install -r server/requirements.txt
python -m server.run --reload

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

生产环境使用 `python -m server.run`（不带 `--reload`）。后台任务依赖 SQLite 项目租约，服务端固定为单 Worker；不要使用 `uvicorn --workers` 启动多个进程。

## 产品流程

| 步骤 | 页面 | 说明 |
|------|------|------|
| 创建项目 | 项目列表 → 新建 | 选择 detect / classify，定义类别 |
| 素材接入 | 素材管理 | 上传本地视频/图片，或受控导入 Kaggle / Roboflow 固定版本公开数据 |
| 自动标注 | 自动标注 | LLM 批量标注 + 自动审查，带费用预估 |
| 人工复查 | 复查标注 | Y/N 快捷键 + **手动画框/改框**（保底） |
| 训练 | 训练模型 | 按视频切分 train/val，模型版本库 |
| 反哺 | 训练模型 | 用 pt 模型重标 human_wrong 帧 |
| 试用 | 模型试用台 | 上传图片看推理效果 |
| 导入 | 项目设置 | 导入已有 YOLO 数据集（如 gazi-yolo） |

## 公开数据自动化

素材管理页支持两条公开数据链路：

- Kaggle：配置官方凭据后可按自然语言检索候选，并下载用户确认的固定版本。
- Roboflow：配置 `ROBOFLOW_API_KEY` 后同样支持自然语言检索 Universe；也可粘贴包含数字版本号的 Universe / App URL。

可用的 Kaggle 凭据来源为 `KAGGLE_API_TOKEN`、`KAGGLE_USERNAME` + `KAGGLE_KEY`，或官方凭据文件。Roboflow 使用 `ROBOFLOW_API_KEY`。密钥只从服务端环境读取，不会返回给浏览器。

完整流程为：候选发现 → 用户确认许可 → 安全下载和格式分析 → 类别映射与费用确认 → 原子发布 → 风险抽样复查 → 不可变数据版本 → 训练。支持 YOLO Detection、COCO Detection 和单标签分类目录。平台展示的许可信息不构成法律意见；未经许可、映射、费用或复查门禁的数据不能自动训练。

下载文件先进入项目隔离的 staging 目录；系统拒绝路径穿越、符号链接、异常压缩比、超过 2,000,000 个文件、非公网重定向和低于 5 GB 的剩余空间。失败和取消不会创建正式 Frame，页面刷新后会自动恢复最近一次未放弃的公开导入。

## 帧状态

`unlabeled` → `llm_labeled` → `auto_ok` / `needs_human` → `human_ok` / `human_wrong` / `no_target`

## 迁移 gazi-yolo 数据

在项目设置 → 导入已有 YOLO 数据集，填写：

- 图片目录：`/path/to/gazi-yolo/data/images/train`
- 标签目录：`/path/to/gazi-yolo/data/labels/train`

## License

MIT
