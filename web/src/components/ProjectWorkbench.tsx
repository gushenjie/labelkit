export function ProjectWorkbench({ children }: { children: React.ReactNode }) {
  return (
    <div className="workbench workbench--integrated">
      <div className="workbench__main">{children}</div>
    </div>
  );
}
