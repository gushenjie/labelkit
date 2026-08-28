const STATUS_MAP: Record<string, { label: string; tone: string }> = {
  running: { label: "进行中", tone: "info" },
  pending: { label: "等待中", tone: "info" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
  interrupted: { label: "已中断", tone: "warning" },
  paused: { label: "已暂停", tone: "warning" },
  ready: { label: "待开始", tone: "muted" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const meta = STATUS_MAP[status] ?? { label: status, tone: "muted" };
  return (
    <span className={`status-badge status-badge--${meta.tone}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {label ?? meta.label}
    </span>
  );
}
