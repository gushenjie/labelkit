"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, Project, Task, Video } from "@/lib/api";
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

const DISCOVERY_EXAMPLES = ["厂区入侵检测", "烟雾识别", "反光衣检测"];

const numberFormatter = new Intl.NumberFormat("zh-CN");

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
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [id]);

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

  const buildDiscoveryPlan = () => {
    if (!discoveryIntent.trim()) {
      toast({ type: "error", message: "请先描述希望识别的目标或场景" });
      return;
    }
    setShowDiscoveryPlan(true);
    toast({
      type: "info",
      message: "检索方案已生成；接入 Roboflow 与 Kaggle 后可返回真实候选数据集",
    });
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
                <em>能力预览</em>
              </div>
              <h3>描述你想识别的目标或场景</h3>
              <p>智能体将把自然语言需求拆解为类别、场景和数据质量条件。</p>
                <label className="materials-ai-prompt">
                  <span>识别需求</span>
                  <textarea
                    rows={3}
                    value={discoveryIntent}
                    placeholder="例如：我想做厂区周界入侵检测，需要识别人、车辆和翻越围栏行为"
                    onChange={(event) => {
                      setDiscoveryIntent(event.target.value);
                      setShowDiscoveryPlan(false);
                    }}
                  />
                </label>

                <div className="materials-ai-examples">
                  <span>快速填写</span>
                  {DISCOVERY_EXAMPLES.map((example) => (
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
                <button type="button" onClick={buildDiscoveryPlan}>
                  <Icon name="sparkles" size={16} />
                  生成检索方案
                </button>
                <span>当前仅生成方案，不会立即下载数据</span>
              </div>
            </div>

            <aside className="materials-intake__rail" aria-label="公开数据发现说明">
              <div className="materials-rail-summary">
                <span className="materials-rail-summary__icon"><Icon name="database" size={18} /></span>
                <div>
                  <span className="project-section-kicker">Public source</span>
                  <h3>面向任务筛选数据</h3>
                  <p>优先比较类别覆盖、场景接近度和许可证。</p>
                </div>
              </div>
              <div className="materials-provider-list">
                <span><i>R</i>Roboflow Universe</span>
                <span><i>K</i>Kaggle</span>
              </div>
              <ol className="materials-ingest-flow">
                <li><strong>01</strong><span><b>理解需求</b><small>提取目标、场景与任务类型</small></span></li>
                <li><strong>02</strong><span><b>比较候选</b><small>按匹配度与数据质量排序</small></span></li>
                <li><strong>03</strong><span><b>导入项目</b><small>统一格式后进入素材库</small></span></li>
              </ol>
              <div className="materials-rail-note">
                <Icon name="check" size={13} />
                推荐结果会说明规模、格式与许可
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
            <span>等待数据源授权</span>
          </header>

          <div className="materials-discovery-plan__intent">
            <span><Icon name="sparkles" size={17} /></span>
            <div>
              <small>智能体已理解需求</small>
              <strong>{discoveryIntent}</strong>
            </div>
          </div>

          <div className="materials-discovery-plan__checks">
            <div><span>任务匹配</span><strong>{projectTypeLabel}</strong><small>优先匹配项目任务类型</small></div>
            <div><span>类别覆盖</span><strong>{categoryNames || "从需求推断"}</strong><small>比较类别与场景覆盖度</small></div>
            <div><span>格式适配</span><strong>YOLO / COCO</strong><small>导入时自动统一数据格式</small></div>
            <div><span>合规检查</span><strong>许可证优先</strong><small>过滤用途不明确的数据集</small></div>
          </div>

          <div className="materials-discovery-plan__empty">
            <span><Icon name="database" size={22} /></span>
            <div>
              <strong>候选数据集将在这里按匹配度排序</strong>
              <p>接入 Roboflow 与 Kaggle API 后，显示规模、类别、质量、许可证和预估导入量。</p>
            </div>
            <button type="button" disabled>一键导入项目</button>
          </div>
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
              <span>去重严格度</span>
              <input
                className="input"
                type="number"
                min="1"
                max="20"
                value={dedupThreshold}
                onChange={(event) => setDedupThreshold(Number(event.target.value))}
              />
              <small>数值越小，保留的相似画面越少</small>
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
