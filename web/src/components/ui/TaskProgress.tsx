import { Icon } from "@/components/Icon";
import { ChangedValue } from "./motion";

type Props = {
  progress: number;
  total: number;
  onStop?: () => void;
  stopping?: boolean;
  label?: string;
};

export function TaskProgress({ progress, total, onStop, stopping, label = "进度" }: Props) {
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((progress / total) * 100))) : 0;
  return (
    <div className="task-progress">
      <div className="task-progress__head">
        <span>{label}</span>
        <span>
          <ChangedValue value={total > 0 ? `${progress}/${total} (${pct}%)` : `${progress}/—`} />
        </span>
      </div>
      <div className="task-progress__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total > 0 ? pct : undefined}>
        <div className="task-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      {onStop && (
        <button type="button" className="task-progress__stop" disabled={stopping} onClick={onStop}>
          <Icon name="x" size={14} />
          {stopping ? "停止中…" : "停止训练"}
        </button>
      )}
    </div>
  );
}
