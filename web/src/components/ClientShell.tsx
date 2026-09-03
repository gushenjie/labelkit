"use client";

import { usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";
import { AppProviders } from "@/components/AppProviders";
import { AuthGate } from "@/components/AuthGate";

export function ClientShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/login") {
    return <main id="main-content">{children}</main>;
  }

  return (
    <AuthGate>
      <AppProviders>
        <div className="app-shell">
          <a href="#main-content" className="skip-link">跳到主要内容</a>
          <Nav />
          <main className="app-main lk-scrollbar" id="main-content">{children}</main>
        </div>
      </AppProviders>
    </AuthGate>
  );
}
