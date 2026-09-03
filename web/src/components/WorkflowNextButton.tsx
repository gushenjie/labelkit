import Link from "next/link";
import { Icon } from "@/components/Icon";

type WorkflowNextButtonProps = {
  href?: string;
  label: string;
  disabled?: boolean;
  disabledHint?: string;
};

/** 流程页统一的「下一步」入口按钮 */
export function WorkflowNextButton({ href, label, disabled, disabledHint = "暂不可用" }: WorkflowNextButtonProps) {
  if (disabled || !href) {
    return (
      <span
        className="materials-workspace__next-action materials-workspace__next-action--disabled"
        aria-disabled="true"
        title={disabledHint}
      >
        <Icon name="lock" size={16} />
        <div className="flex flex-col items-start leading-tight">
          <span className="text-[10px] font-normal normal-case opacity-90">{disabledHint}</span>
          <strong>{label}</strong>
        </div>
      </span>
    );
  }

  return (
    <Link
      href={href}
      className="materials-workspace__next-action materials-workspace__next-action--ready"
    >
      <Icon name="check" size={16} />
      <div className="flex flex-col items-start leading-tight">
        <span className="text-[10px] opacity-80 font-normal">下一步</span>
        <strong>{label}</strong>
      </div>
    </Link>
  );
}
