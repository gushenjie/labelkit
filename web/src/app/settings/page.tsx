"use client";

import { useEffect, useState } from "react";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { api } from "@/lib/api";
import { Icon } from "@/components/Icon";
import "./settings.css";

export default function SettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState({
    dashscope_api_key_set: false,
    vlm_model: "qwen-vl-max",
    vlm_base_url: "",
    vlm_max_concurrency: 3,
    vlm_cost_per_image: 0.02,
  });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState("api");

  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    const sections = ["api", "model", "runtime"]
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleSection = entries.find((entry) => entry.isIntersecting);
        if (visibleSection) setActiveSection(visibleSection.target.id);
      },
      { rootMargin: "-18% 0px -62%", threshold: 0.05 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings({
        dashscope_api_key: apiKey || undefined,
        vlm_model: settings.vlm_model,
        vlm_base_url: settings.vlm_base_url,
        vlm_max_concurrency: settings.vlm_max_concurrency,
        vlm_cost_per_image: settings.vlm_cost_per_image,
      });
      const next = await api.getSettings();
      setSettings(next);
      setApiKey("");
      toast({ type: "success", message: "全局设置已保存" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page settings-page--spatial">
      <span className="settings-page__glow settings-page__glow--top" aria-hidden="true" />
      <span className="settings-page__glow settings-page__glow--bottom" aria-hidden="true" />

      <div className="settings-page__layout">
        <aside className="settings-page__rail" aria-label="设置分组">
          <div className="settings-page__rail-heading">
            <span><Icon name="sliders" size={17} /></span>
            <div>
              <strong>服务设置</strong>
              <small>模型调用与执行参数</small>
            </div>
          </div>
          <nav className="settings-page__anchors">
            <a
              href="#api"
              aria-current={activeSection === "api" ? "location" : undefined}
              className={`settings-page__anchor ${activeSection === "api" ? "settings-page__anchor--active" : ""}`}
              onClick={() => setActiveSection("api")}
            >
              <span>01</span>API 密钥
            </a>
            <a
              href="#model"
              aria-current={activeSection === "model" ? "location" : undefined}
              className={`settings-page__anchor ${activeSection === "model" ? "settings-page__anchor--active" : ""}`}
              onClick={() => setActiveSection("model")}
            >
              <span>02</span>模型参数
            </a>
            <a
              href="#runtime"
              aria-current={activeSection === "runtime" ? "location" : undefined}
              className={`settings-page__anchor ${activeSection === "runtime" ? "settings-page__anchor--active" : ""}`}
              onClick={() => setActiveSection("runtime")}
            >
              <span>03</span>执行策略
            </a>
          </nav>
          <div className="settings-page__rail-status">
            <span className={settings.dashscope_api_key_set ? "settings-health settings-health--ready" : "settings-health"}>
              <i aria-hidden="true" />
              {settings.dashscope_api_key_set ? "服务凭证就绪" : "等待配置凭证"}
            </span>
            <p>设置仅保存在当前工作区，不会同步到外部服务。</p>
          </div>
        </aside>

        <Panel className="settings-page__panel">
          <div className="settings-page__sections lk-scrollbar">
          <PanelSection title="API 密钥" id="api">
            <div className="settings-section-intro">
              <span><Icon name="lock" size={18} /></span>
              <div>
                <strong>DashScope 访问凭证</strong>
                <p>仅保存在本机，用于调用视觉大模型标注服务。</p>
              </div>
              <span className={settings.dashscope_api_key_set ? "settings-health settings-health--ready" : "settings-health"}>
                <i aria-hidden="true" />
                {settings.dashscope_api_key_set ? "API 已配置" : "API 尚未配置"}
              </span>
            </div>
            <label className="settings-field">
              <span>DashScope API Key</span>
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

          <PanelSection title="模型参数" id="model">
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>VLM 模型</span>
              <input
                className="input"
                id="vlm-model"
                name="vlm_model"
                value={settings.vlm_model}
                onChange={(e) => setSettings({ ...settings, vlm_model: e.target.value })}
              />
                <small>用于图片理解和标注生成</small>
              </label>
              <label className="settings-field settings-field--wide">
                <span>API Base URL</span>
              <input
                className="input"
                id="vlm-base-url"
                name="vlm_base_url"
                type="url"
                value={settings.vlm_base_url}
                onChange={(e) => setSettings({ ...settings, vlm_base_url: e.target.value })}
              />
                <small>兼容 OpenAI 协议的服务地址</small>
              </label>
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
              <label className="settings-field">
                <span>标注单价（元/张）</span>
              <input
                className="input"
                id="vlm-cost-per-image"
                name="vlm_cost_per_image"
                type="number"
                min={0}
                step="0.01"
                value={settings.vlm_cost_per_image}
                onChange={(e) =>
                  setSettings({ ...settings, vlm_cost_per_image: Number(e.target.value) })
                }
              />
                <small>用于任务开始前的费用预估</small>
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
