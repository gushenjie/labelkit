"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  api,
  Project,
  PublicDatasetCandidate,
  PublicDatasetImport,
  PublicDatasetProvider,
  Task,
  Video,
} from "@/lib/api";
import { Icon } from "@/components/Icon";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useToast } from "@/components/ui/ToastProvider";

type UploadItem = {
  name: string;
  pct: number;
  done: boolean;
};

type MaterialSource = "local" | "public";

const DISCOVERY_EXAMPLES = ["厂区入侵检测", "烟雾识别", "反光衣检测", "鸟窝检测"];
const numberFormatter = new Intl.NumberFormat("zh-CN");
const ROBOFLOW_URL_RE = /^https:\/\/(?:universe|app)\.roboflow\.com\//i;

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "大小未知";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function MaterialsPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [targetFps, setTargetFps] = useState(1);
  const [maxFrames, setMaxFrames] = useState(0);
  const [dedupThreshold, setDedupThreshold] = useState(8);
  const [running, setRunning] = useState(false);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [discoveryIntent, setDiscoveryIntent] = useState("");
  const [showDiscoveryPlan, setShowDiscoveryPlan] = useState(false);
  const [providers, setProviders] = useState<PublicDatasetProvider[]>([]);
  const [candidates, setCandidates] = useState<PublicDatasetCandidate[]>([]);
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string>>({});
  const [discovering, setDiscovering] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<PublicDatasetCandidate | null>(null);
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);
  const [publicImport, setPublicImport] = useState<PublicDatasetImport | null>(null);
  const [classMapping, setClassMapping] = useState<Record<string, number | null>>({});
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);
  const [autoLabel, setAutoLabel] = useState(false);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [trainingParams, setTrainingParams] = useState({ epochs: 80, imgsz: 640, batch: 8, device: "auto" });
  const [publicBusy, setPublicBusy] = useState(false);
  const [sourceMode, setSourceMode] = useState<MaterialSource>("local");
  const videoRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    if (!id) return;
    api.listVideos(id).then((items) => {
      setVideos(items);
      setSelectedVideoIds((previous) => {
        const valid = new Set(items.map((item) => item.id));
        const next = new Set([...previous].filter((videoId) => valid.has(videoId)));
        if (next.size === 0) {
          items.forEach((video) => {
            if ((video.extracted_count ?? 0) === 0) next.add(video.id);
          });
        }
        return next;
      });
    });
    api.frameStats(id).then(setFrameStats);
    api.listTasks(id).then((items) => {
      setTasks(items);
      setRunning(
        items.some(
          (item) =>
            item.status === "running" && ["extract", "dedup"].includes(item.task_type),
        ),
      );
    });
  };

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then(setProject);
    api.publicDatasetProviders().then(setProviders).catch(() => setProviders([]));
    api.listPublicDatasetImports(id).then((imports) => {
      const latest = imports.find((item) => item.state !== "discarded");
      if (latest) {
        setPublicImport(latest);
        setSourceMode("public");
        setShowDiscoveryPlan(true);
      }
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [id]);

  useEffect(() => {
    if (!id || !publicImport || ["discarded", "training", "completed"].includes(publicImport.state)) return;
    const timer = window.setInterval(() => {
      api.getPublicDatasetImport(id, publicImport.id).then((next) => {
        setPublicImport(next);
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [id, publicImport?.id, publicImport?.state]);

  useEffect(() => {
    if (publicImport?.state === "fetched" && Object.keys(classMapping).length === 0) {
      setClassMapping(publicImport.suggested_mapping);
    }
  }, [publicImport?.id, publicImport?.state, publicImport?.suggested_mapping]);

  const uploadVideosParallel = async (files: File[]) => {
    if (!id || files.length === 0) return;
    setUploading(true);
    setUploads(files.map((file) => ({ name: file.name, pct: 0, done: false })));
    const newIds: string[] = [];
    await Promise.all(
      files.map(async (file, index) => {
        try {
          const video = await api.uploadVideoWithProgress(id, file, (pct) => {
            setUploads((previous) =>
              previous.map((item, itemIndex) =>
                itemIndex === index ? { ...item, pct } : item,
              ),
            );
          });
          newIds.push(video.id);
          setUploads((previous) =>
            previous.map((item, itemIndex) =>
              itemIndex === index ? { ...item, pct: 100, done: true } : item,
            ),
          );
        } catch (error) {
          toast({ type: "error", message: `${file.name} 上传失败：${error}` });
        }
      }),
    );
    setSelectedVideoIds((previous) => {
      const next = new Set(previous);
      newIds.forEach((videoId) => next.add(videoId));
      return next;
    });
    setUploading(false);
    refresh();
    if (newIds.length > 0) {
      toast({ type: "success", message: `已上传 ${newIds.length} 个视频，可开始提取素材` });
    }
  };

  const uploadImages = async (files: File[]) => {
    if (files.length === 0 || !id) return;
    setUploading(true);
    setUploads(files.map((file) => ({ name: file.name, pct: 35, done: false })));
    try {
      await api.uploadImages(id, files);
      setUploads(files.map((file) => ({ name: file.name, pct: 100, done: true })));
      refresh();
      toast({ type: "success", message: `已上传 ${files.length} 张图片` });
    } catch (error) {
      toast({ type: "error", message: `图片上传失败：${error}` });
    } finally {
      setUploading(false);
    }
  };

  const handleDroppedFiles = (files: File[]) => {
    const videoFiles = files.filter((file) => file.type.startsWith("video/"));
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (videoFiles.length > 0) void uploadVideosParallel(videoFiles);
    if (imageFiles.length > 0) void uploadImages(imageFiles);
    if (videoFiles.length === 0 && imageFiles.length === 0) {
      toast({ type: "error", message: "请选择视频或图片文件" });
    }
  };

  const startPrepare = async () => {
    if (!id || videos.length === 0) {
      toast({ type: "error", message: "请先上传视频" });
      return;
    }
    const videoIds = [...selectedVideoIds];
    if (videoIds.length === 0) {
      toast({ type: "error", message: "请至少选择一个视频" });
      return;
    }
    await api.createTask(id, "extract", {
      video_ids: videoIds,
      target_fps: targetFps,
      max_frames: maxFrames,
      threshold: dedupThreshold,
      auto_dedup: true,
      split: "train",
    });
    refresh();
    toast({ type: "info", message: "提取任务已启动，可在顶栏查看进度" });
  };

  const kaggleAvailable = providers.some((item) => item.provider === "kaggle" && item.available);
  const roboflowAvailable = providers.some((item) => item.provider === "roboflow" && item.available);
  const keywordDiscoveryAvailable = kaggleAvailable || roboflowAvailable;
  const publicExamples = DISCOVERY_EXAMPLES;

  const buildDiscoveryPlan = async () => {
    if (!discoveryIntent.trim()) {
      toast({
        type: "error",
        message: keywordDiscoveryAvailable
          ? "请先描述希望识别的目标或场景，也可粘贴 Roboflow URL"
          : "请先配置 Roboflow 或 Kaggle 凭据",
      });
      return;
    }
    if (!id) return;
    const intent = discoveryIntent.trim();
    const isRoboflowUrl = ROBOFLOW_URL_RE.test(intent);

    if (!isRoboflowUrl && !keywordDiscoveryAvailable) {
      setShowDiscoveryPlan(true);
      setCandidates([]);
      setSelectedCandidate(null);
      setLicenseConfirmed(false);
      setDiscoveryErrors({
        providers: "当前未配置可用的公开数据源凭据",
      });
      toast({ type: "error", message: "请先配置 Roboflow 或 Kaggle 凭据" });
      return;
    }

    setDiscovering(true);
    setShowDiscoveryPlan(true);
    setSelectedCandidate(null);
    setLicenseConfirmed(false);
    try {
      const result = await api.discoverPublicDatasets(
        id,
        isRoboflowUrl ? "" : intent,
        isRoboflowUrl ? intent : "",
      );
      setCandidates(result.candidates);
      setDiscoveryErrors(result.errors);
      if (result.candidates.length === 0) {
        const detail = Object.values(result.errors).filter(Boolean).join("；");
        toast({
          type: "error",
          message: detail || "没有找到可验证的数据集候选，请换个检索词试试",
        });
      }
    } catch (error) {
      toast({ type: "error", message: `公开数据检索失败：${error}` });
    } finally {
      setDiscovering(false);
    }
  };

  const startPublicFetch = async () => {
    if (!id || !selectedCandidate || !licenseConfirmed) return;
    setPublicBusy(true);
    try {
      const created = await api.fetchPublicDataset(id, selectedCandidate);
      setPublicImport(created);
      toast({ type: "info", message: "已开始下载固定版本并执行安全检查" });
    } catch (error) {
      toast({ type: "error", message: `无法开始下载：${error}` });
    } finally {
      setPublicBusy(false);
    }
  };

  const startPublicPublish = async () => {
    if (!id || !publicImport) return;
    if (publicImport.source_classes.some((item) => !(String(item.class_id) in classMapping))) {
      toast({ type: "error", message: "请为每个来源类别选择项目类别或忽略" });
      return;
    }
    setPublicBusy(true);
    try {
      await api.publishPublicDataset(id, publicImport.id, {
        class_mapping: classMapping,
        warnings_confirmed: warningsConfirmed,
        auto_label: autoLabel,
        cost_confirmed: costConfirmed,
        training_params: trainingParams,
      });
      setPublicImport({ ...publicImport, state: "publishing" });
      toast({ type: "info", message: "正在原子发布公开数据，可在任务中心查看进度" });
    } catch (error) {
      toast({ type: "error", message: `公开数据发布失败：${error}` });
    } finally {
      setPublicBusy(false);
    }
  };

  const approveAndTrain = async () => {
    if (!id || !publicImport) return;
    setPublicBusy(true);
    try {
      const task = await api.approvePublicDatasetAndTrain(id, publicImport.id);
      setPublicImport({ ...publicImport, state: "training", train_task_id: task.id });
      toast({ type: "success", message: "复查门禁通过，已创建不可变数据版本并开始训练" });
    } catch (error) {
      toast({ type: "error", message: `${error}` });
      const refreshed = await api.getPublicDatasetImport(id, publicImport.id).catch(() => null);
      if (refreshed) setPublicImport(refreshed);
    } finally {
      setPublicBusy(false);
    }
  };

  const discardPublicImport = async () => {
    if (!id || !publicImport) return;
    setPublicBusy(true);
    try {
      await api.discardPublicDataset(id, publicImport.id);
      setPublicImport(null);
      setSelectedCandidate(null);
      setClassMapping({});
      toast({ type: "success", message: "已安全放弃本次公开数据，不影响项目历史素材" });
      refresh();
    } catch (error) {
      toast({ type: "error", message: `${error}` });
    } finally {
      setPublicBusy(false);
    }
  };

  const activeExtract = tasks.find(
    (task) => task.task_type === "extract" && task.status === "running",
  );
  const readyFrames = frameStats.total ?? 0;
  const projectTypeLabel = project?.task_type === "classify" ? "图像分类" : "目标检测";
  const categoryNames = project?.categories.map((category) => category.name).join("、");

  return (
    <div className="materials-hub">
      <ProjectPageHeader
        title="素材管理"
        description="从本地采集或公开数据源建立项目数据集"
        action={
          readyFrames > 0 ? (
            <Link href={`/projects/${id}/label`} className="btn-primary">
              下一步：自动标注
            </Link>
          ) : undefined
        }
        meta={
          <div className="materials-hub__meta">
            <span>{projectTypeLabel}</span>
            <span>{categoryNames || "尚未定义类别"}</span>
          </div>
        }
      />

      <section className="materials-assets" aria-label="数据资产概览">
        <div>
          <span className="materials-assets__icon"><Icon name="image" size={17} /></span>
          <span><strong>{numberFormatter.format(readyFrames)}</strong><small>可用数据帧</small></span>
        </div>
        <div>
          <span className="materials-assets__icon"><Icon name="video" size={17} /></span>
          <span><strong>{videos.length}</strong><small>已上传视频</small></span>
        </div>
        <div>
          <span className="materials-assets__icon"><Icon name="database" size={17} /></span>
          <span><strong>{project?.disk_usage_mb.toFixed(2) ?? "0.00"} MB</strong><small>项目存储占用</small></span>
        </div>
        <div className={readyFrames > 0 ? "materials-assets__state materials-assets__state--ready" : "materials-assets__state"}>
          <i aria-hidden="true" />
          <span><strong>{readyFrames > 0 ? "数据已就绪" : "等待素材"}</strong><small>{readyFrames > 0 ? "可以进入智能标注" : "选择一种数据获取方式"}</small></span>
        </div>
      </section>

      {activeExtract && (
        <section className="materials-live-task">
          <div>
            <span className="project-section-kicker">Live processing</span>
            <strong>正在从视频提取可标注帧</strong>
          </div>
          <TaskProgress
            progress={activeExtract.progress}
            total={activeExtract.total}
            label="提取进度"
          />
        </section>
      )}

      <section className={`materials-intake materials-intake--${sourceMode}`} aria-label="素材获取工作区">
        <header className="materials-intake__head">
          <div>
            <span className="project-section-kicker">Data intake</span>
            <h2>{sourceMode === "local" ? "导入本地素材" : "寻找公开数据集"}</h2>
            <p>
              {sourceMode === "local"
                ? "接入现场监控、巡检视频或已有图片数据集"
                : "描述目标与场景，由智能体生成公开数据检索方案"}
            </p>
          </div>
          <div className="materials-source-switch" role="tablist" aria-label="素材获取方式">
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === "local"}
              className={sourceMode === "local" ? "materials-source-switch__item materials-source-switch__item--active" : "materials-source-switch__item"}
              onClick={() => setSourceMode("local")}
            >
              <Icon name="upload" size={15} />
              <span><strong>本地素材</strong><small>上传文件</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === "public"}
              className={sourceMode === "public" ? "materials-source-switch__item materials-source-switch__item--active" : "materials-source-switch__item"}
              onClick={() => setSourceMode("public")}
            >
              <Icon name="sparkles" size={15} />
              <span><strong>公开数据</strong><small>智能发现</small></span>
            </button>
          </div>
        </header>

        {sourceMode === "local" && (
          <div className="materials-intake__body" role="tabpanel">
            <div
              className={dragOver ? "materials-dropzone materials-dropzone--active" : "materials-dropzone"}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                handleDroppedFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <span className="materials-dropzone__icon"><Icon name="upload" size={24} /></span>
              <strong>拖拽视频或图片到这里</strong>
              <p>支持批量混合上传，原始素材将保留在当前项目内</p>
              <div>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={uploading}
                  onClick={() => videoRef.current?.click()}
                >
                  <Icon name="video" size={15} />
                  选择视频
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={uploading}
                  onClick={() => imageRef.current?.click()}
                >
                  <Icon name="image" size={15} />
                  选择图片
                </button>
              </div>
              <small>MP4、MOV、AVI · JPG、PNG、WEBP</small>
              <input
                ref={videoRef}
                type="file"
                accept="video/*"
                multiple
                hidden
                onChange={(event) =>
                  void uploadVideosParallel(Array.from(event.target.files ?? []))
                }
              />
              <input
                ref={imageRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) =>
                  void uploadImages(Array.from(event.target.files ?? []))
                }
              />
            </div>

            <aside className="materials-intake__rail" aria-label="本地素材处理说明">
              <div className="materials-rail-summary">
                <span className="materials-rail-summary__icon"><Icon name="video" size={18} /></span>
                <div>
                  <span className="project-section-kicker">Local source</span>
                  <h3>从现场素材开始</h3>
                  <p>适合监控录像、巡检视频和现场采集图片。</p>
                </div>
              </div>
              <div className="materials-source-types" aria-label="支持的素材类型">
                <span>监控视频</span>
                <span>巡检录像</span>
                <span>现场图片</span>
              </div>
              <ol className="materials-ingest-flow">
                <li><strong>01</strong><span><b>上传入库</b><small>保留原始文件与来源信息</small></span></li>
                <li><strong>02</strong><span><b>视频抽帧</b><small>按设置帧率生成可标注图像</small></span></li>
                <li><strong>03</strong><span><b>自动去重</b><small>过滤相似帧，减少重复标注</small></span></li>
              </ol>
              <div className="materials-rail-note">
                <Icon name="check" size={13} />
                上传完成后可统一配置抽帧参数
              </div>
            </aside>
          </div>
        )}

        {sourceMode === "public" && (
          <div className="materials-intake__body" role="tabpanel">
            <div className="materials-ai-composer">
              <div className="materials-ai-composer__badge">
                <Icon name="sparkles" size={15} />
                AI data scout
                <em>受控自动化</em>
              </div>
              <h3>描述你想识别的目标或场景</h3>
              <p>
                {roboflowAvailable
                  ? "已支持 Roboflow 关键词检索；也可直接粘贴带版本号的 Universe URL。"
                  : kaggleAvailable
                    ? "可用关键词检索 Kaggle，或粘贴 Roboflow URL。"
                    : "请先配置 Roboflow 或 Kaggle 凭据后再检索。"}
              </p>
                <label className="materials-ai-prompt">
                  <span>识别需求</span>
                  <textarea
                    rows={3}
                    value={discoveryIntent}
                    placeholder="例如：鸟窝检测、烟雾识别；或 https://universe.roboflow.com/workspace/project/1"
                    onChange={(event) => {
                      setDiscoveryIntent(event.target.value);
                      setShowDiscoveryPlan(false);
                    }}
                  />
                </label>

                <div className="materials-ai-examples">
                  <span>快速填写</span>
                  {publicExamples.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => {
                        setDiscoveryIntent(example);
                        setShowDiscoveryPlan(false);
                      }}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              <div className="materials-ai-composer__action">
                <button type="button" disabled={discovering} onClick={buildDiscoveryPlan}>
                  <Icon name="sparkles" size={16} />
                  {discovering ? "正在检索…" : "查找公开数据"}
                </button>
                <span>检索不会下载；选择固定版本并确认许可后才开始</span>
              </div>
            </div>

            <aside className="materials-intake__rail" aria-label="公开数据发现说明">
              <div className="materials-rail-summary">
                <span className="materials-rail-summary__icon"><Icon name="database" size={18} /></span>
                <div>
                  <span className="project-section-kicker">Public source</span>
                  <h3>面向任务筛选数据</h3>
                  <p>
                    {roboflowAvailable
                      ? "Roboflow 支持关键词自动检索公开数据集，无需再手动找链接。"
                      : "优先比较类别覆盖、场景接近度和许可证。"}
                  </p>
                </div>
              </div>
              <div className="materials-provider-list">
                {providers.map((provider) => (
                  <span key={provider.provider}>
                    <i>{provider.provider === "roboflow" ? "R" : "K"}</i>
                    {provider.provider === "roboflow" ? "Roboflow" : "Kaggle"}
                    <small>{provider.available ? "可用" : "未配置"}</small>
                  </span>
                ))}
              </div>
              <ol className="materials-ingest-flow">
                <li><strong>01</strong><span><b>理解需求</b><small>提取目标、场景与任务类型</small></span></li>
                <li><strong>02</strong><span><b>比较候选</b><small>按匹配度与数据质量排序</small></span></li>
                <li><strong>03</strong><span><b>导入训练</b><small>确认许可后统一格式入库</small></span></li>
              </ol>
              <div className="materials-rail-note">
                <Icon name="check" size={13} />
                {roboflowAvailable ? "Roboflow 已配置，可直接关键词检索" : "推荐结果会说明规模、格式与许可"}
              </div>
            </aside>
          </div>
        )}
      </section>

      {uploads.length > 0 && (
        <section className="materials-upload-queue" aria-label="上传队列">
          <header>
            <div>
              <span className="project-section-kicker">Upload queue</span>
              <h2>上传队列</h2>
            </div>
            <span>{uploads.filter((item) => item.done).length} / {uploads.length} 完成</span>
          </header>
          <ul>
            {uploads.map((item) => (
              <li key={item.name}>
                <span className={item.done ? "materials-upload-queue__state materials-upload-queue__state--done" : "materials-upload-queue__state"}>
                  {item.done ? <Icon name="check" size={14} /> : <Icon name="upload" size={14} />}
                </span>
                <strong>{item.name}</strong>
                <div><span style={{ width: `${item.pct}%` }} /></div>
                <em>{item.done ? "完成" : `${item.pct}%`}</em>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showDiscoveryPlan && (
        <section className="materials-discovery-plan">
          <header>
            <div>
              <span className="project-section-kicker">Discovery blueprint</span>
              <h2>公开数据检索方案</h2>
            </div>
            <span>{publicImport ? `导入状态 · ${publicImport.state}` : "等待数据源授权"}</span>
          </header>

          <div className="materials-discovery-plan__intent">
            <span><Icon name="sparkles" size={17} /></span>
            <div>
              <small>{publicImport ? "已恢复最近一次公开导入" : "智能体已理解需求"}</small>
              <strong>{publicImport?.title || discoveryIntent}</strong>
            </div>
          </div>

          <div className="materials-discovery-plan__checks">
            <div><span>任务匹配</span><strong>{projectTypeLabel}</strong><small>优先匹配项目任务类型</small></div>
            <div><span>类别覆盖</span><strong>{categoryNames || "从需求推断"}</strong><small>比较类别与场景覆盖度</small></div>
            <div><span>格式适配</span><strong>YOLO / COCO</strong><small>导入时自动统一数据格式</small></div>
            <div><span>合规检查</span><strong>许可证优先</strong><small>过滤用途不明确的数据集</small></div>
          </div>

          {discovering && (
            <div className="materials-discovery-plan__empty">
              <span><Icon name="sparkles" size={22} /></span>
              <div><strong>正在读取官方数据源元数据</strong><p>只比较候选，不会在此阶段下载文件。</p></div>
            </div>
          )}

          {!discovering && candidates.length === 0 && !publicImport && (
            <div className="materials-discovery-plan__empty">
              <span><Icon name="database" size={22} /></span>
              <div>
                <strong>暂未获得可验证的候选</strong>
                <p>
                  {Object.values(discoveryErrors).join("；")
                    || "可换个检索词，或粘贴带固定版本号的 Roboflow URL。"}
                </p>
              </div>
            </div>
          )}

          {candidates.length > 0 && !publicImport && (
            <div className="public-candidates">
              {candidates.map((candidate, index) => {
                const selected = selectedCandidate?.license_fingerprint === candidate.license_fingerprint;
                return (
                  <button
                    type="button"
                    key={`${candidate.provider}:${candidate.source_ref}:${candidate.source_version}`}
                    className={
                      selected
                        ? "public-candidate public-candidate--selected"
                        : index === 0
                          ? "public-candidate public-candidate--recommended"
                          : "public-candidate"
                    }
                    onClick={() => {
                      setSelectedCandidate(candidate);
                      setLicenseConfirmed(false);
                    }}
                  >
                    <span className="public-candidate__provider">{candidate.provider}</span>
                    {index === 0 && <span className="public-candidate__badge">最推荐</span>}
                    <strong>{candidate.title}</strong>
                    <p>{candidate.recommendation_reason || candidate.description || candidate.source_ref}</p>
                    <div>
                      <span>v{candidate.source_version}</span>
                      <span>{candidate.image_count ? `${numberFormatter.format(candidate.image_count)} 张` : "图片数待分析"}</span>
                      <span>{formatBytes(candidate.download_bytes)}</span>
                      <span>{candidate.license_name || "许可未知"}</span>
                      {candidate.classes?.length > 0 && <span>{candidate.classes.slice(0, 3).join(" / ")}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {selectedCandidate && !publicImport && (
            <div className="public-confirmation">
              <div>
                <strong>确认数据来源与许可</strong>
                <p>固定版本 {selectedCandidate.source_version} · {selectedCandidate.license_name || "许可未知"}。平台仅展示来源元数据，不构成法律意见。</p>
                <a href={selectedCandidate.source_url} target="_blank" rel="noreferrer">查看原始数据页面</a>
              </div>
              <label>
                <input type="checkbox" checked={licenseConfirmed} onChange={(event) => setLicenseConfirmed(event.target.checked)} />
                我已核对许可、署名要求和底层图片权利，并同意下载分析
              </label>
              <button type="button" className="btn-primary" disabled={!licenseConfirmed || publicBusy} onClick={startPublicFetch}>
                {publicBusy ? "正在创建任务…" : "下载并安全分析"}
              </button>
            </div>
          )}

          {publicImport && (
            <div className="public-import-workflow">
              <div className="public-import-workflow__steps" aria-label="公开数据导入进度">
                {["发现", "下载分析", "映射发布", "抽样复查", "版本训练"].map((step, index) => {
                  const progressIndex = ["created", "fetching", "fetched", "publishing", "needs_label", "review", "review_expanded", "training", "completed"].indexOf(publicImport.state);
                  const thresholds = [0, 1, 3, 5, 7];
                  return <span key={step} className={progressIndex >= thresholds[index] ? "is-active" : ""}><i>{index + 1}</i>{step}</span>;
                })}
              </div>

              <div className="public-import-workflow__summary">
                <div><small>当前状态</small><strong>{publicImport.state}</strong></div>
                <div><small>识别格式</small><strong>{publicImport.detected_format || "分析中"}</strong></div>
                <div><small>下载 / 解压</small><strong>{formatBytes(publicImport.actual_download_bytes)} / {formatBytes(publicImport.extracted_bytes)}</strong></div>
                <div><small>校验摘要</small><strong>{publicImport.artifact_checksum ? publicImport.artifact_checksum.slice(0, 12) : "待生成"}</strong></div>
              </div>

              {["created", "fetching"].includes(publicImport.state) && (
                <div className="public-import-workflow__notice"><Icon name="database" size={16} />正在下载固定版本、校验摘要并执行安全解压。此阶段不会创建项目帧。</div>
              )}

              {["fetch_failed", "fetch_interrupted"].includes(publicImport.state) && (
                <div className="public-import-workflow__notice public-import-workflow__notice--danger">下载或分析未完成。可在任务中心查看脱敏错误并安全重试，或放弃后重新选择候选。</div>
              )}

              {publicImport.state === "fetched" && (
                <div className="public-mapping">
                  <header><div><strong>确认类别映射与质量门禁</strong><p>每个来源类别都必须映射到现有项目类别或明确忽略，不会静默新建类别。</p></div></header>
                  <div className="public-mapping__quality">
                    <span>图片 <strong>{String(publicImport.quality_report.image_count ?? 0)}</strong></span>
                    <span>标注 <strong>{String(publicImport.quality_report.annotation_count ?? 0)}</strong></span>
                    <span>阻断 <strong>{Array.isArray(publicImport.quality_report.blocking) ? publicImport.quality_report.blocking.length : 0}</strong></span>
                    <span>警告 <strong>{Array.isArray(publicImport.quality_report.warnings) ? publicImport.quality_report.warnings.length : 0}</strong></span>
                  </div>
                  {Array.isArray(publicImport.quality_report.blocking) && publicImport.quality_report.blocking.length > 0 && (
                    <ul className="public-mapping__issues public-mapping__issues--danger">{publicImport.quality_report.blocking.map((item) => <li key={String(item)}>{String(item)}</li>)}</ul>
                  )}
                  {Array.isArray(publicImport.quality_report.warnings) && publicImport.quality_report.warnings.length > 0 && (
                    <ul className="public-mapping__issues">{publicImport.quality_report.warnings.map((item) => <li key={String(item)}>{String(item)}</li>)}</ul>
                  )}
                  <div className="public-mapping__rows">
                    {publicImport.source_classes.map((sourceClass) => (
                      <label key={sourceClass.class_id}><span>{sourceClass.name}<small>来源 ID {sourceClass.class_id}</small></span><select value={classMapping[String(sourceClass.class_id)] ?? "ignore"} onChange={(event) => setClassMapping((previous) => ({ ...previous, [String(sourceClass.class_id)]: event.target.value === "ignore" ? null : Number(event.target.value) }))}><option value="ignore">忽略此类别</option>{project?.categories.map((category) => <option key={category.class_id} value={category.class_id}>{category.name} · ID {category.class_id}</option>)}</select></label>
                    ))}
                  </div>
                  {Array.isArray(publicImport.quality_report.warnings) && publicImport.quality_report.warnings.length > 0 && <label className="public-mapping__check"><input type="checkbox" checked={warningsConfirmed} onChange={(event) => setWarningsConfirmed(event.target.checked)} />我已查看并接受质量报告中的警告</label>}
                  {Number(publicImport.quality_report.annotation_count ?? 0) === 0 && (
                    <div className="public-mapping__cost"><label><input type="checkbox" checked={autoLabel} onChange={(event) => setAutoLabel(event.target.checked)} />导入后对本次数据执行 VLM 自动标注</label>{autoLabel && <label><input type="checkbox" checked={costConfirmed} onChange={(event) => setCostConfirmed(event.target.checked)} />我确认预估费用约 ¥{publicImport.estimated_vlm_cost.toFixed(2)}</label>}</div>
                  )}
                  <div className="public-training-params">
                    <strong>训练参数</strong>
                    <label><span>轮次</span><input type="number" min="1" max="1000" value={trainingParams.epochs} onChange={(event) => setTrainingParams((previous) => ({ ...previous, epochs: Number(event.target.value) }))} /></label>
                    <label><span>图像尺寸</span><input type="number" min="32" max="4096" step="32" value={trainingParams.imgsz} onChange={(event) => setTrainingParams((previous) => ({ ...previous, imgsz: Number(event.target.value) }))} /></label>
                    <label><span>批大小</span><input type="number" min="1" max="1024" value={trainingParams.batch} onChange={(event) => setTrainingParams((previous) => ({ ...previous, batch: Number(event.target.value) }))} /></label>
                    <label><span>设备</span><select value={trainingParams.device} onChange={(event) => setTrainingParams((previous) => ({ ...previous, device: event.target.value }))}><option value="auto">自动</option><option value="cpu">CPU</option><option value="mps">MPS</option><option value="0">CUDA 0</option></select></label>
                  </div>
                  <button type="button" className="btn-primary" disabled={publicBusy || (Array.isArray(publicImport.quality_report.blocking) && publicImport.quality_report.blocking.length > 0) || (Array.isArray(publicImport.quality_report.warnings) && publicImport.quality_report.warnings.length > 0 && !warningsConfirmed) || (autoLabel && !costConfirmed)} onClick={startPublicPublish}>确认映射并发布到项目</button>
                </div>
              )}

              {["publishing", "needs_label"].includes(publicImport.state) && <div className="public-import-workflow__notice"><Icon name="sparkles" size={16} />{publicImport.state === "publishing" ? "正在事务化发布素材和标注。" : "素材已导入为未标注数据，请完成标注后再创建训练版本。"}</div>}
              {publicImport.state === "publish_interrupted" && <div className="public-import-workflow__notice public-import-workflow__notice--danger">发布被中断，源 staging 仍保留；请在任务中心重试，系统会清理未提交的孤儿文件。</div>}

              {["review", "review_expanded"].includes(publicImport.state) && (
                <div className="public-review-gate"><div><strong>需要完成风险抽样复查</strong><p>共有 {publicImport.review_frame_ids.length} 张固定样本。发现错误时系统会自动扩大受影响类别的复查范围。</p></div><div><Link href={`/projects/${id}/label?status=needs_human`} className="btn-secondary">打开抽样复查</Link><button type="button" className="btn-primary" disabled={publicBusy} onClick={approveAndTrain}>复查完成，创建版本并训练</button></div></div>
              )}

              {publicImport.state === "full_review_required" && <div className="public-import-workflow__notice public-import-workflow__notice--danger">抽样持续发现错误，已禁止自动训练。请全量复查或放弃该数据集。</div>}
              {publicImport.state === "training" && <div className="public-import-workflow__notice"><Icon name="check" size={16} />不可变数据版本已创建，训练任务正在运行。</div>}
              {["training_failed", "training_cancelled", "training_interrupted"].includes(publicImport.state) && <div className="public-import-workflow__notice public-import-workflow__notice--danger">训练未完成，不可变数据版本仍然保留。请在任务中心查看原因并重试。</div>}
              {publicImport.state === "completed" && <div className="public-import-workflow__notice"><Icon name="check" size={16} />公开数据链路已完成，训练结果已关联来源和数据版本。</div>}

              {!publicImport.dataset_version_id && !(["fetching", "publishing", "training"].includes(publicImport.state)) && <button type="button" className="public-import-workflow__discard" disabled={publicBusy} onClick={discardPublicImport}>放弃本次公开数据</button>}
            </div>
          )}
        </section>
      )}

      {videos.length > 0 && (
        <div className="materials-processing-grid">
          <section className="materials-video-panel">
            <header>
              <div>
                <span className="project-section-kicker">Video inventory</span>
                <h2>已上传视频</h2>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedVideoIds(
                      new Set(
                        videos
                          .filter((video) => (video.extracted_count ?? 0) === 0)
                          .map((video) => video.id),
                      ),
                    )
                  }
                >
                  仅选未提取
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedVideoIds(new Set(videos.map((video) => video.id)))}
                >
                  全选
                </button>
              </div>
            </header>
            <div className="materials-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th aria-label="选择" />
                    <th>文件名</th>
                    <th>时长</th>
                    <th>原片帧</th>
                    <th>已提取</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((video) => (
                    <tr key={video.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择视频 ${video.filename}`}
                          checked={selectedVideoIds.has(video.id)}
                          onChange={() =>
                            setSelectedVideoIds((previous) => {
                              const next = new Set(previous);
                              if (next.has(video.id)) next.delete(video.id);
                              else next.add(video.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>{video.filename}</td>
                      <td>{video.duration_sec ? `${video.duration_sec.toFixed(1)}s` : "—"}</td>
                      <td>{video.frame_count ?? "—"}</td>
                      <td>{video.extracted_count ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="materials-extract-panel">
            <header>
              <span className="project-section-kicker">Frame strategy</span>
              <h2>抽帧与去重策略</h2>
              <p>对选中视频生成可用于标注的训练素材</p>
            </header>
            <label>
              <span>每秒抽取帧数</span>
              <input
                className="input"
                type="number"
                step="0.1"
                min="0.1"
                value={targetFps}
                onChange={(event) => setTargetFps(Number(event.target.value))}
              />
            </label>
            <label>
              <span>最多保留帧数</span>
              <input
                className="input"
                type="number"
                min="0"
                value={maxFrames}
                onChange={(event) => setMaxFrames(Number(event.target.value))}
              />
              <small>填写 0 表示不限制</small>
            </label>
            <label>
              <span>重复判定阈值</span>
              <input
                className="input"
                type="number"
                min="1"
                max="20"
                value={dedupThreshold}
                onChange={(event) => setDedupThreshold(Number(event.target.value))}
              />
              <small>感知哈希距离不超过该值即判为重复；数值越大，删除越多</small>
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={running || uploading || selectedVideoIds.size === 0}
              onClick={startPrepare}
            >
              {running ? "提取中…" : `开始提取 ${selectedVideoIds.size} 个视频`}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
