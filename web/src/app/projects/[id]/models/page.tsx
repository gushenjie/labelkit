"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

/** 旧项目内入口 → 全局模型库（带项目参数） */
export default function ProjectModelsRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) router.replace(`/models?project=${id}`);
  }, [id, router]);

  return <p className="text-muted">跳转到模型库…</p>;
}
