"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, Category, Project } from "@/lib/api";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { Icon } from "@/components/Icon";

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [labelPrompt, setLabelPrompt] = useState("");
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [importImages, setImportImages] = useState("");
  const [importLabels, setImportLabels] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceClassId, setSourceClassId] = useState(1);
  const [targetClassId, setTargetClassId] = useState(0);
  const [sourceProjects, setSourceProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then((p) => {
      setProject(p);
      setCategories(p.categories);
      setLabelPrompt(p.label_prompt);
      setReviewPrompt(p.review_prompt);
      setTargetClassId(p.categories[0]?.class_id ?? 0);
    });
    api.listProjects().then((projects) => setSourceProjects(projects.filter((item) => item.task_type === "detect")));
  }, [id]);

  const save = async () => {
    if (!id) return;
    await api.updateProject(id, { label_prompt: labelPrompt, review_prompt: reviewPrompt });
    await api.setCategories(id, categories.map((category, index) => ({ ...category, sort_order: index })));
    toast({ type: "success", message: "设置已保存" });
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
    toast({ type: "success", message: "导入任务已启动，完成后请到人工确认页" });
  };

  if (!project) return <p>加载中...</p>;

  return (
    <div className="operations-page project-settings-page">
      <PageHeader
        title="项目设置"
        description="管理模型提示词、类别定义与已有数据迁移"
        eyebrow="Project configuration"
        action={
          <button className="btn-primary" onClick={save}>
            <Icon name="check" size={15} />
            保存设置
          </button>
        }
        meta={
          <div className="project-settings-meta">
            <span>{project.task_type === "classify" ? "图像分类" : "目标检测"}</span>
            <span>{categories.length} 个类别</span>
          </div>
        }
      />

      <div className="project-settings-layout">
        <main className="project-settings-page__main">
          <Panel className="project-settings-panel">
            <PanelSection title="智能标注提示词">
              <div className="settings-section-intro">
                <span><Icon name="sparkles" size={18} /></span>
                <div>
                  <strong>约束模型如何理解和审查画面</strong>
                  <p>清晰描述目标边界、忽略对象与质量要求，可减少后续人工修正。</p>
                </div>
              </div>
              <label className="settings-field">
                <span>标注提示词</span>
                <textarea
                  className="input"
                  rows={5}
                  value={labelPrompt}
                  onChange={(e) => setLabelPrompt(e.target.value)}
                  placeholder="告诉 LLM 只标注与目标检测相关的内容，框要紧贴目标..."
                />
                <small>用于生成初始标注结果</small>
              </label>
              <label className="settings-field">
                <span>审查提示词</span>
                <textarea
                  className="input"
                  rows={4}
                  value={reviewPrompt}
                  onChange={(e) => setReviewPrompt(e.target.value)}
                  placeholder="描述哪些结果可以自动通过，以及需要人工复核的边界情况"
                />
                <small>用于机器预审和风险筛选</small>
              </label>
            </PanelSection>
          </Panel>

          <Panel className="project-settings-panel">
            <PanelSection
              title="类别定义"
              action={
                <button
                  type="button"
                  className="btn-secondary text-xs"
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
                  新增类别
                </button>
              }
            >
              <div className="project-category-list">
                {categories.map((category, index) => (
                  <div key={category.id || index} className="project-category-row">
                    <span className="project-category-row__index">{category.class_id}</span>
                    <input
                      className="project-category-row__color"
                      type="color"
                      aria-label={`${category.name} 颜色`}
                      value={category.color}
                      onChange={(event) => {
                        const next = [...categories];
                        next[index] = { ...category, color: event.target.value };
                        setCategories(next);
                      }}
                    />
                    <label>
                      <span>类别名称</span>
                      <input
                        className="input"
                        value={category.name}
                        onChange={(e) => {
                          const next = [...categories];
                          next[index] = { ...category, name: e.target.value };
                          setCategories(next);
                        }}
                      />
                    </label>
                    <label>
                      <span>视觉描述</span>
                      <input
                        className="input"
                        placeholder="告诉模型如何识别该类别"
                        value={category.description}
                        onChange={(e) => {
                          const next = [...categories];
                          next[index] = { ...category, description: e.target.value };
                          setCategories(next);
                        }}
                      />
                    </label>
                    <div className="project-category-row__actions">
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
                      ><Icon name="chevron-down" size={14} style={{ transform: "rotate(180deg)" }} /></button>
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
                      ><Icon name="chevron-down" size={14} /></button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`删除 ${category.name}`}
                        onClick={() => setCategories((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      ><Icon name="trash" size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </PanelSection>
          </Panel>
        </main>

        <aside className="project-settings-page__side">
          <Panel className="project-settings-panel project-import-panel">
            <PanelSection title="导入已有数据集">
              <div className="project-import-panel__intro">
                <span><Icon name="database" size={18} /></span>
                <div>
                  <strong>迁移现有 YOLO 数据</strong>
                  <p>导入后进入项目素材与人工确认流程。</p>
                </div>
              </div>
              {project.task_type === "classify" ? (
                <>
                  <label className="settings-field">
                    <span>数据集根目录</span>
                    <input
                      className="input"
                      placeholder="/dataset/train/ok..."
                      value={importImages}
                      onChange={(e) => setImportImages(e.target.value)}
                    />
                    <small>支持 root/train/类别 或 root/类别 目录结构</small>
                  </label>
                  <button className="btn-secondary" onClick={runImport}>
                    <Icon name="upload" size={15} />
                    开始导入
                  </button>
                </>
              ) : (
                <>
                  <label className="settings-field">
                    <span>图片目录</span>
                    <input className="input" value={importImages} onChange={(e) => setImportImages(e.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>标签目录</span>
                    <input className="input" value={importLabels} onChange={(e) => setImportLabels(e.target.value)} />
                  </label>
                  <button className="btn-secondary" onClick={runImport}>
                    <Icon name="upload" size={15} />
                    开始导入
                  </button>
                </>
              )}
            </PanelSection>
          </Panel>

          {project.task_type === "classify" && (
            <Panel className="project-settings-panel project-derive-panel">
              <PanelSection title="派生分类素材">
                <p>从检测项目的目标框裁剪图片，生成新的分类训练素材。</p>
                <label className="settings-field">
                  <span>源检测项目 ID</span>
                  <select className="input" value={sourceProjectId} onChange={(e) => setSourceProjectId(e.target.value)}>
                    <option value="">请选择源检测项目</option>
                    {sourceProjects.map((sourceProject) => (
                      <option key={sourceProject.id} value={sourceProject.id}>{sourceProject.name}</option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>目标分类类别</span>
                  <select className="input" value={targetClassId} onChange={(e) => setTargetClassId(Number(e.target.value))}>
                    {categories.map((category) => (
                      <option key={category.class_id} value={category.class_id}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>裁剪类别 ID</span>
                  <input className="input" type="number" value={sourceClassId} onChange={(e) => setSourceClassId(Number(e.target.value))} />
                </label>
                <button className="btn-secondary" onClick={runDerive}>
                  <Icon name="image" size={15} />
                  按框裁剪生成素材
                </button>
              </PanelSection>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
