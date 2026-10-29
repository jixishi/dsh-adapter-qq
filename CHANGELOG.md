# Changelog

All notable changes to `dsh-adapter-qq` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.2] - 2026-10-29

### Added

- `sessionPathDisplay` setting (`tail` | `full`, default `tail`): the session
  list can show either the last folder of a workspace path or the full path.
  Exposed as "会话列表路径显示" in the settings tab.
- `/status` (`/状态`, `/代理`): a Typst-rendered image of the main agent, team
  members or plain subagents, and running background jobs.
- `/tasks` (`/任务`, `/任务管理`, `/schedule`): a Typst-rendered image of the
  host's scheduled/automation tasks (`ctx.schedule.catalog()`), including rule,
  status, planned time and bound session.
- `/jobs` (`/后台任务`): running background jobs; only registered/listed when
  the official persistent terminal (`@deepseek-ai/dsh-terminal`, `ctx.terminals`)
  is enabled. Menu/help entries adapt to the detected official plugins.

### Changed

- Session list now shows readable preset/permission names instead of raw ids:
  `standard` → 标准模式, `ptc` → PTC 模式, `minimal` → 极简模式,
  `cordis` → 创造模式; `read-only` → 只读, `workspace-write` → 工作区写入,
  `danger-full-access` → 全系统. Custom presets fall back to their DSH name.
- When Agent Teams is enabled, `/status` renders its roster (Lead + teammates,
  role and live status); without it, plain `ctx.subagents` children are shown.
- Session list groups all sessions of one workspace into a single `>` quote
  block, with a blank line before the block so QQ's Markdown parser renders it
  as a quote instead of literal `>` characters.
- `/current` and `/status` now map preset/permission ids to readable names
  (`unknown` → 未知), and `/status` maps `idle` to 💤 空闲.
- Persistent-terminal detection also checks the live Agent context, the
  `terminal_send`/`terminal_open` tools, and finally the Loader tree /
  `pluginInventory` — because `@deepseek-ai/dsh-terminal` lives in
  `isolate: { terminals: true }` and is invisible to the host context.
- Cold sessions now derive their permission preset from the persisted
  `permissions` session projection (`permissionPresets.derive()`), so the
  session list no longer shows 未知 for sessions without a live Agent.
- Optional usage-billing integration: when `@kenz1117/dsh-ui-usage-billing` is
  installed, `/usage` (用量/费用/账单) is auto-registered, reads the loopback
  `GET /api/billing/usage-stats`, and renders today/month/total cost plus
  model/site tops as a Typst image; the bottom menu and `/help` add the entry
  only when the plugin is detected.
- `/usage` now renders a dedicated Typst layout instead of generic Markdown:
  rounded stat cards for today/month/total, an optional budget progress bar,
  per-model/site share bars, zebra tables, cleaned site names (`site:` host
  only, `direct:` provider labels) and light/dark palettes. The README example
  is `docs/images/usage-billing.png`.
- Docs: refreshed `docs/images/workspace-sessions.png` with the quote-block
  hierarchy and added `docs/images/agent-status.png` for `/status`.
- CI: `.github/workflows/publish.yml` publishes on `v*` tags (and manual
  dispatch) to npmjs (`dsh-adapter-qq`) and GitHub Packages
  (`@<owner>/dsh-adapter-qq`), with tag/version validation, duplicate-version
  skipping, and a scoped tarball prepared by
  `.github/scripts/prepare-gh-package.mjs`.
- Tests: 271 total (270 pass, 1 skipped), covering path modes, label fallbacks,
  schedule formatting, team/job capability gating, isolated-terminal detection
  via Agent context/tools/Loader inventory, cold-session permission derivation,
  usage-billing detection/fetch/format, the dedicated Typst usage card, and conditional menu items.

## [0.2.1] - 2026-10-28

### Added

- **Official scan-to-bind (扫码绑定)**: the settings tab can create a q.qq.com
  bind task (`/lite/create_bind_task`), render its `openclaw/connect.html`
  QR code, poll `/lite/poll_bind_result`, and decrypt `bot_encrypt_secret` with
  the local AES-256-GCM key (IV 12 B, tag 16 B). A confirmed scan fills AppID,
  AppSecret and the scanner's OpenID and saves them.
- Same-origin host API `POST /dsh-adapter-qq/api` (`onboard-create`,
  `onboard-poll`, `onboard-cancel`) guarded by the `x-dsh-plugin:
  dsh-adapter-qq` header; the AES key stays in the host process.
