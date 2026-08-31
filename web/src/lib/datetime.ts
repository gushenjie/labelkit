/** 将后端 UTC 时间格式化为本地（东八区）显示。 */
export function formatDateTime(value: string | Date): string {
  const raw = typeof value === "string" ? value.trim() : value.toISOString();
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  return new Date(normalized).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}
