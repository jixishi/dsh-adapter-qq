/**
 * DeepSeek Harness QQ Bot Adapter - Client Side Settings Tab
 * Registers the "QQ 机器人" tab under Settings -> Plugins (settings.plugins.tab)
 * and edits the `adapter-qq` settings namespace through ctx.remote.settings.
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
      background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
      transition: border-color .16s ease, background .16s ease;
      margin-bottom: 8px;
    }
    .dsh-qq-card:hover {
      border-color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.25));
    }
    .dsh-qq-card-open {
      border-color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.25));
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
      color: var(--dsw-alias-label-secondary, #888);
    }
    .dsh-qq-badge {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      line-height: 16px;
      background: var(--dsw-alias-brand-primary, #4b70e2);
      color: var(--dsw-alias-bg-base, #fff);
    }
    .dsh-qq-chevron {
      flex: none;
      color: var(--dsw-alias-label-secondary, #888);
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
      color: var(--dsw-alias-label-secondary, #888);
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
      background: var(--dsw-alias-border-l2, rgba(255,255,255,0.2));
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
      background: var(--dsw-alias-bg-base, #fff);
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
      color: var(--dsw-alias-label-secondary, #888);
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
      border-color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.3));
    }
    .dsh-qq-btn-save {
      background: var(--dsw-alias-brand-primary, #4b70e2);
      color: var(--dsw-alias-bg-base, #fff);
      font-weight: 500;
    }
    .dsh-qq-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .dsh-qq-page {
      padding: 4px 2px 24px;
      max-width: 720px;
    }
    .dsh-qq-pagehead {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }
    .dsh-qq-pagetitle {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, inherit);
    }
    .dsh-qq-pagedesc {
      margin: 4px 0 16px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9));
    }
    .dsh-qq-notice {
      margin: 0 0 12px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.05));
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
    }
    .dsh-qq-notice-error {
      border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d05050) 55%, transparent);
      color: var(--dsw-alias-state-error-primary, #d05050);
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

    const SECRET_FIELDS = ["clientSecret", "token", "mcpManagerToken"];
    const isSecretValue = (value) => value !== null && typeof value === "object";

    /**
     * Adapt `ctx.remote.settings` to the tiny snapshot/mutate interface the form
     * below uses. DSH 0.2.1 settings tabs read and write through the Remote
     * namespace (`describe` / `mutate`) and refresh on
     * `settings/document-updated`.
     */
    function createRemoteSettings(ctx, namespace) {
      const listeners = new Set();
      let snapshot = { status: "loading", value: {}, revision: undefined, writable: false };
      let off = null;

      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            /* ignore one bad subscriber */
          }
        }
      };

      const load = async () => {
        try {
          if (!ctx.remote || !ctx.remote.settings || typeof ctx.remote.settings.describe !== "function") {
            throw new Error("当前 DSH 客户端不支持设置接口");
          }
          const result = await ctx.remote.settings.describe();
          if (!result || result.ok !== true) {
            throw new Error(result && result.error && result.error.message ? result.error.message : "读取设置失败");
          }
          const namespaces = (result.value && result.value.namespaces) || [];
          const view = namespaces.find((item) => item.ns === namespace);
          snapshot = {
            status: view ? "ready" : "missing",
            value: view && view.value && typeof view.value === "object" ? view.value : {},
            revision: view ? view.revision : undefined,
            writable: result.value ? result.value.writable !== false : false,
          };
        } catch (error) {
          snapshot = {
            status: "error",
            error: error && error.message ? error.message : String(error),
            value: {},
            revision: undefined,
            writable: false,
          };
        }
        emit();
      };

      void load();

      if (ctx.remote && typeof ctx.remote.$on === "function") {
        off = ctx.remote.$on("settings/document-updated", (changedNs) => {
          if (changedNs === namespace) void load();
        });
      }

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        mutate: async (ops) => {
          if (!ctx.remote || !ctx.remote.settings || typeof ctx.remote.settings.mutate !== "function") {
            throw new Error("当前 DSH 客户端不支持保存设置");
          }
          const result = await ctx.remote.settings.mutate(namespace, ops, snapshot.revision);
          if (!result || result.ok !== true) {
            throw new Error(result && result.error && result.error.message ? result.error.message : "保存失败");
          }
          await load();
        },
        dispose: () => {
          if (off) off();
          off = null;
          listeners.clear();
        },
      };
    }

    function QQSettingsPage(props) {
      const [settings] = React.useState(() => createRemoteSettings(props.ctx, SETTINGS_NAMESPACE));
      React.useEffect(() => () => settings.dispose(), [settings]);
      return React.createElement(QQSettingsCard, { asPage: true, settings });
    }

    function QQSettingsCard(props) {
      const asPage = props.asPage === true;
      const [open, setOpen] = React.useState(asPage);
      const [saving, setSaving] = React.useState(false);
      const [saveStatus, setSaveStatus] = React.useState("");
      const [draft, setDraft] = React.useState(null);

      const [snapshot, setSnapshot] = React.useState(() =>
        props.settings ? props.settings.getSnapshot() : { status: "ready", value: {} }
      );

      React.useEffect(() => {
        if (!props.settings) return undefined;
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
      const isDirty = draft !== null && Object.keys(draft).length > 0;
      const disabled = snapshot.writable === false;

      const textValue = (field) => {
        const value = current[field];
        return isSecretValue(value) ? "" : value == null ? "" : value;
      };

      const updateField = (field, val) => {
        setSaveStatus("");
        setDraft((prev) => ({ ...(prev || {}), [field]: val }));
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
          const ops = [];
          for (const [field, raw] of Object.entries(draft)) {
            if (SECRET_FIELDS.includes(field) && (raw === "" || isSecretValue(raw))) continue;
            let value = raw;
            if (field === "sessionPageSize") value = Math.min(6, Math.max(1, Number.parseInt(raw, 10) || 6));
            else if (field === "renderWidth") value = Math.min(1600, Math.max(480, Number.parseInt(raw, 10) || 900));
            else if (field === "toolCallAggregateWindowMs") value = Math.max(1000, (Number.parseInt(raw, 10) || 30) * 1000);
            else if (field === "renderTheme") value = raw === "dark" ? "dark" : "light";
            ops.push({ op: "set", path: [field], value });
          }
          if (ops.length === 0) {
            setSaveStatus("没有需要保存的修改");
            return;
          }
          await props.settings.mutate(ops);
          setDraft(null);
          setSaveStatus("✅ 保存成功，已热应用");
          setTimeout(() => setSaveStatus(""), 3000);
        } catch (error) {
          setSaveStatus(`❌ 保存失败: ${error && error.message ? error.message : String(error)}`);
        } finally {
          setSaving(false);
        }
      };

      const notice = (text, isError) =>
        React.createElement(
          "p",
          { className: `dsh-qq-notice${isError ? " dsh-qq-notice-error" : ""}` },
          text
        );

      const body = React.createElement(
        "div",
        { className: "dsh-qq-body" },
        snapshot.status === "missing"
          ? notice("没有找到 adapter-qq 设置项：请确认插件已启用并重启一次 DSH（host 半更新需要重启）。", true)
          : null,
        snapshot.status === "error" ? notice(`读取设置失败：${snapshot.error || "未知错误"}`, true) : null,
        snapshot.status === "loading" ? notice("正在读取设置…", false) : null,
        disabled ? notice("当前设置为只读，无法保存。", true) : null,
        React.createElement(SwitchRow, {
          label: "启用 QQ 机器人连接",
          hint: "开启后自动连接 QQ 开放平台 WebSocket Gateway",
          checked: current.enabled !== false,
          disabled,
          onChange: (val) => updateField("enabled", val),
        }),
        React.createElement(TextField, {
          label: "Bot AppID",
          hint: "QQ 开放平台机器人应用唯一 ID (q.qq.com 开发设置)",
          value: textValue("appId"),
          placeholder: "例如：102882069",
          disabled,
          onChange: (val) => updateField("appId", val),
        }),
        React.createElement(TextField, {
          label: "Bot AppSecret (开发者密钥)",
          hint: "QQ 开放平台开发者密钥（仅保存在本地设置；留空保持不变）",
          type: "password",
          value: textValue("clientSecret"),
          placeholder: "输入 AppSecret",
          disabled,
          onChange: (val) => updateField("clientSecret", val),
        }),
        React.createElement(SwitchRow, {
          label: "沙箱测试环境 (Sandbox)",
          hint: "机器人未正式上线发布前开启沙箱，并需在开放平台测试人员管理中添加您的 QQ 号",
          checked: Boolean(current.sandbox),
          disabled,
          onChange: (val) => updateField("sandbox", val),
        }),
        React.createElement(TextField, {
          label: "绑定用户 OpenID",
          hint: "专属私人用户的 OpenID（留空将在收到首条私聊消息时自动绑定）",
          value: textValue("userOpenid"),
          placeholder: "自动获取或手动填入",
          disabled,
          onChange: (val) => updateField("userOpenid", val),
        }),
        React.createElement(SelectRow, {
          label: "新建会话默认 Agent 预设",
          hint: "新建会话时默认使用的预设（可通过 QQ /preset 指令即时切换）",
          value: current.defaultPreset || "standard",
          options: [
            { value: "standard", label: "标准模式 (Standard - 全量工具)" },
            { value: "ptc", label: "PTC 模式 (TypeScript 组合执行)" },
            { value: "minimal", label: "极简模式 (Minimal - bash + 编辑器)" },
            { value: "cordis", label: "创造模式 (Cordis - 预设与插件编写)" },
          ],
          disabled,
          onChange: (val) => updateField("defaultPreset", val),
        }),
        React.createElement(TextField, {
          label: "新建会话默认工作目录",
          hint: "默认代码工作区路径，留空使用 DSH 当前工作目录",
          value: textValue("defaultCwd"),
          placeholder: "留空使用当前目录",
          disabled,
          onChange: (val) => updateField("defaultCwd", val),
        }),
        React.createElement(SwitchRow, {
          label: "自动注册底部快捷菜单",
          hint: "启动连接就绪后自动调用 PUT /v2/menu 注册常用指令到 QQ 单聊界面底部",
          checked: current.autoRegisterMenu !== false,
          disabled,
          onChange: (val) => updateField("autoRegisterMenu", val),
        }),
        React.createElement(SwitchRow, {
          label: "优先 Markdown 消息回复",
          hint: "支持格式化高亮与代码块（若未申请 Markdown 权限则自动降级为纯文本）",
          checked: current.markdown !== false,
          disabled,
          onChange: (val) => updateField("markdown", val),
        }),
        React.createElement(SwitchRow, {
          label: "同步 Web UI 提问到 QQ",
          hint: "将电脑端 Web UI 输入的提问推送到手机 QQ（默认关闭，避免频繁打扰）",
          checked: Boolean(current.syncWebQuestions),
          disabled,
          onChange: (val) => updateField("syncWebQuestions", val),
        }),
        React.createElement(SwitchRow, {
          label: "同步工具调用执行进度",
          hint: "在 QQ 中同步显示 Agent 的工具调用（默认关闭；开启后按时间窗口聚合，防刷屏）",
          checked: Boolean(current.syncToolCalls),
          disabled,
          onChange: (val) => updateField("syncToolCalls", val),
        }),
        current.syncToolCalls
          ? React.createElement(TextField, {
              label: "工具调用聚合时间窗口 (秒)",
              hint: "该窗口内的多次工具调用合并为一条摘要推送（默认 30 秒）",
              type: "number",
              value: Math.round((Number(current.toolCallAggregateWindowMs) || 30000) / 1000),
              placeholder: "30",
              disabled,
              onChange: (val) => updateField("toolCallAggregateWindowMs", val),
            })
          : null,
        React.createElement(SwitchRow, {
          label: "自动转发 Agent 回复中的图片/文件",
          hint: "Agent 回复里携带的图片、文件会通过 QQ 富媒体消息自动发送（关闭后仅发文字）",
          checked: current.autoSendAttachments !== false,
          disabled,
          onChange: (val) => updateField("autoSendAttachments", val),
        }),
        React.createElement(TextField, {
          label: "会话列表每页数量",
          hint: "QQ 操作板每页最多 6 个会话按键（默认 6）",
          type: "number",
          value: textValue("sessionPageSize") || 6,
          placeholder: "6",
          disabled,
          onChange: (val) => updateField("sessionPageSize", val),
        }),
        React.createElement(SelectRow, {
          label: "文本渲染主题",
          hint: "/render 与 qq_render_text_image 生成的图片配色",
          value: current.renderTheme || "light",
          options: [
            { value: "light", label: "浅色 (light)" },
            { value: "dark", label: "深色 (dark)" },
          ],
          disabled,
          onChange: (val) => updateField("renderTheme", val),
        }),
        React.createElement(TextField, {
          label: "渲染图片宽度 (像素)",
          hint: "480–1600，默认 900",
          type: "number",
          value: textValue("renderWidth") || 900,
          placeholder: "900",
          disabled,
          onChange: (val) => updateField("renderWidth", val),
        }),
        React.createElement(TextField, {
          label: "MCP 管理器访问令牌 (可选)",
          hint: "@xxxyz/dsh-mcp-manager 配置了 token 时填写，用于 QQ /mcp 启停；留空保持不变",
          type: "password",
          value: textValue("mcpManagerToken"),
          placeholder: "留空则读取 DSH_MCP_MANAGER_TOKEN",
          disabled,
          onChange: (val) => updateField("mcpManagerToken", val),
        }),
        React.createElement(
          "div",
          { className: "dsh-qq-footer" },
          saveStatus ? React.createElement("span", { className: "dsh-qq-status" }, saveStatus) : null,
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-qq-btn dsh-qq-btn-discard",
              disabled: !isDirty || saving || disabled,
              onClick: handleDiscard,
            },
            "放弃修改"
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-qq-btn dsh-qq-btn-save",
              disabled: !isDirty || saving || disabled,
              onClick: handleSave,
            },
            saving ? "保存中..." : "保存设置"
          )
        )
      );

      const header = asPage
        ? React.createElement(
            "div",
            { className: "dsh-qq-pagehead" },
            React.createElement("h2", { className: "dsh-qq-pagetitle" }, "QQ 机器人 (QQ Bot)"),
            isDirty ? React.createElement("span", { className: "dsh-qq-badge" }, "未保存") : null
          )
        : React.createElement(
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
          );

      const description = asPage
        ? React.createElement(
            "p",
            { className: "dsh-qq-pagedesc" },
            "QQ 开放平台官方单聊机器人适配器：C2C 交互、双向会话同步、富媒体收发、技能/MCP 管理与文本转图片。保存后立即热应用。"
          )
        : null;

      return React.createElement(
        asPage ? "div" : "li",
        { className: asPage ? "dsh-qq-page" : `dsh-qq-card${open ? " dsh-qq-card-open" : ""}` },
        header,
        description,
        asPage || open ? body : null
      );
    }

    function apply(ctx) {
      // DSH 0.2.1: plugin settings live as a tab under Settings -> Plugins
      // (`settings.plugins.tab`). The old `settingsScope` service and
      // `settings.plugin.item` slot no longer exist.
      ctx.effect(
        () =>
          ctx.slots.inject("settings.plugins.tab", () =>
            ctx.slots.register(
              {
                name: "settings.plugins.tab",
                id: SETTINGS_NAMESPACE,
                order: 60,
                label: () => "QQ 机器人",
              },
              (props) => React.createElement(QQSettingsPage, { ...(props || {}), ctx })
            )
          ),
        "adapter-qq: settings tab"
      );
    }

    exports.name = "adapter-qq";
    exports.inject = ["slots", "remote", "remote.settings"];
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
