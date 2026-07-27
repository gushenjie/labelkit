"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { api } from "@/lib/api";
import { Icon } from "@/components/Icon";

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

  useEffect(() => {
    api.getSettings().then(setSettings);
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
    <div className="settings-page">
      <PageHeader
        title="全局设置"
        description="LLM 标注 API 与并发参数"
        eyebrow="Platform configuration"
        action={
          <Link href="/" className="btn-secondary">
            <Icon name="chevron-left" size={15} />
            返回项目列表
          </Link>
        }
        meta={
          <span className={settings.dashscope_api_key_set ? "settings-health settings-health--ready" : "settings-health"}>
            <i aria-hidden="true" />
            {settings.dashscope_api_key_set ? "API 已配置" : "API 尚未配置"}
          </span>
        }
      />

      <div className="settings-page__body">
        <nav className="settings-page__nav" aria-label="设置分组">
          <a href="#api">API 密钥</a>
          <a href="#model">模型参数</a>
          <a href="#runtime">执行策略</a>
        </nav>

        <Panel className="settings-page__panel">
          <PanelSection title="API 密钥" id="api">
            <div className="settings-section-intro">
              <span><Icon name="settings" size={18} /></span>
              <div>
                <strong>DashScope 访问凭证</strong>
                <p>仅保存在本机，用于调用视觉大模型标注服务。</p>
              </div>
            </div>
            <label className="settings-field">
              <span>DashScope API Key</span>
              <input
                className="input"
                type="password"
                placeholder={settings.dashscope_api_key_set ? "已配置，留空表示不修改" : "sk-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <small>{settings.dashscope_api_key_set ? "当前已有可用密钥" : "请填写服务访问密钥"}</small>
            </label>
          </PanelSection>

          <PanelSection title="模型参数" id="model">
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>VLM 模型</span>
              <input
                className="input"
                value={settings.vlm_model}
                onChange={(e) => setSettings({ ...settings, vlm_model: e.target.value })}
              />
                <small>用于图片理解和标注生成</small>
              </label>
              <label className="settings-field settings-field--wide">
                <span>API Base URL</span>
              <input
                className="input"
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
                type="number"
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
        </Panel>
      </div>

      <div className="settings-page__savebar">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
