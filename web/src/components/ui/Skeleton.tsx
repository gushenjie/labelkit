export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton-block ${className}`.trim()} aria-hidden="true" />;
}
