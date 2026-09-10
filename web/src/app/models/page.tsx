"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { UploadModelModal } from "@/components/UploadModelModal";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { api, type ModelCatalog, type ModelCatalogItem } from "@/lib/api";

const FALLBACK_CATALOG: ModelCatalog = {
  total: 6,
  stats: [
    { label: "项目模型", value: "0", change: "工作区训练产物", icon: "cube" },
    { label: "可在线测试", value: "0", change: "可发起在线推理", icon: "layers" },
    { label: "近 7 日新增", value: "0", change: "最近训练完成", icon: "clock" },
  ],
  models: [
    { id: "yolov8", name: "YOLOv8", version: "v8.2", category: "计算机视觉", description: "先进的实时目标检测模型，兼顾速度与识别精度。", icon: "yolo", framework: "PyTorch", task: "目标检测", status: "运行中", metrics: [{ label: "mAP@0.5", value: "92.4%", change: "2.3%", direction: "up" }, { label: "准确率", value: "95.1%", change: "1.8%", direction: "up" }], updated_at: "2024年5月28日" },
    { id: "resnet50", name: "ResNet50", version: "v2.1", category: "图像分类", description: "用于图像分类的深度残差学习模型。", icon: "network", framework: "PyTorch", task: "图像分类", status: "运行中", metrics: [{ label: "Top-1 准确率", value: "93.7%", change: "1.6%", direction: "up" }, { label: "Top-5 准确率", value: "98.1%", change: "1.2%", direction: "up" }], updated_at: "2024年5月22日" },
    { id: "pp-ocrv4", name: "PP-OCRv4", version: "v4.0", category: "文字识别", description: "面向文字检测与识别的高性能 OCR 模型。", icon: "ocr", framework: "PaddlePaddle", task: "文字识别", status: "运行中", metrics: [{ label: "mAP", value: "89.6%", change: "2.1%", direction: "up" }, { label: "准确率", value: "94.0%", change: "1.7%", direction: "up" }], updated_at: "2024年5月20日" },
    { id: "wav2vec2", name: "Wav2Vec 2.0", version: "v2.0", category: "语音识别", description: "用于自动语音识别的自监督学习模型。", icon: "audio", framework: "PyTorch", task: "语音识别", status: "运行中", metrics: [{ label: "词错误率", value: "7.6%", change: "0.8%", direction: "down" }, { label: "字错误率", value: "2.1%", change: "0.4%", direction: "down" }], updated_at: "2024年5月18日" },
    { id: "pointnet", name: "PointNet++", version: "v1.3", category: "三维点云", description: "用于三维点云分类与分割的深度学习模型。", icon: "cube", framework: "PyTorch", task: "三维分类", status: "运行中", metrics: [{ label: "mIoU", value: "88.2%", change: "2.7%", direction: "up" }, { label: "准确率", value: "91.3%", change: "2.0%", direction: "up" }], updated_at: "2024年5月16日" },
    { id: "efficientnet", name: "EfficientNet-B4", version: "v1.2", category: "图像分类", description: "兼顾识别精度与推理效率的高效卷积网络。", icon: "chart", framework: "TensorFlow", task: "图像分类", status: "运行中", metrics: [{ label: "Top-1 准确率", value: "92.2%", change: "1.4%", direction: "up" }, { label: "Top-5 准确率", value: "97.5%", change: "1.1%", direction: "up" }], updated_at: "2024年5月14日" },
  ],
};

