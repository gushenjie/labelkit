"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

/** 旧入口 → 全局模型库 */
export default function TrialRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) router.replace(`/models?project=${id}`);
  }, [id, router]);

  return <p className="text-muted">跳转到模型库…</p>;
}
