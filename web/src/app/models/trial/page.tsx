"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ModelTrialPreview, type TrialBox } from "@/components/ModelTrialPreview";
import { api, type Category } from "@/lib/api";

export default function ModelTrialPage() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const modelId = searchParams.get("modelId") ?? "";
  const name = searchParams.get("name") ?? "训练模型";
  const version = searchParams.get("version") ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<TrialBox[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((project) => setCategories(project.categories)).catch(() => setError("未能读取项目类别，请返回模型中心后重试。"));
  }, [projectId]);

  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const runPredict = async (file: File) => {
    if (!file.type.startsWith("image/")) { setError("请选择 JPG、PNG 等图片文件。"); return; }
    const nextUrl = URL.createObjectURL(file);
    setImageUrl((current) => { if (current) URL.revokeObjectURL(current); return nextUrl; });
    setFileName(file.name);
    setBoxes([]);
    setError("");
    setLoading(true);
    try {
      const result = await api.predictModel(projectId, modelId, file);
      setBoxes(result.boxes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型推理失败，请重试。");
    } finally {
      setLoading(false);
    }
  };

  const ready = Boolean(projectId && modelId);
  return <main className="model-trial-page">
    <header className="model-trial-page__header"><div><Link href="/models" className="model-trial-page__back"><Icon name="chevron-left" size={16} />返回模型中心</Link><p>在线测试</p><h1>{name} <span>{version}</span></h1><small>上传一张待测图片，查看该训练版本的真实检测结果。</small></div><div className="model-trial-page__model"><Icon name="package" size={22} /><span>当前模型</span><strong>{name}</strong></div></header>
    {!ready ? <section className="model-trial-page__notice"><strong>缺少模型上下文</strong><p>请从训练模型卡片点击“在线测试”进入此页面。</p><Link href="/models">返回模型中心</Link></section> : <section className="model-trial-workspace">
      <aside className="model-trial-actions"><div className="model-trial-actions__step"><span>01</span><div><strong>选择测试图片</strong><p>支持拖拽上传或从本地选择。</p></div></div><input ref={inputRef} type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void runPredict(file); event.currentTarget.value = ""; }} /><button type="button" className="model-trial-actions__upload" disabled={loading} onClick={() => inputRef.current?.click()}><Icon name="upload" size={18} />{loading ? "正在分析图片…" : "选择图片"}</button>{fileName && <p className="model-trial-actions__file"><Icon name="image" size={16} />{fileName}</p>}<div className="model-trial-actions__step"><span>02</span><div><strong>查看检测结果</strong><p>目标框、类别与置信度会直接标注在原图上。</p></div></div>{error && <p className="model-trial-actions__error">{error}</p>}</aside>
      <section className="model-trial-stage"><div className="model-trial-stage__heading"><div><span>检测画布</span><strong>{loading ? "推理中" : imageUrl ? "检测结果" : "等待图片"}</strong></div>{boxes.length > 0 && <span className="model-trial-stage__count">识别到 {boxes.length} 个目标</span>}</div><ModelTrialPreview imageUrl={imageUrl} boxes={boxes} categories={categories} loading={loading} onUpload={(file) => void runPredict(file)} uploadDisabled={loading} /></section>
    </section>}
  </main>;
}
