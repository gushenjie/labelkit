import { ProjectWorkbench } from "@/components/ProjectWorkbench";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <ProjectWorkbench>{children}</ProjectWorkbench>;
}
