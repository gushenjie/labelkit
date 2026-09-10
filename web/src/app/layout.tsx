import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./dashboard.css";
import "./modal.css";
import "./toast.css";
import "./workbench.css";
import "./task-center.css";
import "./model-catalog.css";
import "./dataset-center.css";
import "./team.css";
import "./login.css";
import "./workspace-sidebar.css";
import "./audit.css";
import "./project-overview-clone.css";
import "./product-cohesion.css";
import "./interaction.css";
import { ClientShell } from "@/components/ClientShell";
import { brandPageTitle } from "@/lib/app-config";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: brandPageTitle,
  description: "视觉智能工作台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={inter.variable}>
      <body>
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
