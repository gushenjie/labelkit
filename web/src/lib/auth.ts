export const AUTH_TOKEN_KEY = "labelkit.auth.token";
export const AUTH_PROFILE_KEY = "labelkit.auth.profile";

export type AuthProfile = {
  id: string;
  username: string;
  display_name: string;
  role: string;
};

export function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(AUTH_TOKEN_KEY) ?? "";
}

export function saveAuthToken(token: string): void {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function saveAuthProfile(profile: AuthProfile): void {
  window.localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(profile));
}

export function getAuthProfile(): AuthProfile | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(AUTH_PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthProfile;
  } catch {
    return null;
  }
}

export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_PROFILE_KEY);
}

/** 清除本地会话并跳转登录页 */
export function logout(): void {
  clearAuthToken();
  window.location.replace("/login");
}
