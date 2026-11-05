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
    .dsh-qq-bind {
      margin: 0 0 6px;
      padding: 14px 16px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));
      border-radius: 12px;
      background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .dsh-qq-bind-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .dsh-qq-bind-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, inherit);
    }
    .dsh-qq-bind-desc {
      margin: 0;
      font-size: 12px;
      line-height: 1.6;
      color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9));
    }
    .dsh-qq-bind-qr {
      display: block;
      width: 220px;
      height: 220px;
      padding: 8px;
      border-radius: 10px;
      background: #fff;
      align-self: center;
    }
    .dsh-qq-bind-status {
      margin: 0;
      font-size: 12px;
      color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9));
      overflow-wrap: anywhere;
    }
    .dsh-qq-bind-error {
      margin: 0;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d05050) 55%, transparent);
      color: var(--dsw-alias-state-error-primary, #d05050);
    }
    .dsh-qq-bind-link {
      font-size: 12px;
      color: var(--dsw-alias-brand-primary, #4b70e2);
      overflow-wrap: anywhere;
    }
    `;

    // ---- 订阅管理侧栏面板样式 -------------------------------------------
    const subscriptionCss = `
    .dsh-sub-root {
      display: flex;
      flex-direction: column;
      gap: 10px;
      /* Fill the host pane when it has a definite height, and still degrade to
         normal document flow (page scroll) when the window is short. */
      flex: 1 1 auto;
      min-height: 0;
      max-height: 100%;
      overflow-y: auto;
      color: var(--dsw-alias-label-primary, #e8eaed);
      font-size: 13px;
    }
    .dsh-sub-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .dsh-sub-title { font-size: 14px; font-weight: 600; margin: 0; }
    .dsh-sub-count {
      font-size: 12px;
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
    }
    .dsh-sub-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .dsh-sub-btn {
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      padding: 5px 10px;
      border-radius: 7px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14));
      background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05));
      color: var(--dsw-alias-label-primary, #e8eaed);
      transition: border-color .16s ease, background .16s ease;
    }
    .dsh-sub-btn:hover:not(:disabled) {
      border-color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.3));
    }
    .dsh-sub-btn:disabled { opacity: .5; cursor: default; }
    .dsh-sub-btn-primary {
      background: var(--dsw-alias-label-primary, #e8eaed);
      color: var(--dsw-alias-bg-base, #16181d);
      border-color: transparent;
      font-weight: 600;
    }
    .dsh-sub-btn-danger {
      color: var(--dsw-alias-state-error-primary, #e5484d);
      border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 40%, transparent);
    }
    .dsh-sub-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow-y: auto;
      min-height: 0;
      /* Take the leftover height; when there is none it simply grows the page. */
      flex: 1 1 auto;
    }
    .dsh-sub-item {
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
      border-radius: 10px;
      padding: 9px 11px;
      background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .dsh-sub-item-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .dsh-sub-name {
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .dsh-sub-meta {
      font-size: 11px;
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      overflow-wrap: anywhere;
    }
    .dsh-sub-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16));
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      white-space: nowrap;
    }
    .dsh-sub-badge-active {
      color: var(--dsw-alias-brand-primary, #4b70e2);
      border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4b70e2) 45%, transparent);
    }
    .dsh-sub-badge-pending {
      color: var(--dsw-alias-state-warning-primary, #d9a300);
      border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d9a300) 45%, transparent);
    }
    .dsh-sub-item-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .dsh-sub-select {
      font: inherit;
      font-size: 12px;
      padding: 4px 7px;
      border-radius: 7px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16));
      background: var(--dsw-alias-bg-base, #16181d);
      color: var(--dsw-alias-label-primary, #e8eaed);
    }
    .dsh-sub-empty {
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      font-size: 12px;
      text-align: center;
      padding: 18px 8px;
      border: 1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,0.14));
      border-radius: 10px;
      line-height: 1.6;
    }
    .dsh-sub-error {
      color: var(--dsw-alias-state-error-primary, #e5484d);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .dsh-sub-hint {
      font-size: 11px;
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      line-height: 1.55;
    }
    .dsh-sub-add {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
      padding-top: 9px;
    }
    .dsh-sub-add-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      /* Scales with the window instead of a hard 190px. */
      max-height: clamp(140px, 32vh, 460px);
      overflow-y: auto;
    }
    .dsh-sub-group-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      /* Matches .dsh-sub-add-row's horizontal padding so labels line up. */
      padding: 10px 7px 4px;
      font-size: 12px;
      color: var(--dsw-alias-label-secondary, #c2c8d2);
      font-weight: 600;
      position: sticky;
      top: 0;
      background: var(--dsw-alias-bg-base, #16181d);
      z-index: 1;
    }
    .dsh-sub-group-head + .dsh-sub-add-row { border-top: none; }
    .dsh-sub-group-path {
      font-size: 10px;
      font-weight: 400;
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      overflow-wrap: anywhere;
    }
    .dsh-sub-time {
      font-size: 11px;
      color: var(--dsw-alias-label-tertiary, #9aa0aa);
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .dsh-sub-add-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 7px;
      border-radius: 7px;
      font-size: 12px;
    }
    .dsh-sub-add-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); }
    .dsh-sub-add-name { overflow-wrap: anywhere; line-height: 1.4; }
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

    /**
     * Same-origin call into the host's scan-to-bind API.
     * Failures carry the host's structured `{code,message,retcode,detail}`.
     */
    async function postOnboard(op, args = {}) {
      const response = await fetch("/dsh-adapter-qq/api", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-plugin": "dsh-adapter-qq" },
        body: JSON.stringify({ op, args }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        /* handled below */
      }
      if (!data) {
        const error = new Error(`扫码绑定接口返回非 JSON（HTTP ${response.status}）`);
        error.payload = { code: "BAD_RESPONSE", message: error.message };
        throw error;
      }
      if (!response.ok || data.ok !== true) {
        const payload = data.error || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` };
        const error = new Error(payload.message || "扫码绑定请求失败");
        error.payload = payload;
        throw error;
      }
      return data;
    }

    /**
     * Official QQ Bot scan-to-configure panel: create task -> show QR ->
     * poll until the phone confirms -> decrypt on the host -> save settings.
     */
    function QrBindPanel({ onBound }) {
      const [phase, setPhase] = React.useState("idle");
      const [qrDataUrl, setQrDataUrl] = React.useState("");
      const [url, setUrl] = React.useState("");
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState("");
      const timerRef = React.useRef(null);
      const taskRef = React.useRef("");
      const busyRef = React.useRef(false);
      const mountedRef = React.useRef(true);

      const stopPolling = React.useCallback((cancel) => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        if (cancel && taskRef.current) {
          const taskId = taskRef.current;
          taskRef.current = "";
          void postOnboard("onboard-cancel", { taskId }).catch(() => {});
        }
      }, []);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          stopPolling(true);
        };
      }, [stopPolling]);

      const finish = React.useCallback(
        async (data) => {
          stopPolling(false);
          if (!mountedRef.current) return;
          setPhase("completed");
          setNotice(
            `扫码成功：AppID ${data.appId || "(空)"}${data.userOpenid ? `，OpenID ${data.userOpenid}` : ""}，正在保存…`
          );
          try {
            await onBound(data);
            if (mountedRef.current) setNotice("✅ 扫码绑定成功，配置已保存");
          } catch (err) {
            if (!mountedRef.current) return;
            setPhase("error");
            setError(err.payload || { code: "SAVE_FAILED", message: err.message });
          }
        },
        [onBound, stopPolling]
      );

      const pollOnce = React.useCallback(async () => {
        if (busyRef.current || !taskRef.current) return;
        busyRef.current = true;
        try {
          const data = await postOnboard("onboard-poll", { taskId: taskRef.current });
          if (!mountedRef.current) return;
          if (data.status === "completed") {
            await finish(data);
          } else if (data.status === "expired") {
            stopPolling(false);
            taskRef.current = "";
            setPhase("expired");
            setNotice("二维码已过期，请重新生成。");
          } else {
            setNotice(data.status === "pending" ? "等待手机 QQ 扫码确认…" : "等待扫码…");
          }
        } catch (err) {
          if (!mountedRef.current) return;
          stopPolling(false);
          taskRef.current = "";
          setPhase("error");
          setError(err.payload || { code: "POLL_FAILED", message: err.message });
        } finally {
          busyRef.current = false;
        }
      }, [finish, stopPolling]);

      const start = React.useCallback(async () => {
        stopPolling(true);
        setError(null);
        setQrDataUrl("");
        setUrl("");
        setNotice("正在向 q.qq.com 申请绑定二维码…");
        setPhase("creating");
        try {
          const data = await postOnboard("onboard-create");
          if (!mountedRef.current) return;
          taskRef.current = data.taskId;
          setQrDataUrl(data.qrDataUrl || "");
          setUrl(data.url || "");
          setPhase("waiting");
          setNotice("请用手机 QQ 扫描二维码并确认授权。");
          timerRef.current = setInterval(() => {
            void pollOnce();
          }, Math.max(1000, Number(data.pollIntervalMs) || 2000));
        } catch (err) {
          if (!mountedRef.current) return;
          setPhase("error");
          setError(err.payload || { code: "CREATE_FAILED", message: err.message });
        }
      }, [pollOnce, stopPolling]);

      const errorText = error
        ? [
            `[${error.code || "ERROR"}] ${error.message || "未知错误"}`,
            error.retcode !== undefined ? `retcode=${error.retcode}` : "",
            error.detail ? `detail: ${error.detail}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";

      return React.createElement(
        "div",
        { className: "dsh-qq-bind" },
        React.createElement(
          "div",
          { className: "dsh-qq-bind-head" },
          React.createElement("span", { className: "dsh-qq-bind-title" }, "扫码绑定 QQ 机器人（官方）"),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-qq-btn dsh-qq-btn-save",
              onClick: () => {
                void start();
              },
              disabled: phase === "creating" || phase === "waiting",
            },
            phase === "waiting" ? "重新生成" : "生成绑定二维码"
          )
        ),
        React.createElement(
          "p",
          { className: "dsh-qq-bind-desc" },
          "用手机 QQ 扫描二维码并按提示确认，自动填入 AppID、AppSecret 与绑定 OpenID。密钥经 AES-256-GCM 加密回传，仅本机解密。"
        ),
        qrDataUrl
          ? React.createElement("img", { className: "dsh-qq-bind-qr", src: qrDataUrl, alt: "QQ 扫码绑定二维码" })
          : null,
        url
          ? React.createElement(
              "a",
              { className: "dsh-qq-bind-link", href: url, target: "_blank", rel: "noreferrer" },
              `或在手机 QQ 打开：${url}`
            )
          : null,
        notice ? React.createElement("p", { className: "dsh-qq-bind-status" }, notice) : null,
        errorText ? React.createElement("p", { className: "dsh-qq-bind-error" }, errorText) : null
      );
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
            else if (field === "streamIntervalMs") value = Math.min(10000, Math.max(500, Number.parseInt(raw, 10) || 1500));
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

      // Scan-to-bind result: write the credentials the host decrypted and reload.
      const handleBound = async (data) => {
        const patch = {
          appId: String(data.appId || ""),
          clientSecret: String(data.clientSecret || ""),
          userOpenid: String(data.userOpenid || ""),
          enabled: true,
        };
        const ops = Object.entries(patch)
          .filter(([, value]) => value !== "")
          .map(([field, value]) => ({ op: "set", path: [field], value }));
        if (ops.length === 0) throw new Error("扫码结果为空，未修改设置");
        await props.settings.mutate(ops);
        setDraft(null);
        setSaveStatus("✅ 扫码绑定成功，配置已保存");
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
        React.createElement(QrBindPanel, { onBound: handleBound }),
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
        React.createElement(SwitchRow, {
          label: "渲染图片后附加文字说明",
          hint: "默认关闭：/usage、/status、/tasks 发完图片后不再补发一条文字块",
          checked: current.sendOverviewCaption === true,
          disabled,
          onChange: (val) => updateField("sendOverviewCaption", val),
        }),
        React.createElement(SwitchRow, {
          label: "启用流式回复",
          hint: "开启后按增量推送回复文字（长回复更快看到开头）；关闭则只在结束时一次性发送完整回复",
          checked: current.streamReply === true,
          disabled,
          onChange: (val) => updateField("streamReply", val),
        }),
        React.createElement(TextField, {
          label: "流式推送间隔（毫秒）",
          hint: "仅在启用流式回复时生效，范围 500–10000，默认 1500",
          type: "number",
          value: textValue("streamIntervalMs") || 1500,
          placeholder: "1500",
          disabled,
          onChange: (val) => updateField("streamIntervalMs", val),
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
          label: "会话列表路径显示",
          hint: "工作区路径显示完整路径，或只显示最后一级文件夹名",
          value: current.sessionPathDisplay === "full" ? "full" : "tail",
          options: [
            { value: "tail", label: "仅最后一级文件夹（默认）" },
            { value: "full", label: "完整路径" },
          ],
          disabled,
          onChange: (val) => updateField("sessionPathDisplay", val),
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

    // ---- 订阅管理面板（侧栏右栏 Tab） ---------------------------------------

    /** Same-origin call into the host's subscription API. */
    async function postSubscriptions(op, args = {}) {
      const response = await fetch("/dsh-adapter-qq/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsh-plugin": "dsh-adapter-qq",
        },
        body: JSON.stringify({ op, args }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        /* handled below */
      }
      if (!data) {
        const error = new Error(`订阅接口返回非 JSON（HTTP ${response.status}）`);
        error.payload = { code: "BAD_RESPONSE", message: error.message };
        throw error;
      }
      if (!response.ok || data.ok !== true) {
        const payload = data.error || {
          code: `HTTP_${response.status}`,
          message: `HTTP ${response.status}`,
        };
        const error = new Error(payload.message || "订阅操作失败");
        error.payload = payload;
        throw error;
      }
      return data;
    }

    /**
     * 订阅管理：已订阅会话列表 + 新增订阅 + 取消 + 汇聚间隔调整。
     * 数据全部来自宿主 HTTP 接口，浏览器不直接读写磁盘。
     */
    function SubscriptionPane(props) {
      // The settings tab injects its own stylesheet, but this pane may be the
      // only thing the user ever opens, so it injects its own set.
      React.useEffect(() => {
        injectStyles("dsh-qq-subscription-styles", subscriptionCss);
      }, []);
      const [state, setState] = React.useState({
        loading: true,
        error: "",
        busy: "",
        subscriptions: [],
        sessions: [],
        intervals: [1, 5, 15, 30, 60],
        defaultInterval: 5,
        pending: 0,
        activeSessionId: "",
        workspaceGroups: [],
        showAdd: false,
      });

      const mountedRef = React.useRef(true);

      const patch = React.useCallback((next) => {
        if (!mountedRef.current) return;
        setState((prev) => ({ ...prev, ...next }));
      }, []);

      const refresh = React.useCallback(
        async (options = {}) => {
          if (options.quiet !== true) patch({ loading: true, error: "" });
          try {
            const data = await postSubscriptions("list");
            patch({
              loading: false,
              error: "",
              subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
              sessions: Array.isArray(data.sessions) ? data.sessions : [],
              intervals: Array.isArray(data.intervals) ? data.intervals : [1, 5, 15, 30, 60],
              defaultInterval: Number(data.defaultInterval) || 5,
              pending: Number(data.pending) || 0,
              activeSessionId: data.activeSessionId || "",
              workspaceGroups: Array.isArray(data.workspaceGroups) ? data.workspaceGroups : [],
            });
          } catch (error) {
            patch({ loading: false, error: error.message || String(error) });
          }
        },
        [patch]
      );

      React.useEffect(() => {
        mountedRef.current = true;
        void refresh();
        // Poll so a message flushed by the scheduler shows up without a manual
        // reload. 20s is well under the smallest interval (1 min).
        const timer = window.setInterval(() => {
          void refresh({ quiet: true });
        }, 20000);
        return () => {
          mountedRef.current = false;
          window.clearInterval(timer);
        };
      }, [refresh]);

      const run = React.useCallback(
        async (label, op, args) => {
          patch({ busy: label, error: "" });
          try {
            await postSubscriptions(op, args);
            await refresh({ quiet: true });
            patch({ busy: "" });
            return true;
          } catch (error) {
            patch({ busy: "", error: error.message || String(error) });
            return false;
          }
        },
        [patch, refresh]
      );

      const intervalOptions = state.intervals;

      const header = React.createElement(
        "div",
        { className: "dsh-sub-head" },
        React.createElement("h3", { className: "dsh-sub-title" }, "会话订阅"),
        React.createElement(
          "span",
          { className: "dsh-sub-count" },
          `${state.subscriptions.length} 个订阅${state.pending > 0 ? ` · ${state.pending} 条待推送` : ""}`
        )
      );

      const actions = React.createElement(
        "div",
        { className: "dsh-sub-actions" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sub-btn",
            disabled: state.loading || state.busy !== "",
            onClick: () => void refresh(),
          },
          state.loading ? "刷新中…" : "刷新"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sub-btn dsh-sub-btn-primary",
            disabled: state.busy !== "",
            onClick: () => patch({ showAdd: !state.showAdd }),
          },
          state.showAdd ? "收起新增" : "新增订阅"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sub-btn",
            disabled: state.busy !== "" || state.pending === 0,
            title: "立即把待推送的消息合并发送，不必等间隔到期",
            onClick: () => void run("flush", "flush", {}),
          },
          "立即推送"
        )
      );

      const errorNode = state.error
        ? React.createElement("div", { className: "dsh-sub-error" }, `⚠️ ${state.error}`)
        : null;

      const listNode =
        state.subscriptions.length === 0
          ? React.createElement(
              "div",
              { className: "dsh-sub-empty" },
              state.loading
                ? "正在读取订阅…"
                : "还没有订阅任何会话。点击「新增订阅」选择一个非活跃会话，后台有新消息时会按汇聚间隔推送摘要。"
            )
          : React.createElement(
              "ul",
              { className: "dsh-sub-list" },
              ...state.subscriptions.map((item, index) => {
                const isActive = item.sessionId === state.activeSessionId;
                const pending = Number(item.pendingCount) || 0;
                return React.createElement(
                  "li",
                  { className: "dsh-sub-item", key: item.sessionId || `sub-${index}` },
                  React.createElement(
                    "div",
                    { className: "dsh-sub-item-head" },
                    React.createElement(
                      "span",
                      { className: "dsh-sub-name" },
                      item.title || item.sessionId
                    ),
                    React.createElement(
                      "span",
                      { className: "dsh-sub-meta" },
                      isActive
                        ? React.createElement("span", { className: "dsh-sub-badge dsh-sub-badge-active" }, "活跃")
                        : null,
                      pending > 0
                        ? React.createElement(
                            "span",
                            { className: "dsh-sub-badge dsh-sub-badge-pending" },
                            `待推 ${pending}`
                          )
                        : null
                    )
                  ),
                  React.createElement(
                    "div",
                    { className: "dsh-sub-meta" },
                    React.createElement("span", null, `间隔 ${item.intervalLabel || `${item.intervalMinutes} 分钟`}`),
                    item.totalNotified > 0
                      ? React.createElement("span", null, `累计已推送 ${item.totalNotified} 条`)
                      : null,
                    React.createElement("span", null, item.sessionId),
                    item.updatedLabel
                      ? React.createElement(
                          "span",
                          { className: "dsh-sub-time", title: "最近活跃时间" },
                          item.updatedLabel
                        )
                      : null
                  ),
                  React.createElement(
                    "div",
                    { className: "dsh-sub-item-actions" },
                    React.createElement(
                      "label",
                      { className: "dsh-sub-hint" },
                      "汇聚间隔 "
                    ),
                    React.createElement(
                      "select",
                      {
                        className: "dsh-sub-select",
                        value: String(item.intervalMinutes),
                        disabled: state.busy !== "",
                        onChange: (event) =>
                          void run(
                            `interval-${item.sessionId}`,
                            "setInterval",
                            { sessionId: item.sessionId, intervalMinutes: Number(event.target.value) }
                          ),
                      },
                      ...intervalOptions.map((minutes) =>
                        React.createElement(
                          "option",
                          { value: String(minutes), key: String(minutes) },
                          minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`
                        )
                      )
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "dsh-sub-btn dsh-sub-btn-danger",
                        disabled: state.busy !== "",
                        onClick: () => {
                          const name = item.title || item.sessionId;
                          if (typeof window !== "undefined" && typeof window.confirm === "function") {
                            if (!window.confirm(`确定取消订阅「${name}」？`)) return;
                          }
                          void run(`off-${item.sessionId}`, "unsubscribe", { sessionId: item.sessionId });
                        },
                      },
                      state.busy === `off-${item.sessionId}` ? "取消中…" : "取消订阅"
                    )
                  )
                );
              })
            );

      // Group by workspace so the picker mirrors the left sidebar's structure.
      const availableWorkspaceSections = (() => {
        const available = state.sessions.filter((item) => !item.subscribed);
        const groups = state.workspaceGroups
          .map((group) => ({
            ...group,
            sessions: (group.sessions || []).filter((item) => item && !item.subscribed),
          }))
          .filter((group) => group.sessions.length > 0);
        // Fall back to a single ungrouped section when the host sent no groups.
        if (groups.length === 0 && available.length > 0) {
          return [{ key: "__all__", label: "全部会话", sessions: available }];
        }
        return groups;
      })();

      const addNode = state.showAdd
        ? (() => {
            const available = state.sessions.filter((item) => !item.subscribed);
            return React.createElement(
              "div",
              { className: "dsh-sub-add" },
              React.createElement(
                "div",
                { className: "dsh-sub-hint" },
                available.length === 0
                  ? "所有会话都已订阅。"
                  : `选择要订阅的会话（共 ${available.length} 个可选）：`
              ),
              available.length === 0
                ? null
                : React.createElement(
                    "div",
                    { className: "dsh-sub-add-list" },
                    ...availableWorkspaceSections.map((group) =>
                      React.createElement(
                        "div",
                        { key: group.key },
                        React.createElement(
                          "div",
                          { className: "dsh-sub-group-head" },
                          React.createElement("span", null, group.label),
                          React.createElement(
                            "span",
                            { className: "dsh-sub-group-path" },
                            group.sessions.length > 1 ? `${group.sessions.length} 个会话` : ""
                          )
                        ),
                        ...group.sessions.map((item) =>
                          React.createElement(
                            "div",
                            { className: "dsh-sub-add-row", key: item.sessionId },
                            React.createElement(
                              "span",
                              { className: "dsh-sub-add-name" },
                              item.title || item.sessionId,
                              item.active ? " (当前活跃)" : "",
                              item.running ? " · 运行中" : ""
                            ),
                            React.createElement(
                              "span",
                              { className: "dsh-sub-time", title: `最近活跃：${item.updatedLabel || "未知"}` },
                              item.updatedLabel || ""
                            ),
                            React.createElement(
                              "button",
                              {
                                type: "button",
                                className: "dsh-sub-btn",
                                disabled: state.busy !== "",
                                onClick: () =>
                                  void run(`add-${item.sessionId}`, "subscribe", {
                                    sessionId: item.sessionId,
                                    title: item.title || "",
                                    intervalMinutes: state.defaultInterval,
                                  }).then((ok) => {
                                    if (ok) patch({ showAdd: false });
                                  }),
                              },
                              state.busy === `add-${item.sessionId}` ? "添加中…" : "订阅"
                            )
                          )
                        )
                      )
                    )
                  ),
              React.createElement(
                "div",
                { className: "dsh-sub-hint" },
                "提示：订阅当前活跃会话没有意义——它的消息本来就会实时同步。订阅用于跟进后台/其它会话。"
              )
            );
          })()
        : null;

      const hint = React.createElement(
        "div",
        { className: "dsh-sub-hint" },
        "后台会话的新消息会先累积，到间隔后合并成一条摘要推送；也可在 QQ 里用 /subscribe、/subscriptions、/reply 管理。"
      );

      return React.createElement(
        "div",
        { className: "dsh-sub-root" },
        header,
        actions,
        errorNode,
        listNode,
        addNode,
        hint
      );
    }

    /**
     * 左侧导航栏的入口图标（`sidebar.panellist` 行）。
     * 这一行就是 Logcat / 插件 / 远程工作区 所在的那排竖排入口。
     */
    function SubscriptionSidebarIcon(props) {
      // Match the built-in sidebar glyphs: a monochrome stroked SVG that inherits
      // the row's colour via `currentColor`, at the host-provided size. An emoji
      // here is the one coloured icon in a column of line icons, which looks
      // out of place and cannot follow the theme.
      const size = Number(props && props.size) > 0 ? Number(props.size) : 16;
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        // A bell: dome, clapper, and the small hanger loop.
        React.createElement("path", {
          d: "M3.6 6.4a4.4 4.4 0 0 1 8.8 0v2.3l1.1 1.9a.6.6 0 0 1-.5.9H3a.6.6 0 0 1-.5-.9l1.1-1.9z",
        }),
        React.createElement("path", { d: "M6.5 13a1.7 1.7 0 0 0 3 0" })
      );
    }

    /**
     * 订阅管理的中央面板（`main` 槽，key 与 sidebar.panellist 的 id 相同）。
     * 与侧栏入口成对注册：点左栏图标即在此展示。
     */
    function SubscriptionMainPanel(props) {
      return React.createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            // Let the height come from the host pane and the viewport. A fixed
            // `height:100%` here clipped the content when the window was short;
            // `overflow:hidden` made the clipped part unreachable.
            flex: "1 1 auto",
            minHeight: 0,
            maxHeight: "100%",
            overflowY: "auto",
            padding: "18px 22px 14px",
            boxSizing: "border-box",
          },
        },
        React.createElement(SubscriptionPane, props || {})
      );
    }

    const SUBSCRIPTION_PANEL_ID = "adapter-qq-subscriptions";

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

      // 订阅管理：注册到**左侧导航栏**（sidebar.panellist + main 成对，
      // 与 Logcat / 插件 / 远程工作区 同一排）。
      //   sidebar.panellist -> 左栏那一行图标+标签，id 决定选中态
      //   main              -> 该入口的面板正文，key 必须等于上面的 id
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: SUBSCRIPTION_PANEL_ID,
                order: 120,
                label: "订阅管理",
              },
              SubscriptionSidebarIcon
            )
          ),
        "adapter-qq: sidebar entry"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("main", () =>
            ctx.slots.register(
              { name: "main", key: SUBSCRIPTION_PANEL_ID },
              SubscriptionMainPanel
            )
          ),
        "adapter-qq: subscription panel body"
      );
    }

    exports.name = "adapter-qq";
    // The subscription panel rides on the plain `slots` service
    // (sidebar.panellist + main), so no extra required service is declared.
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
