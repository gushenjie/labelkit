import type { CSSProperties } from "react";
import styles from "./ListSkeleton.module.css";

type ListSkeletonProps = {
  variant?: "list" | "grid";
  count?: number;
  fields?: number;
  showThumbnail?: boolean;
  showAction?: boolean;
  label?: string;
  className?: string;
};

export function ListSkeleton({
  variant = "list",
  count = 6,
  fields = 3,
  showThumbnail = true,
  showAction = true,
  label = "正在加载列表",
  className = "",
}: ListSkeletonProps) {
  const safeCount = Math.max(1, Math.min(12, count));
  const safeFields = Math.max(0, Math.min(5, fields));

  return (
    <div
      className={`${styles.root} ${styles[variant]} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <span className={styles.assistive}>{label}</span>
      {Array.from({ length: safeCount }, (_, index) => (
        <div
          className={styles.item}
          key={index}
          aria-hidden="true"
          style={{ "--list-skeleton-index": index } as CSSProperties}
        >
          {showThumbnail ? <span className={`${styles.block} ${styles.thumbnail}`} /> : null}
          <span className={styles.identity}>
            <span className={`${styles.block} ${styles.title}`} />
            <span className={styles.tags}>
              <span className={`${styles.block} ${styles.tag}`} />
              <span className={`${styles.block} ${styles.tagWide}`} />
            </span>
            <span className={`${styles.block} ${styles.meta}`} />
          </span>
          {safeFields > 0 ? (
            <span className={styles.fields}>
              {Array.from({ length: safeFields }, (_, fieldIndex) => (
                <span
                  className={`${styles.block} ${styles.field}`}
                  key={fieldIndex}
                  style={{ width: `${58 + ((index + fieldIndex) % 3) * 12}%` }}
                />
              ))}
            </span>
          ) : null}
          <span className={styles.progress}>
            <span className={`${styles.block} ${styles.progressTrack}`} />
            <span className={`${styles.block} ${styles.progressValue}`} />
          </span>
          <span className={`${styles.block} ${styles.status}`} />
          {showAction ? <span className={`${styles.block} ${styles.action}`} /> : null}
        </div>
      ))}
    </div>
  );
}
