"use client";

import type { CSSProperties, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { api, Category, Project } from "@/lib/api";

type CreateProjectModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
};

const CATEGORY_COLORS = ["#12A88F", "#1570EF", "#EC6B18", "#7F56D9", "#DC6803", "#0E9384"];

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
  const modalRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<"detect" | "classify">("detect");
  const [categories, setCategories] = useState<Category[]>([createCategory(0)]);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (!open) return;

    setName("");
    setDescription("");
    setTaskType("detect");
    setCategories([createCategory(0)]);
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
  const formValid = !nameError && categoryErrors.every((error) => !error);

  const updateCategory = (index: number, patch: Partial<Category>) => {
    setCategories((current) =>
      current.map((category, categoryIndex) =>
        categoryIndex === index ? { ...category, ...patch } : category,
      ),
    );
    setSubmitError("");
  };

  const addCategory = () => {
    setCategories((current) => [...current, createCategory(current.length)]);
    setSubmitError("");
  };

  const removeCategory = (index: number) => {
    setCategories((current) =>
      current
        .filter((_, categoryIndex) => categoryIndex !== index)
        .map((category, categoryIndex) => ({ ...category, class_id: categoryIndex })),
    );
    setSubmitError("");
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
      onCreated(project);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "项目创建失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        ref={modalRef}
        className="create-project-modal"
        aria-describedby="create-project-description"
        aria-labelledby="create-project-title"
        aria-modal="true"
        noValidate
        onSubmit={submit}
        role="dialog"
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="modal-title-icon"><Icon name="folder" size={20} /></span>
            <div>
              <h2 id="create-project-title">新建项目</h2>
              <p id="create-project-description">定义任务与数据类别，创建后即可导入素材。</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-button"
            aria-label="关闭新建项目弹框"
            disabled={saving}
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="modal-body">
          <section className="form-section">
            <div className="form-section__heading">
              <span>1</span>
              <div>
                <h3>基本信息</h3>
                <p>名称用于项目检索，描述帮助团队快速理解数据范围。</p>
              </div>
            </div>
            <div className="form-section__content">
              <label className="form-field">
                <span className="form-label">项目名称 <em>必填</em></span>
                <input
                  ref={nameInputRef}
                  className={submitted && nameError ? "input input--error" : "input"}
                  maxLength={200}
                  placeholder="例如：产线零件缺陷检测"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setSubmitError("");
                  }}
                  aria-invalid={submitted && Boolean(nameError)}
                />
                <span className="field-meta">
                  <span className="field-error">{submitted ? nameError : ""}</span>
                  <span>{name.length}/200</span>
                </span>
              </label>
              <label className="form-field">
                <span className="form-label">项目描述 <small>选填</small></span>
                <textarea
                  className="input modal-textarea"
                  maxLength={300}
                  placeholder="说明应用场景、识别目标或数据范围"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <span className="field-meta field-meta--right">{description.length}/300</span>
              </label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__heading">
              <span>2</span>
              <div>
                <h3>任务类型</h3>
                <p>任务类型创建后不可修改，请根据最终模型用途选择。</p>
              </div>
            </div>
            <div className="form-section__content">
              <div className="task-type-options" role="radiogroup" aria-label="任务类型">
                <label className={taskType === "detect" ? "task-type-option task-type-option--selected" : "task-type-option"}>
                  <input
                    type="radio"
                    name="task-type"
                    value="detect"
                    checked={taskType === "detect"}
                    onChange={() => setTaskType("detect")}
                  />
                  <span className="task-type-option__icon"><Icon name="image" size={21} /></span>
                  <span className="task-type-option__copy">
                    <strong>目标检测</strong>
                    <small>识别目标位置并输出边界框</small>
                  </span>
                  <span className="task-type-option__check"><Icon name="check" size={13} /></span>
                </label>
                <label className={taskType === "classify" ? "task-type-option task-type-option--selected task-type-option--classify" : "task-type-option task-type-option--classify"}>
                  <input
                    type="radio"
                    name="task-type"
                    value="classify"
                    checked={taskType === "classify"}
                    onChange={() => setTaskType("classify")}
                  />
                  <span className="task-type-option__icon"><Icon name="layers" size={21} /></span>
                  <span className="task-type-option__copy">
                    <strong>图像分类</strong>
                    <small>判断整张图像所属的类别</small>
                  </span>
                  <span className="task-type-option__check"><Icon name="check" size={13} /></span>
                </label>
              </div>
            </div>
          </section>

          <section className="form-section form-section--categories">
            <div className="form-section__heading">
              <span>3</span>
              <div>
                <h3>{taskType === "detect" ? "检测类别" : "分类类别"}</h3>
                <p>{taskType === "detect" ? "描述需要框选的目标，说明越清楚，自动标注越准确。" : "定义模型需要区分的图像类别。"}</p>
              </div>
              <button type="button" className="add-category-button" onClick={addCategory}>
                <Icon name="plus" size={15} />添加类别
              </button>
            </div>
            <div className="form-section__content">
              <div className="category-list">
                {categories.map((category, index) => (
                  <div className="category-row" key={category.class_id}>
                    <span className="category-index" style={{ "--category-color": category.color } as CSSProperties}>
                      {index + 1}
                    </span>
                    <label className="category-field">
                      <span>类别名称</span>
                      <input
                        className={submitted && categoryErrors[index] ? "input input--error" : "input"}
                        maxLength={100}
                        placeholder={taskType === "detect" ? "例如：裂纹" : "例如：合格品"}
                        value={category.name}
                        onChange={(event) => updateCategory(index, { name: event.target.value })}
                        aria-invalid={submitted && Boolean(categoryErrors[index])}
                      />
                      {submitted && categoryErrors[index] && <small className="field-error">{categoryErrors[index]}</small>}
                    </label>
                    <label className="category-field category-field--description">
                      <span>{taskType === "detect" ? "目标描述" : "类别说明"} <small>选填</small></span>
                      <input
                        className="input"
                        placeholder={taskType === "detect" ? "外观、位置或判定特征" : "该类别的判断标准"}
                        value={category.description}
                        onChange={(event) => updateCategory(index, { description: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="remove-category-button"
                      aria-label={`删除第 ${index + 1} 个类别`}
                      disabled={categories.length === 1}
                      onClick={() => removeCategory(index)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <div className="modal-submit-message" role="alert">{submitError}</div>
          <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary modal-submit-button" disabled={saving}>
            {saving ? <><span className="button-spinner" />创建中…</> : <><Icon name="plus" size={16} />创建项目</>}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
