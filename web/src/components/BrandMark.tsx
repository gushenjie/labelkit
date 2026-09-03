type BrandMarkIconProps = {
  className?: string;
};

export function BrandMarkIcon({ className }: BrandMarkIconProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M11 7.5H8.7a1.2 1.2 0 0 0-1.2 1.2V11M21 7.5h2.3a1.2 1.2 0 0 1 1.2 1.2V11M11 24.5H8.7a1.2 1.2 0 0 1-1.2-1.2V21M21 24.5h2.3a1.2 1.2 0 0 0 1.2-1.2V21"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="m16 10.7 4.6 2.65v5.3L16 21.3l-4.6-2.65v-5.3L16 10.7Z" fill="currentColor" />
      <circle cx="16" cy="16" r="2.65" fill="#07947D" />
    </svg>
  );
}
