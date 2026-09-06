/**
 * DeepSeek Harness QQ Bot Adapter - Client Side Settings Card
 * Registers into `settings.plugin.item` slot to provide native GUI configuration in DSH Settings page.
 */

const factory = (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  var React = require("react");

  const SETTINGS_NAMESPACE = "adapter-qq";

  function injectStyles(id, css) {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-adapter-qq";
    style.dataset.pluginCss = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

    const cssContent = `
    .dsh-qq-card {
      list-style: none;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
      border-radius: 12px;
      background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.03));
      transition: border-color .16s ease, background .16s ease;
      margin-bottom: 8px;
    }
    .dsh-qq-card:hover {
      border-color: var(--dsw-alias-label-dimmed, rgba(255,255,255,0.25));
    }
    .dsh-qq-card-open {
      border-color: var(--dsw-alias-label-dimmed, rgba(255,255,255,0.25));
      background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05));
    }
    .dsh-qq-header {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      appearance: none;
      border: 0;
      border-radius: 12px;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .dsh-qq-headtext {
      display: flex;
      min-width: 0;
      flex: 1;
      flex-direction: column;
      gap: 4px;
    }
    .dsh-qq-title {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--dsw-alias-label-primary, #fff);
    }
    .dsh-qq-desc {
      font-size: 13px;
      line-height: 1.5;
      color: var(--dsw-alias-label-tertiary, #888);
    }
    .dsh-qq-badge {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      line-height: 16px;
      background: var(--dsw-alias-brand-primary, #4b70e2);
      color: #fff;
    }
    .dsh-qq-chevron {
      flex: none;
      color: var(--dsw-alias-label-tertiary, #888);
      transition: transform .16s ease;
      width: 16px;
      height: 16px;
    }
    .dsh-qq-chevron-open {
      transform: rotate(180deg);
    }
    .dsh-qq-body {
      margin: 0 16px;
      padding: 14px 0 16px;
      border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .dsh-qq-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .dsh-qq-row-horizontal {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
    .dsh-qq-field-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dsh-qq-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--dsw-alias-label-primary, #fff);
    }
    .dsh-qq-hint {
      font-size: 12px;
      color: var(--dsw-alias-label-tertiary, #888);
      line-height: 1.4;
    }
    .dsh-qq-input {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15));
      background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.2));
      color: var(--dsw-alias-label-primary, #fff);
      font: inherit;
      font-size: 13px;
      box-sizing: border-box;
      outline: none;
    }
    .dsh-qq-input:focus {
      border-color: var(--dsw-alias-brand-primary, #4b70e2);
    }
    .dsh-qq-switch {
      box-sizing: border-box;
      position: relative;
      width: 38px;
      height: 22px;
      flex: 0 0 auto;
      padding: 2px;
      border: 0;
      border-radius: 11px;
      background: var(--dsw-alias-border-l3, rgba(255,255,255,0.2));
      cursor: pointer;
      transition: background .16s ease;
    }
    .dsh-qq-switch-on {
      background: var(--dsw-alias-brand-primary, #4b70e2);
    }
    .dsh-qq-switch-thumb {
      display: block;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #fff;
      transition: transform .12s ease;
    }
    .dsh-qq-switch-on .dsh-qq-switch-thumb {
      transform: translateX(16px);
    }
    .dsh-qq-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 14px;
      border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
    }
    .dsh-qq-status {
      margin-right: auto;
      font-size: 12px;
      color: var(--dsw-alias-label-tertiary, #888);
    }
    .dsh-qq-btn {
      padding: 6px 16px;
      border-radius: 8px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .dsh-qq-btn-discard {
      border-color: var(--dsw-alias-border-l2, rgba(255,255,255,0.15));
      background: none;
      color: var(--dsw-alias-label-secondary, #b0b4ba);
    }
    .dsh-qq-btn-discard:hover:not(:disabled) {
      color: var(--dsw-alias-label-primary, #fff);
      border-color: var(--dsw-alias-label-dimmed, rgba(255,255,255,0.3));
    }
    .dsh-qq-btn-save {
      background: var(--dsw-alias-brand-primary, #4b70e2);
      color: #fff;
    }
    .dsh-qq-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    `;

    function ChevronIcon(props) {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          className: `dsh-qq-chevron${props.open ? " dsh-qq-chevron-open" : ""}`,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        React.createElement("path", { d: "M4 6l4 4 4-4" })
      );
    }

    function Switch(props) {
      return React.createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": Boolean(props.checked),
          disabled: props.disabled,
          className: `dsh-qq-switch${props.checked ? " dsh-qq-switch-on" : ""}`,
          onClick: () => props.onChange(!props.checked),
        },
        React.createElement("span", { className: "dsh-qq-switch-thumb" })
      );
    }

    function TextField(props) {
      return React.createElement(
        "div",
        { className: "dsh-qq-row" },
        React.createElement(
          "div",
          { className: "dsh-qq-field-head" },
          React.createElement("label", { className: "dsh-qq-label" }, props.label)
        ),
        React.createElement("input", {
          type: props.type || "text",
          className: "dsh-qq-input",
          value: props.value ?? "",
          placeholder: props.placeholder,
          disabled: props.disabled,
          onChange: (e) => props.onChange(e.target.value),
        }),
        props.hint ? React.createElement("span", { className: "dsh-qq-hint" }, props.hint) : null
      );
    }

    function SwitchRow(props) {
      return React.createElement(
        "div",
        { className: "dsh-qq-row" },
        React.createElement(
          "div",
          { className: "dsh-qq-row-horizontal" },
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            React.createElement("label", { className: "dsh-qq-label" }, props.label),
            props.hint ? React.createElement("span", { className: "dsh-qq-hint" }, props.hint) : null
          ),
          React.createElement(Switch, {
            checked: props.checked,
            onChange: props.onChange,
            disabled: props.disabled,
          })
        )
      );
    }

    function SelectRow(props) {
      return React.createElement(
        "div",
        { className: "dsh-qq-row" },
        React.createElement("label", { className: "dsh-qq-label" }, props.label),
        React.createElement(
          "select",
          {
            className: "dsh-qq-input",
            value: props.value || "standard",
            disabled: props.disabled,
            onChange: (e) => props.onChange(e.target.value),
          },
          props.options.map((opt) =>
            React.createElement("option", { key: opt.value, value: opt.value }, opt.label)
          )
        ),
        props.hint ? React.createElement("span", { className: "dsh-qq-hint" }, props.hint) : null
      );
    }

    function QQSettingsCard(props) {
      const [open, setOpen] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [saveStatus, setSaveStatus] = React.useState("");
      const [draft, setDraft] = React.useState(null);

      const [snapshot, setSnapshot] = React.useState(() =>
        props.settings ? props.settings.getSnapshot() : { status: "ready", value: {} }
      );

      React.useEffect(() => {
        if (!props.settings) return;
        setSnapshot(props.settings.getSnapshot());
        return props.settings.subscribe(() => {
          setSnapshot(props.settings.getSnapshot());
        });
      }, [props.settings]);

      React.useEffect(() => {
        injectStyles("dsh-qq-bot-styles", cssContent);
      }, []);

      const serverValues = snapshot.value || {};
      const current = { ...serverValues, ...(draft || {}) };
      const isDirty = draft !== null;

      const updateField = (field, val) => {
        setSaveStatus("");
        setDraft((prev) => ({
          ...(prev || serverValues),
          [field]: val,
        }));
      };

      const handleDiscard = () => {
        setDraft(null);
        setSaveStatus("");
      };

      const handleSave = async () => {
        if (!draft || saving) return;
        setSaving(true);
        setSaveStatus("保存中...");
        try {
          if (props.settings && props.settings.mutate) {
            const ops = Object.entries(draft).map(([field, value]) => ({
              op: "set",
              path: [field],
              value,
            }));
            await props.settings.mutate(ops);
          } else if (props.settings && props.settings.set) {
            for (const [k, v] of Object.entries(draft)) {
              await props.settings.set(k, v);
            }
          } else if (props.settings && props.settings.update) {
            await props.settings.update(draft);
          }
          setDraft(null);
          setSaveStatus("✅ 保存成功");
          setTimeout(() => setSaveStatus(""), 3000);
        } catch (err) {
          setSaveStatus("❌ 保存失败: " + (err.message || String(err)));
        } finally {
          setSaving(false);
        }
      };

      return React.createElement(
        "li",
        { className: `dsh-qq-card${open ? " dsh-qq-card-open" : ""}` },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-qq-header",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
          },
          React.createElement(
            "span",
            { className: "dsh-qq-headtext" },
            React.createElement("span", { className: "dsh-qq-title" }, "QQ 机器人 (QQ Bot)"),
            React.createElement(
              "span",
              { className: "dsh-qq-desc" },
              "QQ 开放平台官方单聊机器人适配器：C2C 交互、双向会话同步、操作板与审批控制"
            )
          ),
          isDirty ? React.createElement("span", { className: "dsh-qq-badge" }, "未保存") : null,
          React.createElement(ChevronIcon, { open })
        ),
        open
          ? React.createElement(
              "div",
              { className: "dsh-qq-body" },
              React.createElement(SwitchRow, {
                label: "启用 QQ 机器人连接",
                hint: "开启后自动连接 QQ 开放平台 WebSocket Gateway",
                checked: current.enabled !== false,
                onChange: (val) => updateField("enabled", val),
              }),
              React.createElement(TextField, {
                label: "Bot AppID",
                hint: "QQ 开放平台机器人应用唯一 ID (q.qq.com 开发设置)",
                value: current.appId,
                placeholder: "例如：102882069",
                onChange: (val) => updateField("appId", val),
              }),
              React.createElement(TextField, {
                label: "Bot AppSecret (开发者密钥)",
                hint: "QQ 开放平台开发者密钥（仅保存在本地设置）",
                type: "password",
                value: current.clientSecret,
                placeholder: "输入 AppSecret",
                onChange: (val) => updateField("clientSecret", val),
              }),
              React.createElement(SwitchRow, {
                label: "沙箱测试环境 (Sandbox)",
                hint: "机器人未正式上线发布前请开启沙箱环境，并需在开放平台测试人员管理中添加您的 QQ 号",
                checked: Boolean(current.sandbox),
                onChange: (val) => updateField("sandbox", val),
              }),
              React.createElement(TextField, {
                label: "绑定用户 OpenID",
                hint: "专属私人用户的 OpenID（留空将在收到您发送的首条私聊消息时自动绑定）",
                value: current.userOpenid,
                placeholder: "自动获取或手动填入",
                onChange: (val) => updateField("userOpenid", val),
              }),
              React.createElement(SelectRow, {
                label: "新建会话默认 Agent 预设",
                hint: "新建会话时默认使用的预设（可通过 /preset 指令即时切换）",
                value: current.defaultPreset,
                options: [
                  { value: "standard", label: "标准模式 (Standard - 全量工具)" },
                  { value: "ptc", label: "PTC 模式 (TypeScript 组合执行)" },
                  { value: "minimal", label: "极简模式 (Minimal - bash + 编辑器)" },
                  { value: "cordis", label: "创造模式 (Cordis - 预设与插件编写)" },
                ],
                onChange: (val) => updateField("defaultPreset", val),
              }),
              React.createElement(TextField, {
                label: "新建会话默认工作目录",
                hint: "默认代码工作区路径，留空使用 DSH 当前工作目录",
                value: current.defaultCwd,
                placeholder: "留空使用当前目录",
                onChange: (val) => updateField("defaultCwd", val),
              }),
              React.createElement(SwitchRow, {
                label: "自动注册底部快捷菜单",
                hint: "启动连接就绪后自动调用 PUT /v2/menu 注册常用指令到 QQ 单聊界面底部",
                checked: current.autoRegisterMenu !== false,
                onChange: (val) => updateField("autoRegisterMenu", val),
              }),
              React.createElement(SwitchRow, {
                label: "优先 Markdown 消息回复",
                hint: "支持格式化高亮与代码块（若未申请 Markdown 权限则自动优雅降级为纯文本）",
                checked: current.markdown !== false,
                onChange: (val) => updateField("markdown", val),
              }),
              React.createElement(SwitchRow, {
                label: "同步工具调用执行进度",
                hint: "是否在 QQ 聊天中同步显示 Agent 执行的工具调用（默认关闭；开启后按时间窗口聚合推送，防止刷屏）",
                checked: Boolean(current.syncToolCalls),
                onChange: (val) => updateField("syncToolCalls", val),
              }),
              current.syncToolCalls
                ? React.createElement(TextField, {
                    label: "工具调用聚合时间窗口 (秒)",
                    hint: "指定在该时间窗口内的多次工具调用合并为一条摘要推送（默认 30 秒）",
                    type: "number",
                    value: Math.round((current.toolCallAggregateWindowMs || 30000) / 1000),
                    placeholder: "30",
                    onChange: (val) => {
                      const sec = Math.max(1, parseInt(val, 10) || 30);
                      updateField("toolCallAggregateWindowMs", sec * 1000);
                    },
                  })
                : null,
              React.createElement(
                "div",
                { className: "dsh-qq-footer" },
                saveStatus ? React.createElement("span", { className: "dsh-qq-status" }, saveStatus) : null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-qq-btn dsh-qq-btn-discard",
                    disabled: !isDirty || saving,
                    onClick: handleDiscard,
                  },
                  "放弃修改"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-qq-btn dsh-qq-btn-save",
                    disabled: !isDirty || saving,
                    onClick: handleSave,
                  },
                  saving ? "保存中..." : "保存设置"
                )
              )
            )
          : null
      );
    }

    function apply(ctx) {
      // Inject settingsScope from @deepseek-ai/dsh-client-ui-settings
      ctx.inject(["settingsScope"], (settingsCtx) => {
        const settings = settingsCtx.settingsScope.bind({
          namespace: SETTINGS_NAMESPACE,
        });

        // Register card into settings.plugin.item slot
        settingsCtx.slots.inject("settings.plugin.item", () => {
          return settingsCtx.slots.register(
            {
              name: "settings.plugin.item",
              id: "adapter-qq",
              key: SETTINGS_NAMESPACE,
              order: 35,
              inject: () => ({ settings }),
            },
            QQSettingsCard
          );
        });
      });
    }

    exports.name = "adapter-qq";
    exports.inject = ["slots"];
    exports.apply = apply;

    return module.exports;
};

if (typeof window !== "undefined" && window.__ModuleLoader__?.load) {
  window.__ModuleLoader__.load({
    id: "dsh-adapter-qq",
    factory,
  });
  window.__ModuleLoader__.load({
    id: "dsh-plugin-adapter-qq",
    factory,
  });
}
