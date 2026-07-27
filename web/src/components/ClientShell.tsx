"use client";

import { Nav } from "@/components/Nav";
import { AppProviders } from "@/components/AppProviders";

export function ClientShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <div className="app-shell">
        <a href="#main-content" className="skip-link">跳到主要内容</a>
        <Nav />
        <main className="app-main" id="main-content">{children}</main>
      </div>
    </AppProviders>
  );
}
