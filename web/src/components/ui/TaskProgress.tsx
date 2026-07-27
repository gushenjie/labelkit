type Props = {
  progress: number;
  total: number;
  onStop?: () => void;
  stopping?: boolean;
  label?: string;
};

export function TaskProgress({ progress, total, onStop, stopping, label = "进度" }: Props) {
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  return (
    <div className="task-progress">
      <div className="task-progress__head">
        <span>{label}</span>
        <span>
          {progress}/{total} ({pct}%)
        </span>
      </div>
      <div className="task-progress__bar">
        <div className="task-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      {onStop && (
        <button type="button" className="task-progress__stop" disabled={stopping} onClick={onStop}>
          {stopping ? "停止中…" : "停止"}
        </button>
      )}
    </div>
  );
}