function CatalogIcon({ name, compact = false }: { name: string; compact?: boolean }) {
  const common = { viewBox: "0 0 48 48", "aria-hidden": true } as const;
  if (name === "yolo") return <span className="catalog-icon catalog-icon--word">YOLO</span>;
  if (name === "ocr") return <span className="catalog-icon catalog-icon--ocr"><b>⌜</b><em>OCR</em><i>⌟</i></span>;
  if (name === "audio") return <span className="catalog-icon"><svg {...common}><path d="M20 13v20a7 7 0 0 0 14 0V13a7 7 0 0 0-14 0Zm-6 13v7a13 13 0 0 0 26 0v-7M27 46v-7M20 46h14M8 23v12M3 28v3M13 19v20M43 23v12M47 28v3" /></svg></span>;
  if (name === "network") return <span className="catalog-icon"><svg {...common}><circle cx="12" cy="12" r="4"/><circle cx="36" cy="10" r="4"/><circle cx="37" cy="36" r="4"/><circle cx="11" cy="37" r="4"/><circle cx="24" cy="24" r="4"/><path d="m15 14 6 7m6-1 6-7m-6 14 7 6m-14-6-6 7"/></svg></span>;
  if (name === "chart") return <span className="catalog-icon"><svg {...common}><path d="M8 39h7V28H8v11Zm13 0h7V18h-7v21Zm13 0h7V7h-7v32ZM5 39h39" /></svg></span>;
  if (name === "layers") return <span className="catalog-icon"><Icon name="layers" size={compact ? 27 : 35} /></span>;
  if (name === "users") return <span className="catalog-icon"><Icon name="users" size={compact ? 28 : 35} /></span>;
  if (name === "clock") return <span className="catalog-icon"><Icon name="clock" size={compact ? 28 : 35} /></span>;
  return <span className="catalog-icon"><svg {...common}><path d="m24 4 17 9v21l-17 10L7 34V13l17-9Zm0 0v20m17-11-17 11L7 13m17 11v20" /></svg></span>;
}

