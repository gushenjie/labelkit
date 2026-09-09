"use client";

import { useEffect, useState } from "react";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { api, VlmProfile } from "@/lib/api";
import { Icon } from "@/components/Icon";
import "./settings.css";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function newProfile(): VlmProfile {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "新增大模型",
    model: "qwen-vl-max",
    base_url: DEFAULT_BASE_URL,
    cost_per_image: 0.02,
    enabled: true,
  };
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState({
    dashscope_api_key_set: false,
    vlm_model: "qwen-vl-max",
    vlm_base_url: DEFAULT_BASE_URL,
    vlm_max_concurrency: 3,
    vlm_cost_per_image: 0.02,
    vlm_profiles: [] as VlmProfile[],
    default_vlm_id: "",
  });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);

  const updateProfile = (id: string, patch: Partial<VlmProfile>) => {
    setSettings((prev) => ({
      ...prev,
      vlm_profiles: prev.vlm_profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    }));
  };

  const addProfile = () => {
    const profile = newProfile();
    setSettings((prev) => ({
      ...prev,
      vlm_profiles: [...prev.vlm_profiles, profile],
      default_vlm_id: prev.default_vlm_id || profile.id,
    }));
  };

  const removeProfile = (id: string) => {
    setSettings((prev) => {
      if (prev.vlm_profiles.length <= 1) {
        toast({ type: "error", message: "至少保留一个大模型配置" });
        return prev;
      }
      const next = prev.vlm_profiles.filter((profile) => profile.id !== id);
      const defaultId =
        prev.default_vlm_id === id
          ? (next.find((profile) => profile.enabled) ?? next[0]).id
          : prev.default_vlm_id;
      return { ...prev, vlm_profiles: next, default_vlm_id: defaultId };
    });
  };

  const save = async () => {
    if (settings.vlm_profiles.length === 0) {
      toast({ type: "error", message: "请至少添加一个大模型" });
      return;
    }
    if (settings.vlm_profiles.some((profile) => !profile.name.trim() || !profile.model.trim())) {
      toast({ type: "error", message: "请填写完整的模型名称与 model id" });
      return;
    }
    setSaving(true);
    try {
      const next = await api.updateSettings({
        dashscope_api_key: apiKey || undefined,
        vlm_max_concurrency: settings.vlm_max_concurrency,
        vlm_profiles: settings.vlm_profiles,
        default_vlm_id: settings.default_vlm_id,
      });
      setSettings(next);
      setApiKey("");
      toast({ type: "success", message: "全局设置已保存" });
    } catch (error) {
      toast({ type: "error", message: String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page settings-page--spatial">
      <span className="settings-page__glow settings-page__glow--top" aria-hidden="true" />
      <span className="settings-page__glow settings-page__glow--bottom" aria-hidden="true" />

      <div className="settings-page__layout">
        <Panel className="settings-page__panel">
          <div className="settings-page__sections lk-scrollbar">
          <PanelSection title="API 密钥" id="api">
            <div className="settings-section-intro">
              <span><Icon name="lock" size={18} /></span>
              <div>
                <strong>服务访问凭证</strong>
                <p>仅保存在本机，列表中的大模型共用此密钥（通义用 DashScope；智谱需换成智谱 Key）。</p>
              </div>
              <span className={settings.dashscope_api_key_set ? "settings-health settings-health--ready" : "settings-health"}>
                <i aria-hidden="true" />
                {settings.dashscope_api_key_set ? "API 已配置" : "API 尚未配置"}
              </span>
            </div>
            <label className="settings-field">
              <span>API Key</span>
              <input
                className="input"
                id="dashscope-api-key"
                name="dashscope_api_key"
                type="password"
                autoComplete="new-password"
                aria-describedby="dashscope-api-key-hint"
                placeholder={settings.dashscope_api_key_set ? "已配置，留空表示不修改" : "sk-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <small id="dashscope-api-key-hint">{settings.dashscope_api_key_set ? "当前已有可用密钥" : "请填写服务访问密钥"}</small>
            </label>
          </PanelSection>

          <PanelSection title="大模型列表" id="model">
            <div className="settings-section-intro">
              <span><Icon name="sparkles" size={18} /></span>
              <div>
                <strong>可选用的视觉大模型</strong>
                <p>每家只保留一条最适合目标画框预标注的模型：通义主力，智谱作对照（需智谱 API Key）。</p>
              </div>
              <button type="button" className="btn-secondary settings-profile-add" onClick={addProfile}>
                <Icon name="plus" size={14} /> 添加模型
              </button>
            </div>

            <div className="settings-profile-list">
              {settings.vlm_profiles.map((profile) => {
                const isDefault = profile.id === settings.default_vlm_id;
                return (
                  <article
                    key={profile.id}
                    className={`settings-profile-card ${isDefault ? "settings-profile-card--default" : ""} ${profile.enabled ? "" : "settings-profile-card--disabled"}`}
                  >
                    <header className="settings-profile-card__head">
                      <div>
                        <strong>{profile.name || "未命名模型"}</strong>
                        <span>{profile.model || "未填写 model"}</span>
                      </div>
                      <div className="settings-profile-card__badges">
                        {isDefault && <em>默认</em>}
                        {!profile.enabled && <em className="settings-profile-card__off">已禁用</em>}
                      </div>
                    </header>

                    <div className="settings-form-grid">
                      <label className="settings-field">
                        <span>显示名称</span>
                        <input
                          className="input"
                          value={profile.name}
                          onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Model ID</span>
                        <input
                          className="input"
                          value={profile.model}
                          onChange={(e) => updateProfile(profile.id, { model: e.target.value })}
                        />
                      </label>
                      <label className="settings-field settings-field--wide">
                        <span>API Base URL</span>
                        <input
                          className="input"
                          type="url"
                          value={profile.base_url}
                          onChange={(e) => updateProfile(profile.id, { base_url: e.target.value })}
                        />
                      </label>
                      <label className="settings-field">
                        <span>单价（元/张）</span>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step="0.01"
                          value={profile.cost_per_image}
                          onChange={(e) =>
                            updateProfile(profile.id, { cost_per_image: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label className="settings-field settings-field--toggle">
                        <span>启用</span>
                        <input
                          type="checkbox"
                          checked={profile.enabled}
                          onChange={(e) => updateProfile(profile.id, { enabled: e.target.checked })}
                        />
                      </label>
                    </div>

                    <footer className="settings-profile-card__foot">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={isDefault}
                        onClick={() => setSettings((prev) => ({ ...prev, default_vlm_id: profile.id }))}
                      >
                        {isDefault ? "当前默认" : "设为默认"}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary settings-profile-card__delete"
                        onClick={() => removeProfile(profile.id)}
                      >
                        删除
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </PanelSection>

          <PanelSection title="执行策略" id="runtime">
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>最大并发数</span>
                <input
                  className="input"
                  id="vlm-max-concurrency"
                  name="vlm_max_concurrency"
                  type="number"
                  min={1}
                  max={32}
                  value={settings.vlm_max_concurrency}
                  onChange={(e) =>
                    setSettings({ ...settings, vlm_max_concurrency: Number(e.target.value) })
                  }
                />
                <small>并发越高，处理越快但更容易触发限流</small>
              </label>
            </div>
          </PanelSection>
          </div>

          <div className="settings-page__savebar">
            <div className="settings-page__sync-state" role="status" aria-live="polite">
              <span><Icon name={saving ? "refresh" : "check"} size={15} /></span>
              {saving ? "正在同步配置" : "配置修改后将应用于后续任务"}
            </div>
            <button type="button" className="btn-primary settings-page__save" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
