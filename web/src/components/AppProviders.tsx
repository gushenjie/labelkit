"use client";

import { ToastProvider } from "@/components/ui/ToastProvider";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { TaskTrayProvider } from "@/components/TaskTrayProvider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <TaskTrayProvider>{children}</TaskTrayProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
