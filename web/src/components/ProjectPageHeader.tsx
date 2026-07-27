import { ProjectContextBar } from "@/components/ProjectContextBar";
import { PageHeader, type PageHeaderProps } from "@/components/ui/PageHeader";

export function ProjectPageHeader(props: PageHeaderProps) {
  return (
    <div className="project-page-heading">
      <PageHeader {...props} />
      <ProjectContextBar />
    </div>
  );
}
