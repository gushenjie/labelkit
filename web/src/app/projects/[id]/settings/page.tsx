"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, Category, Project } from "@/lib/api";
import { useToast } from "@/components/ui/ToastProvider";
import { Icon } from "@/components/Icon";

const DEFAULT_PROJECT_COVER = "/project-art/default-project-cover.png";
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const COVER_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [labelPrompt, setLabelPrompt] = useState("");
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [coverPreviewUrl, setCoverPreviewUrl] = useState("");
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importImages, setImportImages] = useState("");
  const [importLabels, setImportLabels] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceClassId, setSourceClassId] = useState(1);
  const [targetClassId, setTargetClassId] = useState(0);
  const [sourceProjects, setSourceProjects] = useState<Project[]>([]);

  const coverCacheUrl = (projectId: string) => {
    const base = api.projectCoverUrl(projectId);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}t=${Date.now()}`;
  };

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then((p) => {
      setProject(p);
      setName(p.name);
      setDescription(p.description || "");
      setCategories(p.categories);
      setLabelPrompt(p.label_prompt);
      setReviewPrompt(p.review_prompt);
      setTargetClassId(p.categories[0]?.class_id ?? 0);
      setCoverPreviewUrl(p.has_custom_cover ? coverCacheUrl(p.id) : DEFAULT_PROJECT_COVER);
    });
    api.listProjects().then((projects) => setSourceProjects(projects.filter((item) => item.task_type === "detect")));
  }, [id]);

  const canSave = useMemo(() => Boolean(name.trim()) && !saving, [name, saving]);

  const save = async () => {
    if (!id || !canSave) return;
    const trimmedName = name.trim();
    setSaving(true);
    try {
      const updated = await api.updateProject(id, {
        name: trimmedName,
        description: description.trim(),
        label_prompt: labelPrompt,
        review_prompt: reviewPrompt,
      });
      await api.setCategories(id, categories.map((category, index) => ({ ...category, sort_order: index })));
      setProject(updated);
      setName(updated.name);
      setDescription(updated.description || "");
      toast({ type: "success", message: "设置已保存" });
    } catch (error) {
      toast({ type: "error", message: error instanceof Error ? error.message : "保存失败，请稍后重试" });
    } finally {
      setSaving(false);
    }
  };

  const uploadCover = async (file: File) => {
    if (!id) return;
    if (!COVER_FILE_TYPES.has(file.type)) {
      toast({ type: "error", message: "封面仅支持 JPG、PNG、WebP" });
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      toast({ type: "error", message: "封面大小不能超过 5 MB" });
      return;
    }
    setCoverUploading(true);
    try {
      await api.uploadProjectCover(id, file);
      setCoverPreviewUrl(coverCacheUrl(id));
      setProject((current) => (current ? { ...current, has_custom_cover: true } : current));
      toast({ type: "success", message: "封面已更新" });
    } catch (error) {
      toast({ type: "error", message: error instanceof Error ? error.message : "封面上传失败" });
    } finally {
      setCoverUploading(false);
      if (coverInputRef.current) coverInputRef.current.value = "";
    }
  };

  const runDerive = async () => {
    if (!id || !sourceProjectId) return;
    await api.createTask(id, "derive_classify", {
      source_project_id: sourceProjectId,
      source_class_id: sourceClassId,
      target_class_id: targetClassId,
    });
    toast({ type: "success", message: "派生分类素材任务已启动" });
  };

  const runImport = async () => {
    if (!id || !importImages) return;
    if (project?.task_type === "classify") {
      await api.createTask(id, "import", { root_dir: importImages });
    } else {
      await api.createTask(id, "import", {
        images_dir: importImages,
        labels_dir: importLabels,
        split: "train",
      });
    }
    toast({ type: "success", message: "导入任务已启动，完成后请到标注复核页" });
  };

  if (!project) {
    return (
      <div className="project-settings-page project-settings-page--loading">
        <p>加载中...</p>
      </div>
    );
  }

  const taskTypeLabel = project.task_type === "classify" ? "图像分类" : "目标检测";

  return (
    <div className="project-settings-page">
      <header className="project-settings-toolbar">
        <div>
          <h1>项目设置</h1>
          <p>名称与封面会同步到项目列表；提示词与类别影响标注与训练</p>
        </div>
        <button type="button" className="btn-primary" onClick={save} disabled={!canSave}>
          <Icon name="check" size={15} />
          {saving ? "保存中…" : "保存设置"}
        </button>
      </header>

      <div className="project-settings-shell">
        <section className="project-settings-identity" aria-label="基础信息">
          <div className="project-settings-cover">
            <div className="project-settings-cover__frame">
              <img src={coverPreviewUrl || DEFAULT_PROJECT_COVER} alt="" />
            </div>
            <input
              ref={coverInputRef}
              className="project-settings-cover__input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadCover(file);
              }}
            />
            <button
              type="button"
              className="btn-secondary project-settings-cover__action"
              disabled={coverUploading}
              onClick={() => coverInputRef.current?.click()}
            >
              <Icon name="upload" size={14} />
              {coverUploading ? "上传中…" : project.has_custom_cover ? "更换封面" : "上传封面"}
            </button>
          </div>

          <div className="project-settings-identity__fields">
            <div className="project-settings-identity__top">
              <label className="project-settings-field project-settings-field--name">
                <span>项目名称</span>
                <input
                  className="input"
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：产线零件缺陷检测"
                />
              </label>
              <div className="project-settings-type" title="创建后不可更改">
                <span>任务类型</span>
                <strong>{taskTypeLabel}</strong>
              </div>
            </div>
            <label className="project-settings-field">
              <span>项目描述</span>
              <textarea
                className="input"
                rows={2}
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="一句话说明识别目标或使用场景"
              />
            </label>
          </div>
        </section>

        <section className="project-settings-prompts" aria-label="智能标注提示词">
          <label className="project-settings-field">
            <span>标注提示词</span>
            <textarea
              className="input"
              value={labelPrompt}
              onChange={(e) => setLabelPrompt(e.target.value)}
              placeholder="告诉模型只标注相关目标，框要紧贴目标…"
            />
          </label>
          <label className="project-settings-field">
            <span>审查提示词</span>
            <textarea
              className="input"
              value={reviewPrompt}
              onChange={(e) => setReviewPrompt(e.target.value)}
              placeholder="描述可自动通过的结果，以及需人工复核的边界情况"
            />
          </label>
        </section>

        <section className="project-settings-categories" aria-label="类别定义">
          <header className="project-settings-categories__head">
            <div>
              <h2>类别定义</h2>
              <p>{categories.length} 个类别 · 名称与描述会进入标注提示上下文</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setCategories((current) => [
                ...current,
                {
                  class_id: Math.max(-1, ...current.map((category) => category.class_id)) + 1,
                  name: `新类别 ${current.length + 1}`,
                  description: "",
                  color: "#12A88F",
                  required: true,
                  sort_order: current.length,
                },
              ])}
            >
              <Icon name="plus" size={14} />
              新增类别
            </button>
          </header>

          <div className="project-settings-categories__table" role="table" aria-label="类别列表">
            <div className="project-settings-categories__cols" role="row" aria-hidden="true">
              <span>ID</span>
              <span>色</span>
              <span>类别名称</span>
              <span>视觉描述</span>
              <span />
            </div>
            <div className="project-settings-categories__list lk-scrollbar">
              {categories.map((category, index) => (
                <div key={category.id || index} className="project-settings-category" role="row">
                  <span className="project-settings-category__id">{category.class_id}</span>
                  <input
                    className="project-settings-category__color"
                    type="color"
                    aria-label={`${category.name || "类别"} 颜色`}
                    value={category.color}
                    onChange={(event) => {
                      const next = [...categories];
                      next[index] = { ...category, color: event.target.value };
                      setCategories(next);
                    }}
                  />
                  <input
                    className="input"
                    aria-label="类别名称"
                    value={category.name}
                    onChange={(e) => {
                      const next = [...categories];
                      next[index] = { ...category, name: e.target.value };
                      setCategories(next);
                    }}
                  />
                  <input
                    className="input project-settings-category__desc"
                    aria-label="视觉描述"
                    placeholder="告诉模型如何识别该类别"
                    value={category.description}
                    onChange={(e) => {
                      const next = [...categories];
                      next[index] = { ...category, description: e.target.value };
                      setCategories(next);
                    }}
                  />
                  <div className="project-settings-category__actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`上移 ${category.name}`}
                      disabled={index === 0}
                      onClick={() => setCategories((current) => {
                        const next = [...current];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        return next;
                      })}
                    >
                      <Icon name="chevron-down" size={14} style={{ transform: "rotate(180deg)" }} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`下移 ${category.name}`}
                      disabled={index === categories.length - 1}
                      onClick={() => setCategories((current) => {
                        const next = [...current];
                        [next[index], next[index + 1]] = [next[index + 1], next[index]];
                        return next;
                      })}
                    >
                      <Icon name="chevron-down" size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除 ${category.name}`}
                      onClick={() => setCategories((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <details className="project-settings-migrate">
        <summary>
          <span>
            <Icon name="database" size={15} />
            数据迁移
          </span>
          <small>导入 YOLO / 分类目录，或从检测项目派生素材</small>
        </summary>
        <div className="project-settings-migrate__body">
          <section className="project-settings-migrate__block">
            <header>
              <strong>导入已有数据集</strong>
              <p>填写本地目录后启动导入，完成后到标注复核页处理。</p>
            </header>
            {project.task_type === "classify" ? (
              <label className="project-settings-field">
                <span>数据集根目录</span>
                <input
                  className="input"
                  placeholder="/dataset/train/ok..."
                  value={importImages}
                  onChange={(e) => setImportImages(e.target.value)}
                />
              </label>
            ) : (
              <div className="project-settings-migrate__grid">
                <label className="project-settings-field">
                  <span>图片目录</span>
                  <input className="input" value={importImages} onChange={(e) => setImportImages(e.target.value)} />
                </label>
                <label className="project-settings-field">
                  <span>标签目录</span>
                  <input className="input" value={importLabels} onChange={(e) => setImportLabels(e.target.value)} />
                </label>
              </div>
            )}
            <button type="button" className="btn-secondary" onClick={runImport}>
              <Icon name="upload" size={15} />
              开始导入
            </button>
          </section>

          {project.task_type === "classify" && (
            <section className="project-settings-migrate__block">
              <header>
                <strong>派生分类素材</strong>
                <p>从检测项目的目标框裁剪图片，生成分类训练素材。</p>
              </header>
              <div className="project-settings-migrate__grid">
                <label className="project-settings-field">
                  <span>源检测项目</span>
                  <select className="input" value={sourceProjectId} onChange={(e) => setSourceProjectId(e.target.value)}>
                    <option value="">请选择源检测项目</option>
                    {sourceProjects.map((sourceProject) => (
                      <option key={sourceProject.id} value={sourceProject.id}>{sourceProject.name}</option>
                    ))}
                  </select>
                </label>
                <label className="project-settings-field">
                  <span>目标分类类别</span>
                  <select className="input" value={targetClassId} onChange={(e) => setTargetClassId(Number(e.target.value))}>
                    {categories.map((category) => (
                      <option key={category.class_id} value={category.class_id}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <label className="project-settings-field">
                  <span>裁剪类别 ID</span>
                  <input className="input" type="number" value={sourceClassId} onChange={(e) => setSourceClassId(Number(e.target.value))} />
                </label>
              </div>
              <button type="button" className="btn-secondary" onClick={runDerive}>
                <Icon name="image" size={15} />
                按框裁剪生成素材
              </button>
            </section>
          )}
        </div>
      </details>
    </div>
  );
}
