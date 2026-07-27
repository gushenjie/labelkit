type Props = {
  src: string;
  alt: string;
  label?: string;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
};

export function Thumb({ src, alt, label, selected, onClick, onDoubleClick }: Props) {
  return (
    <button
      type="button"
      className={selected ? "thumb thumb--selected" : "thumb"}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={alt}
    >
      <img src={src} alt={alt} />
      {label && <span className="thumb__label">{label}</span>}
    </button>
  );
}
