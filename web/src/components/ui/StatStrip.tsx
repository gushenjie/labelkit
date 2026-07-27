type Item = { label: string; value: number | string; hint?: string };

export function StatStrip({ items }: { items: Item[] }) {
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div key={item.label} className="stat-strip__item">
          <div className="stat-strip__value">{item.value}</div>
          <div className="stat-strip__label">{item.label}</div>
          {item.hint && <div className="stat-strip__hint">{item.hint}</div>}
        </div>
      ))}
    </div>
  );
}
