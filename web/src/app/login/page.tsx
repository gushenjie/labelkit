"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { clearAuthToken, getAuthToken, saveAuthProfile, saveAuthToken } from "@/lib/auth";
import { BRAND } from "@/lib/app-config";
import { Icon } from "@/components/Icon";
import { BrandMarkIcon } from "@/components/BrandMark";

function safeNextPath(): string {
  const candidate = new URLSearchParams(window.location.search).get("next") ?? "/";
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M2.5 12s3.4-5.3 9.5-5.3 9.5 5.3 9.5 5.3-3.4 5.3-9.5 5.3S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.3" />
      {crossed && <path d="m4 4 16 16" />}
    </svg>
  );
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;

    let active = true;
    const controller = new AbortController();

    api.getAuthSession({ signal: controller.signal })
      .then(() => {
        if (!active) return;
        window.location.replace(safeNextPath());
      })
      .catch(() => {
        if (!active) return;
        clearAuthToken();
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const session = await api.login(username.trim(), password);
      if (!session.token) throw new Error("登录响应缺少会话令牌");
      saveAuthToken(session.token);
      if (session.id && session.display_name && session.role) {
        saveAuthProfile({
          id: session.id,
          username: session.username,
          display_name: session.display_name,
          role: session.role,
        });
      }
      window.location.replace(safeNextPath());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "登录失败，请稍后重试");
      setSubmitting(false);
    }
  };

  return (
    <main className="login-stage">
      <div className="login-ambient login-ambient--top" aria-hidden="true" />
      <div className="login-ambient login-ambient--bottom" aria-hidden="true" />

      <section className="login-shell-v2" aria-labelledby="login-title">
        <div className="login-visual" aria-hidden="true">
          <div className="login-visual__image" />
          <div className="login-visual__edge" />
        </div>

        <div className="login-content-v2">
          <div className="login-content-v2__inner">
            <header className="login-brand-v2">
              <div className="login-brand-v2__lockup">
                <span className="login-brand-v2__mark">
                  <BrandMarkIcon />
                </span>
                <span className="login-brand-v2__copy">
                  <span className="login-brand-v2__name">{BRAND.fullName}</span>
                  <span className="login-brand-v2__edition">{BRAND.edition}</span>
                </span>
              </div>
              <p className="login-brand-v2__tagline">{BRAND.tagline}</p>
              <p className="login-brand-v2__slogan">{BRAND.slogan}</p>
            </header>

            <form onSubmit={handleSubmit} className="login-form-v2">
              <div className="login-form-v2__heading">
                <h1 id="login-title">欢迎登录</h1>
                <p>使用工作区账号继续管理视觉数据生产任务</p>
              </div>

              <div className="login-form-v2__field">
                <label htmlFor="login-username">账号</label>
                <div className="login-glass-input">
                  <div className="login-glass-input__control">
                    <div className="login-glass-input__icon" aria-hidden="true">
                      <Icon name="users" size={18} />
                    </div>
                    <input
                      id="login-username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      placeholder="请输入账号"
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>

              <div className="login-form-v2__field">
                <label htmlFor="login-password">密码</label>
                <div className="login-glass-input">
                  <div className="login-glass-input__control login-glass-input__control--password">
                    <div className="login-glass-input__icon" aria-hidden="true">
                      <Icon name="lock" size={18} />
                    </div>
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      placeholder="请输入密码"
                    />
                  </div>
                  <button
                    type="button"
                    className="login-glass-input__toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    <EyeIcon crossed={showPassword} />
                  </button>
                </div>
              </div>

              {error && (
                <div className="login-error" role="alert" aria-live="polite">
                  <Icon name="audit" size={14} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <button 
                type="submit" 
                disabled={!canSubmit}
                className="login-submit-v2"
              >
                {submitting ? (
                  <>
                    <span className="login-spinner" aria-hidden="true" />
                    <span>登录中…</span>
                  </>
                ) : "登录"}
              </button>

              <p className="login-password-help">忘记密码？请联系系统管理员重置</p>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
