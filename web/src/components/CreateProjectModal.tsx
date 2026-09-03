"use client";

import type { ChangeEvent, CSSProperties, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { api, Category, Project } from "@/lib/api";

type CreateProjectModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project, warning?: string) => void;
};

const CATEGORY_COLORS = ["#12A88F", "#1570EF", "#EC6B18", "#7F56D9", "#DC6803", "#0E9384"];
const DEFAULT_PROJECT_COVER = "/project-art/default-project-cover.png";
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const COVER_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function createCategory(index: number): Category {
  return {
    class_id: index,
    name: "",
    description: "",
    color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    required: index === 0,
  };
}

export function CreateProjectModal({ open, onClose, onCreated }: CreateProjectModalProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<"detect" | "classify">("detect");
  const [categories, setCategories] = useState<Category[]>([createCategory(0)]);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState("");
  const [coverError, setCoverError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => setMounted(true), []);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(coverFile);
    setCoverPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [coverFile]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setTaskType("detect");
    setCategories([createCategory(0)]);
    setCoverFile(null);
    setCoverError("");
    setSubmitted(false);
    setSaving(false);
    setSubmitError("");

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 80);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    categories.forEach((category) => {
      const key = category.name.trim().toLocaleLowerCase("zh-CN");
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [categories]);

  const categoryErrors = categories.map((category) => {
    const normalizedName = category.name.trim().toLocaleLowerCase("zh-CN");
    if (!category.name.trim()) return "请输入类别名称";
    if ((duplicateNames.get(normalizedName) || 0) > 1) return "类别名称不能重复";
    return "";
  });
  const nameError = !name.trim() ? "请输入项目名称" : "";
  const formValid = !nameError && !coverError && categoryErrors.every((error) => !error);

  const updateCategory = (index: number, patch: Partial<Category>) => {
    setCategories((current) => current.map((category, categoryIndex) => (
      categoryIndex === index ? { ...category, ...patch } : category
    )));
    setSubmitError("");
  };

  const addCategory = () => {
    setCategories((current) => [...current, createCategory(current.length)]);
    setSubmitError("");
  };

  const removeCategory = (index: number) => {
    setCategories((current) => current
      .filter((_, categoryIndex) => categoryIndex !== index)
      .map((category, categoryIndex) => ({ ...category, class_id: categoryIndex })));
    setSubmitError("");
  };

  const selectCover = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    if (!nextFile) return;
    const extensionAllowed = /\.(jpe?g|png|webp)$/i.test(nextFile.name);
    if ((!COVER_FILE_TYPES.has(nextFile.type) && !extensionAllowed) || nextFile.size > MAX_COVER_BYTES) {
      setCoverFile(null);
      setCoverError(nextFile.size > MAX_COVER_BYTES ? "图片不能超过 5 MB" : "仅支持 JPG、PNG 或 WebP");
      event.target.value = "";
      return;
    }
    setCoverFile(nextFile);
    setCoverError("");
    setSubmitError("");
  };

  const clearCover = () => {
    setCoverFile(null);
    setCoverError("");
    if (coverInputRef.current) coverInputRef.current.value = "";
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError("");
    if (!formValid) return;

    setSaving(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        description: description.trim(),
        task_type: taskType,
        categories: categories.map((category, index) => ({
          ...category,
          class_id: index,
          name: category.name.trim(),
          description: category.description.trim(),
          required: index === 0,
        })),
      });
      let warning: string | undefined;
      if (coverFile) {
        try {
          await api.uploadProjectCover(project.id, coverFile);
        } catch {
          warning = "项目已创建，封面上传失败，暂时使用默认封面";
        }
      }
      onCreated(project, warning);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "项目创建失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <form ref={modalRef} className="create-project-modal" aria-describedby="create-project-description" aria-labelledby="create-project-title" aria-modal="true" noValidate onSubmit={submit} role="dialog">
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="modal-title-icon"><Icon name="folder" size={19} /></span>
            <div><h2 id="create-project-title">新建项目</h2><p id="create-project-description">填写核心信息，其他设置可稍后完善。</p></div>
          </div>
          <button type="button" className="modal-close-button" aria-label="关闭新建项目弹框" disabled={saving} onClick={onClose}><Icon name="x" size={18} /></button>
        </header>

        <div className="modal-body">
          <div className="create-project-core">
            <div className="create-project-fields">
              <label className="form-field">
                <span className="form-label">项目名称 <em>必填</em></span>
                <input ref={nameInputRef} className={submitted && nameError ? "input input--error" : "input"} maxLength={80} placeholder="例如：产线零件缺陷检测" value={name} onChange={(event) => { setName(event.target.value); setSubmitError(""); }} aria-invalid={submitted && Boolean(nameError)} />
                {submitted && nameError && <small className="field-error">{nameError}</small>}
              </label>

              <label className="form-field">
                <span className="form-label">项目描述 <small>选填</small></span>
                <textarea className="input modal-textarea" maxLength={200} placeholder="一句话说明识别目标或使用场景" value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>

              <fieldset className="task-type-field">
                <legend>任务类型</legend>
                <div className="task-type-options">
                  <label className={taskType === "detect" ? "task-type-option task-type-option--selected" : "task-type-option"}>
                    <input type="radio" name="task-type" value="detect" checked={taskType === "detect"} onChange={() => setTaskType("detect")} />
                    <span className="task-type-option__icon"><Icon name="image" size={18} /></span>
                    <span className="task-type-option__copy"><strong>目标检测</strong><small>框选目标位置</small></span>
                    <span className="task-type-option__check"><Icon name="check" size={12} /></span>
                  </label>
                  <label className={taskType === "classify" ? "task-type-option task-type-option--selected task-type-option--classify" : "task-type-option task-type-option--classify"}>
                    <input type="radio" name="task-type" value="classify" checked={taskType === "classify"} onChange={() => setTaskType("classify")} />
                    <span className="task-type-option__icon"><Icon name="layers" size={18} /></span>
                    <span className="task-type-option__copy"><strong>图像分类</strong><small>判断整图类别</small></span>
                    <span className="task-type-option__check"><Icon name="check" size={12} /></span>
                  </label>
                </div>
              </fieldset>
            </div>

            <section className="project-cover-field" aria-labelledby="project-cover-label">
              <div className="project-cover-field__head"><span id="project-cover-label">项目封面</span><small>选填</small></div>
              <div className="project-cover-preview">
                <img src={coverPreviewUrl || DEFAULT_PROJECT_COVER} alt={coverFile ? "已选择的项目封面预览" : "通用默认项目封面"} />
                <span>{coverFile ? "自定义封面" : "默认封面"}</span>
              </div>
              <input ref={coverInputRef} className="project-cover-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectCover} />
              <div className="project-cover-actions">
                <button type="button" className="btn-secondary" onClick={() => coverInputRef.current?.click()}><Icon name="upload" size={14} />{coverFile ? "更换" : "上传图片"}</button>
                {coverFile && <button type="button" className="project-cover-reset" onClick={clearCover}>使用默认</button>}
              </div>
              <small className={coverError ? "project-cover-hint project-cover-hint--error" : "project-cover-hint"}>{coverError || "JPG、PNG、WebP，≤ 5 MB"}</small>
            </section>
          </div>

          <section className="project-categories-field">
            <header>
              <div><h3>{taskType === "detect" ? "检测类别" : "分类类别"}</h3><span>至少填写 1 个</span></div>
              <button type="button" className="add-category-button" onClick={addCategory}><Icon name="plus" size={14} />添加类别</button>
            </header>
            <div className="category-list">
              <div className="category-list__labels" aria-hidden="true"><span /><span>类别名称</span><span>{taskType === "detect" ? "目标描述（选填）" : "类别说明（选填）"}</span><span /></div>
              {categories.map((category, index) => (
                <div className="category-row" key={category.class_id}>
                  <span className="category-index" style={{ "--category-color": category.color } as CSSProperties}>{index + 1}</span>
                  <input className={submitted && categoryErrors[index] ? "input input--error" : "input"} maxLength={100} placeholder={taskType === "detect" ? "例如：裂纹" : "例如：合格品"} value={category.name} onChange={(event) => updateCategory(index, { name: event.target.value })} aria-label={`第 ${index + 1} 个类别名称`} aria-invalid={submitted && Boolean(categoryErrors[index])} />
                  <input className="input" maxLength={200} placeholder={taskType === "detect" ? "外观、位置或判定特征" : "该类别的判断标准"} value={category.description} onChange={(event) => updateCategory(index, { description: event.target.value })} aria-label={`第 ${index + 1} 个类别说明`} />
                  <button type="button" className="remove-category-button" aria-label={`删除第 ${index + 1} 个类别`} disabled={categories.length === 1} onClick={() => removeCategory(index)}><Icon name="trash" size={15} /></button>
                  {submitted && categoryErrors[index] && <small className="category-row__error">{categoryErrors[index]}</small>}
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <div className="modal-submit-message" role="alert">{submitError}</div>
          <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary modal-submit-button" disabled={!formValid || saving}>{saving ? <><span className="button-spinner" />创建中…</> : "创建项目"}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
