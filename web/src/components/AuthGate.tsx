"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { clearAuthToken, getAuthToken, saveAuthProfile } from "@/lib/auth";
import { LoadingScreen } from "@/components/ui/LoadingScreen";

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  // Keep the server render and the first client render identical. Reading
  // localStorage during state initialisation caused the whole application
  // shell to be replaced during hydration for signed-in users.
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("正在验证工作区…");

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setMessage("正在跳转登录…");
      redirectToLogin();
      return;
    }

    setReady(true);

    api.getAuthSession()
      .then((session) => {
        if (session.id && session.display_name && session.role) {
          saveAuthProfile({
            id: session.id,
            username: session.username,
            display_name: session.display_name,
            role: session.role,
          });
        }
      })
      .catch(() => {
        clearAuthToken();
        redirectToLogin();
      });
  }, []);

  if (!ready) {
    return <LoadingScreen message={message} />;
  }

  return children;
}
