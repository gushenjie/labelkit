"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { api, type ModelVersion, type Project } from "@/lib/api";

type UploadModelModalProps = {
  open: boolean;
  onClose: () => void;
  onUploaded: (model: ModelVersion, project: Project) => void;
  /** URL 带 ?project= 时预选归属项目 */
  initialProjectId?: string | null;
};

const COVER_ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCoverFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    name.endsWith(".webp") ||
    file.type.startsWith("image/")
  );
}

export function UploadModelModal({ open, onClose, onUploaded, initialProjectId }: UploadModelModalProps) {
  const modalRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverPreviewUrlRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => setMounted(true), []);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  const clearCoverPreview = () => {
    if (coverPreviewUrlRef.current) {
      URL.revokeObjectURL(coverPreviewUrlRef.current);
      coverPreviewUrlRef.current = null;
    }
    setCoverPreviewUrl(null);
  };

  const chooseCover = (nextFile: File | null) => {
    clearCoverPreview();
    if (!nextFile) {
      setCover(null);
      return;
    }
    if (!isCoverFile(nextFile)) {
      setCover(null);
      setSubmitError("封面仅支持 JPG、PNG 或 WebP");
      return;
    }
    if (nextFile.size > 5 * 1024 * 1024) {
      setCover(null);
      setSubmitError("封面不能超过 5 MB");
      return;
    }
    const url = URL.createObjectURL(nextFile);
    coverPreviewUrlRef.current = url;
    setCover(nextFile);
    setCoverPreviewUrl(url);
    setSubmitError("");
  };

  useEffect(() => {
    if (!open) return;
    setName("");
    setFile(null);
    setCover(null);
    clearCoverPreview();
    setDragging(false);
    setSubmitted(false);
    setSaving(false);
    setSubmitError("");
    setLoadError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (coverInputRef.current) coverInputRef.current.value = "";

    setLoadingProjects(true);
    api.listProjects()
      .then((items) => {
        setProjects(items);
        const preferred = initialProjectId && items.some((p) => p.id === initialProjectId)
          ? initialProjectId
          : items[0]?.id ?? "";
        setProjectId(preferred);
      })
      .catch((error) => {
        setProjects([]);
        setProjectId("");
        setLoadError(error instanceof Error ? error.message : "加载项目列表失败");
      })
      .finally(() => setLoadingProjects(false));

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      clearCoverPreview();
    };
  }, [initialProjectId, open]);

  const projectError = !projectId ? "请选择归属项目" : "";
  const fileError = !file ? "请选择 .pt 模型文件" : !file.name.toLowerCase().endsWith(".pt") ? "仅支持 .pt 文件" : "";
  const canSubmit = !saving && !loadingProjects && projects.length > 0 && !projectError && !fileError;

  const chooseFile = (nextFile: File | null) => {
    setFile(nextFile);
    setSubmitted(false);
    setSubmitError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError("");
    if (projectError || fileError || !file) return;
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      setSubmitError("所选项目不存在，请刷新后重试");
      return;
    }
    setSaving(true);
    try {
      const model = await api.uploadModel(projectId, file, name.trim(), cover);
      onUploaded(model, project);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "上传失败，请稍后重试");
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
        className="create-project-modal upload-model-modal"
        aria-describedby="upload-model-description"
        aria-labelledby="upload-model-title"
        aria-modal="true"
        noValidate
        onSubmit={(event) => void submit(event)}
        role="dialog"
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="modal-title-icon"><Icon name="upload" size={19} /></span>
            <div>
              <h2 id="upload-model-title">上传模型</h2>
              <p id="upload-model-description">导入已有 YOLO 权重，用于在线测试与项目标注。</p>
            </div>
          </div>
          <button type="button" className="modal-close-button" aria-label="关闭上传模型弹框" disabled={saving} onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="modal-body upload-model-modal__body">
          <div className="upload-model-modal__section-head">
            <div>
              <strong>模型权重</strong>
              <span>必填</span>
            </div>
            <small>仅支持 PyTorch .pt 文件</small>
          </div>

          <label
            className={`upload-model-dropzone ${dragging ? "upload-model-dropzone--dragging" : ""} ${file ? "upload-model-dropzone--selected" : ""} ${submitted && fileError ? "upload-model-dropzone--error" : ""}`}
            htmlFor="upload-model-file"
            tabIndex={saving ? -1 : 0}
            onKeyDown={(event) => {
              if (saving || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              fileInputRef.current?.click();
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!saving) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!saving) chooseFile(event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <input
              id="upload-model-file"
              ref={fileInputRef}
              className="upload-model-dropzone__input"
              type="file"
              accept=".pt,application/octet-stream"
              disabled={saving}
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              aria-invalid={submitted && Boolean(fileError)}
            />
            <span className="upload-model-dropzone__icon" aria-hidden>
              <Icon name={file ? "package" : "upload"} size={24} />
            </span>
            <span className="upload-model-dropzone__copy">
              <strong>{file ? file.name : dragging ? "松开即可添加模型" : "选择或拖入模型权重"}</strong>
              <small>{file ? `${formatFileSize(file.size)} · 点击可重新选择` : "文件会上传到所选项目，不会覆盖已有模型"}</small>
            </span>
            {file && !fileError && <span className="upload-model-dropzone__ready"><Icon name="check" size={14} /> 已就绪</span>}
          </label>
          {(submitted || file) && fileError && <small className="field-error">{fileError}</small>}

          <div className="upload-model-modal__section-head upload-model-modal__section-head--settings">
            <div><strong>模型信息</strong></div>
            <small>用于模型中心展示与筛选</small>
          </div>

          <div className="upload-model-modal__fields">
            <label className="form-field">
              <span className="form-label">归属项目 <em>必填</em></span>
              <select
                className={submitted && projectError ? "input input--error" : "input"}
                value={projectId}
                disabled={loadingProjects || saving || projects.length === 0}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setSubmitError("");
                }}
                aria-invalid={submitted && Boolean(projectError)}
              >
                {projects.length === 0 ? (
                  <option value="">{loadingProjects ? "加载项目中…" : "暂无可用项目"}</option>
                ) : (
                  projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))
                )}
              </select>
              {submitted && projectError && <small className="field-error">{projectError}</small>}
              {loadError && <small className="field-error">{loadError}</small>}
            </label>

            <label className="form-field">
              <span className="form-label">模型名称 <small>选填</small></span>
              <input
                className="input"
                maxLength={80}
                placeholder="默认使用文件名"
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <div className="form-field upload-model-modal__cover-field">
              <span className="form-label">封面图 <small>选填</small></span>
              <label
                className={`upload-model-cover ${cover ? "upload-model-cover--selected" : ""}`}
                htmlFor="upload-model-cover"
              >
                <input
                  id="upload-model-cover"
                  ref={coverInputRef}
                  className="upload-model-dropzone__input"
                  type="file"
                  accept={COVER_ACCEPT}
                  disabled={saving}
                  onChange={(event) => chooseCover(event.target.files?.[0] ?? null)}
                />
                {coverPreviewUrl ? (
                  <img className="upload-model-cover__preview" src={coverPreviewUrl} alt="封面预览" />
                ) : (
                  <span className="upload-model-cover__placeholder" aria-hidden>
                    <Icon name="image" size={22} />
                  </span>
                )}
                <span className="upload-model-cover__meta">
                  <strong>{cover ? cover.name : "选择封面图"}</strong>
                  <small>{cover ? `${formatFileSize(cover.size)} · 点击可更换` : "JPG / PNG / WebP，不超过 5 MB"}</small>
                </span>
                {cover ? (
                  <button
                    type="button"
                    className="upload-model-cover__clear"
                    disabled={saving}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (coverInputRef.current) coverInputRef.current.value = "";
                      chooseCover(null);
                    }}
                  >
                    清除
                  </button>
                ) : null}
              </label>
            </div>
          </div>
          {submitError && <p className="field-error" role="alert">{submitError}</p>}
        </div>

        <footer className="modal-footer upload-model-modal__footer">
          <span className="upload-model-modal__footer-note"><Icon name="check" size={14} /> 上传后可在模型中心管理</span>
          <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary modal-submit-button" disabled={!canSubmit}>
            {saving ? "上传中…" : "开始上传"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
