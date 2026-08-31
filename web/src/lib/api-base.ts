/** 浏览器开发态走 Next 同源代理，避免图片跨域导致 canvas 无法绘制 */
const DEFAULT_API_ORIGIN = "http://127.0.0.1:8010";

export function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (typeof window !== "undefined") return "";
  return DEFAULT_API_ORIGIN;
}

export const API_BASE = resolveApiBase();