function SelectFilter({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label className="catalog-select"><span>{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="All">全部</option>{values.map((item) => <option key={item}>{item}</option>)}</select><Icon name="chevron-down" size={15} /></label>;
}

function ModelCardArt({ model }: { model: ModelCatalogItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = model.project_id && model.model_id && model.has_cover
    ? api.modelCoverUrl(model.project_id, model.model_id)
    : model.project_id && model.preview_frame_id
      ? api.frameImageUrl(model.project_id, model.preview_frame_id)
      : null;

  return (
    <div className="model-card__art">
      {imageUrl && !imageFailed ? (
        <img
          className="model-card__art-image"
          src={imageUrl}
          alt={`${model.project_name ?? model.name} 的封面`}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <CatalogIcon name={model.icon} />
      )}
    </div>
  );
}

function ModelCard({
  model,
  deleting,
  onDelete,
}: {
  model: ModelCatalogItem;
  deleting?: boolean;
  onDelete?: (model: ModelCatalogItem) => void;
}) {
  const isTestable = Boolean(model.project_id && model.model_id);
  const canDelete = Boolean(model.project_id && model.model_id && onDelete);
  const title = model.project_name ?? model.name;
  const dateLabel = model.source === "训练模型" ? "训练于：" : model.source === "官方预训练" ? "注册于：" : "更新于：";
  return <article className="model-card">
    <div className="model-card__top"><ModelCardArt model={model} /><div className="model-card__intro"><div className="model-card__title"><h2>{title}</h2><span>{model.version}</span></div><div className="model-card__labels"><mark>{model.category}</mark>{model.source ? <mark>{model.source}</mark> : null}</div><p>{model.description}</p>{model.metadata?.length ? <div className="model-card__metadata">{model.metadata.map((item) => <span key={item}>{item}</span>)}</div> : null}</div></div>
    <div className="model-card__metrics">{model.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.change && <em>{metric.direction === "down" ? "↓" : "↑"} {metric.change}</em>}</div>)}</div>
    <footer>
      <span className="model-card__updated"><Icon name="clock" size={15} />{dateLabel}{model.updated_at}</span>
      <div className="model-card__actions">
        {canDelete && (
          <button
            type="button"
            className="model-card__delete"
            disabled={deleting}
            title="删除模型"
            aria-label={`删除 ${title} ${model.version}`}
            onClick={() => onDelete?.(model)}
          >
            <Icon name="trash" size={14} />
            {deleting ? "删除中…" : "删除"}
          </button>
        )}
        {isTestable ? (
          <Link
            className="model-card__deploy"
            href={`/models/trial?projectId=${encodeURIComponent(model.project_id!)}&modelId=${encodeURIComponent(model.model_id!)}&projectName=${encodeURIComponent(model.project_name ?? "")}&modelName=${encodeURIComponent(model.name)}&name=${encodeURIComponent(`${model.project_name ?? model.name} · ${model.name}`)}`}
          >
            在线测试<Icon name="chevron-right" size={15} />
          </Link>
        ) : (
          <span className="model-card__deploy model-card__deploy--disabled" title="内置示例模型暂未配置可推理的模型文件">内置示例</span>
        )}
      </div>
    </footer>
  </article>;
}

export default function GlobalModelsPage() {
  const searchParams = useSearchParams();
  const projectParam = searchParams.get("project");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [catalog, setCatalog] = useState(FALLBACK_CATALOG);
  const [query, setQuery] = useState("");
  const [modelType, setModelType] = useState("All");
  const [framework, setFramework] = useState("All");
  const [task, setTask] = useState("All");
  const [status, setStatus] = useState("All");
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const pageSize = 6;

  const refreshCatalog = () => {
    api.getModelCatalog().then(setCatalog).catch(() => setCatalog(FALLBACK_CATALOG));
  };

  useEffect(() => { refreshCatalog(); }, []);

  useEffect(() => {
    const open = () => setUploadOpen(true);
    window.addEventListener("open-upload-model", open);
    return () => window.removeEventListener("open-upload-model", open);
  }, []);

  const handleDelete = async (model: ModelCatalogItem) => {
    if (!model.project_id || !model.model_id) return;
    const title = model.project_name ?? model.name;
    const ok = await confirm({
      title: "删除模型",
      message: `确定删除「${title} ${model.version}」？\n将同时删除权重文件，且不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeletingId(model.id);
    try {
      await api.deleteModel(model.project_id, model.model_id);
      toast({ type: "success", message: `已删除「${title} ${model.version}」` });
      refreshCatalog();
    } catch (error) {
      toast({ type: "error", message: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setDeletingId(null);
    }
  };
  const unique = (key: "category" | "framework" | "task" | "status") => Array.from(new Set(catalog.models.map((model) => model[key])));
  const models = useMemo(() => catalog.models.filter((model) => {
    const haystack = `${model.name} ${model.category} ${model.description}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (modelType === "All" || model.category === modelType) && (framework === "All" || model.framework === framework) && (task === "All" || model.task === task) && (status === "All" || model.status === status);
  }), [catalog.models, framework, modelType, query, status, task]);
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleModels = models.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const start = models.length ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, models.length);

  const statIcon = (name: string): "cube" | "layers" | "clock" | "folder" => {
    if (name === "layers" || name === "clock" || name === "folder") return name;
    return "cube";
  };
  const statHint = (stat: { label: string; change: string }) => {
    if (stat.change) return stat.change;
    if (stat.label.includes("在线")) return "可发起在线推理";
    if (stat.label.includes("新增")) return "最近训练完成";
    return "工作区训练产物";
  };

  return <div className="model-catalog-page">
    <section className="catalog-stats" aria-label="模型统计">
      {catalog.stats.map((stat, index) => (
        <article className="catalog-stat-card" key={stat.label} style={{ "--catalog-index": index } as CSSProperties}>
          <span className="catalog-stat-card__icon"><Icon name={statIcon(stat.icon)} size={30} /></span>
          <div>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
            <small>{statHint(stat)}</small>
          </div>
        </article>
      ))}
    </section>
    <section className="catalog-toolbar" aria-label="模型筛选"><label className="catalog-search"><Icon name="search" size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称、类型或描述搜索模型" /></label><SelectFilter label="模型类型" value={modelType} values={unique("category")} onChange={setModelType} /><SelectFilter label="框架" value={framework} values={unique("framework")} onChange={setFramework} /><SelectFilter label="任务" value={task} values={unique("task")} onChange={setTask} /><SelectFilter label="状态" value={status} values={unique("status")} onChange={setStatus} /></section>
    <section className="model-card-grid model-card-grid--grid" aria-label="模型列表">{visibleModels.map((model) => <ModelCard key={model.id} model={model} deleting={deletingId === model.id} onDelete={handleDelete} />)}{models.length === 0 && <p className="catalog-empty">没有符合当前筛选条件的模型。</p>}</section>
    <footer className="catalog-pagination"><p>第 {start}–{end} 条，共 {models.length} 个模型</p><div><span className="catalog-pagination__size">每页 6 条</span><button type="button" disabled={currentPage === 1} aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))}><Icon name="chevron-left" size={15} /></button>{Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => <button type="button" key={number} aria-current={number === currentPage ? "page" : undefined} onClick={() => setPage(number)}>{number}</button>)}<button type="button" disabled={currentPage === pageCount} aria-label="下一页" onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><Icon name="chevron-right" size={15} /></button></div></footer>
    <UploadModelModal
      open={uploadOpen}
      initialProjectId={projectParam}
      onClose={() => setUploadOpen(false)}
      onUploaded={(model, project) => {
        setUploadOpen(false);
        toast({ type: "success", message: `已上传「${model.name}」到项目「${project.name}」` });
        refreshCatalog();
      }}
    />
  </div>;
}
