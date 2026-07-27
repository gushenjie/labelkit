import type { Metadata } from "next";
import "./globals.css";
import "./dashboard.css";
import "./modal.css";
import "./toast.css";
import "./workbench.css";
import { ClientShell } from "@/components/ClientShell";

export const metadata: Metadata = {
  title: "LabelKit",
  description: "LLM-powered labeling and training platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
