"use client";

type Props = {
  message?: string;
  fullScreen?: boolean;
};

export function LoadingScreen({ message = "加载中...", fullScreen = true }: Props) {
  return (
    <div
      className={`${fullScreen ? "fixed inset-0 z-[100]" : "absolute inset-0 z-50"} loading-screen`}
      role="status"
      aria-live="polite"
    >
      <div className="loading-screen__content">
        <span className="loading-screen__mark" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <path d="M16 3.2 26.5 9v14L16 28.8 5.5 23V9z" fill="currentColor" opacity="0.18" />
            <path d="M16 6.2 23.5 10.5v9L16 23.8 8.5 19.5v-9z" fill="currentColor" />
            <path d="M16 11.2 19 13v4L16 18.8 13 17v-4z" fill="white" />
          </svg>
        </span>
        <span className="loading-screen__message">{message}</span>
        <span className="loading-screen__track" aria-hidden="true"><i /></span>
      </div>
    </div>
  );
}