- Every failure returns a structured `{ ok:false, error:{ code, message,
  retcode?, detail?, status? } }`; the settings panel renders the code, message,
  q.qq.com retcode and detail instead of failing silently.

### Changed

- New dependency `qrcode` (host-side QR data URL for the binding panel).
- Test suite: 11 scan-to-bind cases (protocol, AES-GCM round trip, portal
  errors, task expiry, route guard) — 248 total, 247 pass, 1 skipped.

## [0.2.0] - 2026-10-28

Targets **DeepSeek Harness 0.2.1-rc.3** (`engines.dsh: >=0.2.1-rc.3 <0.3.0`).

### Added

- **Embedded Typst 0.15 renderer** (`lib/render/typst.js`): official Typst CLI
  binary plus two bundled fonts — LXGW Neo XiHei (霞鹜新晰黑) and Google Noto
  Color Emoji — rendering CJK and full-colour emoji in one pass (PNG at 2x,
  ppi 192). Engine order: Typst → headless Edge/Chrome → Pillow → SVG.
- `qq_render_text_image` agent tool: render Markdown/plain text to a PNG, send it
  to the bound QQ user by default, return path/size/engine/message id.
- `qq_send_file` agent tool: send a local file or base64 payload as a QQ image
  or file card (real bytes sniffed before upload).
- Outbound rich media: `/v2/users/{openid}/files` upload (≤5 MB inline, larger
  files chunked via `upload_prepare` → presigned PUT → `upload_part_finish` →
  merge) and `msg_type=7` delivery; `/send <path>` command; assistant replies
  with image/file blocks are forwarded automatically (`autoSendAttachments`).
- Skills menu (`/skills`, `/skill`, enable/disable) and MCP menu (`/mcp`,
  enable/disable/restart), backed by `@xxxyz/dsh-mcp-manager`'s HTTP API with a
  read-only fallback when it is absent.
- Session list pagination (`sessionPageSize`, default 6) with a distinct emoji
  marker per session on the current page; emoji appended after the session name
  in the card text; `/switch <index|emoji|id|title>` selection.
- Multi-question wizard and multi-select questions: one card per question,
  toggled selections, explicit submit, and a complete per-question answer batch
  (`/answer <id> A,B` also supported).
- Settings tab **设置 → 插件 → QQ 机器人** (`settings.plugins.tab`) with all
  connection, attachment, pagination, render and MCP-manager options.

### Fixed

- DSH 0.2.1-rc.3 compatibility: `SessionPromptRequest.mode` is now
  `queue`/`steer`; `approval/request` and `user-questions/request` carry a bare
  `agent.id`; permission lists use `permissionPresets.catalog()`; titles read
  from `sessionTitle`/`sessionQuery`; the plugin uses the object plugin shape
  (named `apply` + exported `Config`) so settings are projected.
- `Declared image type does not match its bytes.` on forwarded QQ images: the
  real format is sniffed from magic bytes (png/jpeg/gif/webp), and unsupported
  formats (bmp/avif/tiff) are saved to the workspace as files with a note.
- QQ question cards were never delivered: the core Web-UI forwarder is
  registered first and holds the waterfall, so both answerers now register with
  Cordis `prepend` and race the browser through `next()`.
- Settings could not be saved (`Plugin entry "adapter-qq" has no volatile
  fields`): every Config field is declared `.volatile()` and read through live
  refs, with a `settings/document-updated` listener plus a 2 s fingerprint
  safety poll for hot reconnect.
- Settings tab used removed 0.2.1 client APIs (`settingsScope`,
  `settings.plugin.item`); it now writes through `ctx.remote.settings`.
- Theme adaptation: only documented `--dsw-alias-*` tokens, with contrasting
  button/switch text in light and dark themes.
- Pillow fallback no longer draws tofu boxes for emoji (markers like `[OK]`,
  text replacements, remaining emoji stripped).
- Uploads never overwrite an existing file; the bridge picks a unique name.

### Changed

- `package.json`: version 0.2.0; `engines.dsh >=0.2.1-rc.3 <0.3.0`;
  `@deepseek-ai/schemastery` is a runtime dependency, new dependencies
  `@flukxr/typst-cli`, `@fontpkg/lxgw-neo-xi-hei`, `noto-color-emoji`.
- New settings: `sessionPageSize`, `autoSendAttachments`, `renderWidth`,
  `renderTheme`, `mcpManagerToken`.
- Test suite expanded to 237 cases covering the API client, media layer,
  keyboards/emoji, session pagination, gateway, approvals/questions, bridge,
  render engines, Typst, inventory and both agent tools.

[0.2.2]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.2
[0.2.1]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.1
[0.2.0]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.0
