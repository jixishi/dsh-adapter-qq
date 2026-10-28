# Changelog

All notable changes to `dsh-adapter-qq` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.0
