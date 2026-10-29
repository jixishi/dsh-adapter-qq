# dsh-adapter-qq

[![Cordis](https://img.shields.io/badge/Cordis-Plugin-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![QQ Open Platform](https://img.shields.io/badge/QQ%20Open%20Platform-OpenAPI%20v2-green.svg)](https://bot.q.qq.com/wiki/develop/api-v2/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.2-blue.svg)](CHANGELOG.md)

`dsh-adapter-qq` 是针对 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 深度定制的 **QQ 官方机器人（C2C 单聊模式）适配器插件**。

通过本插件，你可以在手机或桌面 QQ 聊天窗口中直接与 DSH Agent 进行完整对话，享受 DSH 的全量编码与执行能力（文件读写、Shell 执行、代码运行、子代理、多步规划、工作流），并实现与 **DSH Web UI 实时双向同屏联动**。

> **当前插件版本：0.2.2**。本次更新：会话列表路径可按配置显示**完整路径或仅最后一级文件夹**（`sessionPathDisplay`），会话名后的**预设/权限改为可读名称**；新增 **`/status` 代理与后台任务图**、**`/tasks` 任务管理图**，并在启用官方持久终端时自动注册 **`/jobs`**；安装 `@kenz1117/dsh-ui-usage-billing` 时自动注册 **`/usage` 用量查询**。0.2.1 起支持 **官方扫码绑定**：设置 → 插件 → QQ 机器人 → 「生成绑定二维码」，手机 QQ 扫码后自动填入 AppID / AppSecret / 绑定 OpenID；任何失败都会返回并在界面展示 `code` / `message` / `retcode` / `detail`，不再静默失败。详见 [CHANGELOG.md](./CHANGELOG.md)。
>
> **兼容性**：面向 **DSH 0.2.1-rc.3**（`engines.dsh: >=0.2.1-rc.3 <0.3.0`），Node.js ≥ 20。
> 已适配 DSH 0.2.1 的 `SessionPromptRequest.mode`（`queue`/`steer`）、`ApprovalRequestEvent.agent`、`permissionPresets.catalog()`、`skills` 服务与 `sessionTitle`/`sessionQuery` 标题读取；旧版本 DSH 不再保证兼容。

---

## 🌟 核心特性

- 📱 **QQ 官方 OpenAPI v2**：基于 WebSocket Gateway 长连接（接收 `C2C_MESSAGE_CREATE` 与 `INTERACTION_CREATE`）+ OpenAPI HTTP 发送消息，无需第三方逆向协议，稳定合规。
- 🔄 **实时双向同屏同步**：
  - 在 QQ 中提问，Web UI 对应会话实时展现提问并同步生成结果。
  - 在 Web UI 中提问或执行操作，QQ 端实时推送同步进展与回复。
- 🚦 **双向审批联动（Approval Waterfall）**：
  - 遇到超权限操作（如文件修改、系统命令等）时，审批卡片**同时推送至 QQ 与 Web UI**。
  - 支持在 QQ 交互按钮上一键点击 `[允许 (本次)]` 或 `[拒绝]`，两端任一端处理立即同步结算。
- ❓ **多问题 / 多选提问支持**：
  - `ask_user_question` 一次提交多个问题时按「第 1/3 题」向导逐题作答，全部答完后一次性提交完整答案批次（修复「连续多个提问只收到第一个」）。
  - 多选题显示 `✅` 选中状态，可反复点选、`🗑️ 清空`，或直接回复 `/answer <ID> A,B`，最后点 `✅ 提交选择`。
- 🎮 **交互式操作板（InlineKeyboard）**：
  - 支持在聊天中生成交互式按钮面板，一键切换会话、选择预设、切换权限，无需繁琐输入。
- 🗂️ **分页会话列表 + emoji 会话标识**：
  - 会话列表跨工作区展平分页（默认每页 6 个，可配置），每页内为每个会话分配**互不重复的 emoji**（🍎🍊🍋…）作为按键标识，列表里在会话名后附加同一 emoji。
  - 工作区路径可按配置显示**完整路径**或**仅最后一级文件夹**（`sessionPathDisplay`，默认 `tail`）。
  - 同一工作区下的会话合并为一个 **`>` 引用块**，形成「工作区 → 会话」的层级；会话名后的预设/权限使用可读名称（如 `标准模式` / `工作区写入`），不再直接显示 `standard` / `workspace-write` 这类 ID；自定义预设仍显示其 DSH 名称。
  - `/current` 的预设/权限同样使用可读名称。
  - 支持点击按键、`/switch <序号>`、`/switch <emoji>`、`/switch <标题关键字>` 三种切换方式。
- 🧭 **任务与代理状态图片（Typst 渲染）**：
  - `/status`（`/状态`、`/代理`）：一张图查看**主代理**状态（标题/模型/预设/权限/目录）、团队成员或子代理状态，以及正在进行的后台任务。
  - `/tasks`（`/任务`、`/任务管理`）：一张图查看 DSH「任务」页的定时/自动化任务（规则、状态、计划时间、绑定会话）。
  - `/jobs`（`/后台任务`）：仅在启用官方持久终端（`@deepseek-ai/dsh-terminal`）时自动注册，查看运行中的后台任务。
  - 官方团队插件（Agent Teams）启用时，`/status` 使用其 roster 渲染 Lead/成员角色与状态；未启用时回退到普通子代理列表。
  - 示例（主代理 + 团队成员 + 后台任务）：
    <img src="docs/images/agent-status.png" width="480" alt="代理与后台任务状态图" />
- 💰 **用量计费联动（可选）**：
  - 检测到 `@kenz1117/dsh-ui-usage-billing` 时自动注册 `/usage`（`/用量`、`/费用`、`/账单`），读取本机 `GET /api/billing/usage-stats`，用专用 Typst 卡片渲染费用总览、预算进度、模型/站点占比。
  - 未安装时发送 `/usage` 会提示安装方式；底部菜单与 `/help` 仅在检测到该插件时加入「用量」入口。
  - 示例：<img src="docs/images/usage-billing.png" width="480" alt="用量与费用卡片" />
- 🖼️ **富媒体收发（图片 / 文件）**：
  - 入站：QQ 转发的图片按**字节魔数**识别真实格式（png/jpeg/gif/webp），修复 `Declared image type does not match its bytes.`；文件自动保存到会话 `uploads/` 并把文本预览/路径交给 Agent。
  - 出站：`/send <路径>`、Agent 回复中的图片/文件、以及 `qq_send_file` 工具均可通过官方富媒体接口（`/v2/users/{openid}/files` + `msg_type=7`）发回 QQ，支持 ≤5MB 直传与 >5MB 分片上传。
- 🧠 **技能管理菜单（/skills）**：
  - 聚合 DSH 技能列表（名称、来源、可调用性、停用状态），支持查看详情与**启停**（启停通过 `@xxxyz/dsh-mcp-manager` 的能力；该插件未安装时自动降级为只读列表）。
- 🔌 **MCP 管理菜单（/mcp）**：
  - 列出 MCP 服务（传输方式、层级、加载状态、工具数），支持查看工具清单、**启停与重启**；未安装 MCP 管理器时按工具注册表降级展示。
- 🖨️ **文本一键渲染为图片（内嵌 Typst）**：
  - `/render [文本]` 把文本/Markdown 渲染为图片发回 QQ（无参数时渲染最近一条 Agent 回复）。
  - 注册 Agent 工具 **`qq_render_text_image`** 与 **`qq_send_file`**，模型可主动调用。
  - 渲染引擎优先级：**内嵌 Typst 0.15（LXGW Neo XiHei + Noto Color Emoji，全彩 Emoji/CJK 原生混排）** → 本机 Edge/Chrome 无头单次截图 → Pillow → 纯 SVG。
  - Typst 与两个字体随插件依赖内嵌（`@flukxr/typst-cli`、`@fontpkg/lxgw-neo-xi-hei`、`noto-color-emoji`），无需系统安装；单次排版+光栅化约 30ms 引擎耗时。
- 🔗 **官方扫码绑定（扫码配置）**：
  - 设置页提供「生成绑定二维码」，走 `q.qq.com` 官方 bind-task 协议：`/lite/create_bind_task` → 手机 QQ 扫描 `connect.html?task_id=…` → `/lite/poll_bind_result` 轮询。
  - 扫码确认后自动填入 **AppID / AppSecret / 绑定用户 OpenID** 并保存；`bot_encrypt_secret` 用本地生成的 AES-256-GCM 密钥加密回传，仅本机解密，密钥不出进程。
  - 所有失败都返回结构化错误（`code` / `message` / `retcode` / `detail`）并显示在设置页，便于定位 q.qq.com 拒绝原因或网络问题。
- 📑 **全局自定义快捷菜单（PUT /v2/menu）**：
  - 启动后自动通过官方 [`PUT /v2/menu`](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html) 接口向 QQ 开放平台注册底部快捷菜单，单聊底部直达会话列表、技能、MCP、当前状态与快捷管理。
- 🧩 **动态预设与权限管理**：
  - 预设列表从 DSH 运行时**动态获取**（内置 + 用户自定义预设），绝不硬编码。
  - 权限列表优先读取 `permissionPresets.catalog()`，支持在会话中即时切换 `只读` (`read-only`)、`工作区写入` (`workspace-write`)、`全系统` (`danger-full-access`)。
- ⚙️ **原生 Web UI 配置**：
  - 无需额外独立配置页：配置通过导出的 `Config` schema 由 DSH 0.2.1 设置系统投影，客户端在 **设置 → 插件 → QQ 机器人** 注册独立 tab，安全保密字段（`clientSecret`, `token`, `mcpManagerToken`）自动脱敏。

---

## 📸 运行效果展示 (Showcase)

| 1. 工作区与会话列表 (`/sessions`) | 2. Agent 交互提问 (`ask_user_question`) |
| :---: | :---: |
| <img src="docs/images/workspace-sessions.png" width="360" alt="工作区与会话列表（引用块层级）" /> | <img src="docs/images/user-question.png" width="360" alt="Agent 交互提问" /> |
| **层级化对齐 DSH 侧边栏，支持按键一键切换** | **紧凑 A/B/C/D 操作板，点击即回传 Agent** |

| 3. 双向权限审批联动 (`/approve` / `/reject`) | 4. 实时工具调用执行进度 (可选聚合) |
| :---: | :---: |
| <img src="docs/images/approval-sync.png" width="360" alt="双向权限审批" /> | <img src="docs/images/tool-execution.png" width="360" alt="工具调用执行" /> |
| **QQ 与 Web UI 实时互斥结算，绝不悬挂** | **工具执行进度秒级感知，多操作自动聚合防刷屏** |

| 5. 会话统计数据 (`/stats` 对齐 WebUI) | 6. 模型选择与翻页 (`/model` 操作板) |
| :---: | :---: |
| <img src="docs/images/mobile-stats.jpg" width="360" alt="会话统计数据" /> | <img src="docs/images/mobile-model.jpg" width="360" alt="模型切换操作板" /> |
| **轮次、步数、LLM耗时、TTFT及缓存命中率** | **支持多供应商模型识别与上一页/下一页翻页** |

| 7. 思考等级管理 (`/effort` 操作板) | 8. QQ 图片同步至 Web UI 聊天气泡 |
| :---: | :---: |
| <img src="docs/images/mobile-effort.jpg" width="360" alt="思考等级操作板" /> | <img src="docs/images/web-sync-image.png" width="360" alt="QQ 图片同步至 Web UI" /> |
| **支持 off/low/medium/high/xhigh/max 实时切换** | **QQ 发送图片原生呈现在 Web UI 聊天流** |

| 9. QQ 文件接收并保存至工作区 |
| :---: |
| <img src="docs/images/web-sync-file.png" width="480" alt="QQ 文件接收保存" /> |
| **QQ 发送文件自动保存至 uploads/ 并通知 Agent** |

---

## 📋 架构设计

```
QQ 开放平台 (q.qq.com)
  │
  ├─ WebSocket Gateway ───────▶ QQGatewayClient (lib/qq/gateway.js)
  │    (Hello, Heartbeat,          │  分发 C2C_MESSAGE_CREATE / INTERACTION_CREATE
  │     Identify, Resume)          ▼
  │                         MessageBridge (lib/sync/message-bridge.js)
  ├─ HTTP REST API ◀──────────  ├─ 指令解析器 (/sessions, /switch, /skills, /mcp, /render, /send ...)
  │    (POST /v2/users/.../messages)  ├─ 交互操作板构建器 (lib/ui/keyboard.js + lib/ui/emoji.js)
  │    (POST /v2/users/.../files)     ├─ 消息流式分段与清洗
  │    (PUT /v2/menu 快捷菜单)        ├─ 富媒体出站（图片/文件转发、渲染图回传）
  │                                   ▼
  │                         SessionManager (lib/sync/session-manager.js)
  │                             │  会话分页 / emoji 分配 / 标题与权限读取
  │                             ▼
  │                         DeepSeek Harness 核心运行时 (Cordis Framework)
  │                             ├─ ctx.sessions / ctx.sessionController (会话与 prompt)
  │                             ├─ ctx.on('session/event') (双向消息监听)
  │                             ├─ ctx.on('approval/request') (双向审批竞态)
  │                             ├─ ctx.skills / ctx.permissionPresets
  │                             └─ ctx.tools (qq_render_text_image / qq_send_file)
  │                                   ▲
  ├───────────────────────────── ApprovalHandler (lib/sync/approval-handler.js)
  ├───────────────────────────── AdminInventory (lib/sync/inventory.js)
  │                                └─ POST /dsh-mcp-manager/api（技能/MCP 启停；缺失则只读降级）
  └───────────────────────────── Render pipeline (lib/render/*)
                                   └─ Typst（内嵌）→ Edge/Chrome headless → Pillow → SVG 兜底
```

---

## 🚀 快速上手

### 1. 准备 QQ 开放平台机器人凭证

1. 前往 [QQ 开放平台官网](https://q.qq.com/) 注册并登录，创建机器人应用：
   - 个人开发者创建的**默认单聊机器人**即可直接使用，无需复杂配置。
2. 在 **开发设置** 中获取：
   - `AppID`（机器人应用 ID）
   - `AppSecret`（开发者密钥）
3. 机器人调试：若机器人尚未公开发布上线，建议开启**沙箱环境** (`sandbox: true`) 进行测试。

## 🚀 安装与部署

本插件是标准 DSH Bundle 插件包，声明了 `dsh.bundle.patch` 和 `dsh.client`，通过 DSH 官方 CLI 命令一行即可完成安装与自动挂载：

### 1. 安装插件

#### 从 npm 官方源安装（推荐）：
```bash
dsh plugin --profile web add dsh-adapter-qq
```

#### 或从 GitHub 仓库安装：
```bash
dsh plugin --profile web add github:jixishi/dsh-adapter-qq
```

> **卸载插件**：
> ```bash
> dsh plugin --profile web remove dsh-adapter-qq
> ```

---

### 2. 在 DSH Web UI 中配置

安装完成后，启动 DSH Web 界面（默认 `http://127.0.0.1:3080`），进入 **设置 (Settings) → 插件(Plugins)** 页面，点击顶部的 **【QQ 机器人】** tab 进行配置：

**推荐：扫码绑定** —— 点击「生成绑定二维码」，用手机 QQ 扫码并按提示确认；成功后会自动填入 AppID、AppSecret 与绑定 OpenID 并保存。二维码约 2 分钟有效，过期可重新生成。若 q.qq.com 拒绝或网络异常，界面会显示 `[code] message`、`retcode` 与 `detail`，不会静默失败。

> DSH 0.2.1 的设置入口是「设置 → 插件」页内的 tab（与本机 CliProxyAPI 等插件一致）；旧版本的「设置 → QQ 机器人卡片」已不存在。**配置字段全部声明为 volatile**，保存后会写入 profile patch 并即时热应用（修改 AppID/AppSecret/沙箱后自动重连，无需重启 DSH）；仅升级插件版本后 host 半更新需重启一次。版本更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

| 配置项 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `enabled` | 是否启用 QQ Bot 适配器 | `true` |
| `appId` | 填写 QQ 开放平台的 Bot AppID | `""` |
| `clientSecret` | 填写 QQ 开放平台的 AppSecret（密文遮罩） | `""` |
| `sandbox` | 是否连接沙箱开发环境（测试期间推荐勾选） | `false` |
| `userOpenid` | 绑定的专属用户 OpenID（**留空将在收到首条消息时自动绑定**） | `""` |
| `defaultPreset` | 新建会话默认 Agent 预设 | `"standard"` |
| `defaultCwd` | 新建会话默认工作目录（留空使用当前 DSH 工作区） | `""` |
| `autoRegisterMenu` | 启动后自动向 QQ 开放平台注册底部自定义快捷菜单 | `true` |
| `markdown` | 消息回复优先使用 Markdown 渲染 | `true` |
| `syncToolCalls` | 是否同步推送工具调用执行进度（防刷屏，默认关闭） | `false` |
| `toolCallAggregateWindowMs` | 工具调用聚合推送窗口时间（毫秒，默认 30000ms / 30秒） | `30000` |
| `sessionPageSize` | 会话列表每页数量（QQ 操作板建议 ≤6） | `6` |
| `sessionPathDisplay` | 会话列表工作区路径显示：`tail` 仅最后一级文件夹 / `full` 完整路径 | `tail` |
| `autoSendAttachments` | Agent 回复中的图片/文件自动转发到 QQ | `true` |
| `renderWidth` | 文本渲染图片的像素宽度（480–1600） | `900` |
| `renderTheme` | 文本渲染图片主题（`light` / `dark`） | `light` |
| `mcpManagerToken` | `@xxxyz/dsh-mcp-manager` 写操作令牌（可选，密文遮罩；也可用环境变量 `DSH_MCP_MANAGER_TOKEN`） | `""` |

保存后，插件会立即热重载配置并自动建立 WebSocket 连接，无需重启 DSH。

---

## 💬 交互指令与操作说明

在 QQ 单聊窗口中，您可以直接发送以下指令或在底部菜单/操作板中点击按钮：

### 1. 会话管理与工作区导航

| 指令 | 简写/别名 | 功能说明 |
| :--- | :--- | :--- |
| `/sessions [页码]` | `/会话列表`, `/list` | 分页展示所有会话（跨工作区展平），**每页内每个会话带互不重复的 emoji 标识**，操作板可点击切换/翻页 |
| `/new` | `/新建会话`, `/create` | 启动交互式新建会话向导：选择已有工作区（本地/远程）或进入目录浏览器 |
| `/switch <序号\|emoji\|ID>` | `/切换 <…>` | 切换当前活跃会话（支持全局序号如 `/switch 3`、当前页 emoji 如 `/switch 🍊`、会话 ID 前缀或标题关键字） |
| `/current` | `/当前会话`, `/info` | 查看当前活跃会话的详细信息与操作板 |
| `/status` | `/状态`, `/代理` | 图片查看主代理、团队成员（启用 Agent Teams 时）/子代理状态，以及正在进行的后台任务 |
| `/tasks` | `/任务`, `/任务管理`, `/schedule` | 图片查看 DSH「任务」页的定时/自动化任务（规则、状态、计划时间、绑定会话） |
| `/jobs` | `/后台任务` | 图片查看运行中的后台任务；仅在启用官方持久终端时自动注册 |
| `/usage` | `/用量`, `/费用`, `/账单` | 图片查看今日/本月/累计用量与费用、模型/站点 Top；仅在安装 `@kenz1117/dsh-ui-usage-billing` 时自动注册 |

#### 新建会话交互向导流程：
1. **工作区选择 (第 1 步)**：发送 `/new`，操作板展示所有已有工作区（如 `📁 免费:~ (远程)`, `📁 qq-bot`, `📁 AutoAim`）及【🔍 浏览并选择目录】。
2. **目录选择与浏览 (第 2 步)**：支持按键深入子目录、`⬆️ 上级目录`、`➕ 新建目录`、`📄 上页/下页` 翻页。
3. **完成创建**：点击【✅ 选定当前目录创建】，即可完成会话创建并自动绑定为活跃会话！

### 2. 预设、模型与权限指令

| 指令 | 说明 |
| :--- | :--- |
| `/model` | 查看当前会话模型及所有可用模型列表，附带一键切换操作板 |
| `/model <名称或序号> [供应商]` | 为当前会话切换 AI 模型（如 `/model gpt-5.6-luna` 或 `/model 2`） |
| `/effort [等级]` 或 `/思考` | 查看或切换思考等级（`off`, `low`, `medium`, `high`, `xhigh`, `max`），附带操作板 |
| `/stats` 或 `/统计` | 查看当前会话统计信息（轮次/步数、LLM耗时、首字延迟、解码速度、缓存命中率、Token用量，对齐 WebUI 底栏） |
| `/preset` | 显示当前预设及所有动态获取的可用预设列表（内置 + 自定义），附带切换按钮 |
| `/preset <名称>` | 为当前会话切换预设（如 `/preset ptc`，未产生交互前可换） |
| `/permission` | 显示当前权限级别及切换操作板 |
| `/permission <模式>` | 切换权限模式：`只读` (`read-only`)、`工作区` (`workspace-write`)、`全系统` (`danger-full-access`) |

### 3. 技能 / MCP / 渲染与文件发送

| 指令 | 说明 |
| :--- | :--- |
| `/skills [页码]` 或 `/技能` | 技能管理：分页列出技能（名称/来源/可调用性/启停状态），点击进入详情，支持 `✅/⛔` 状态展示 |
| `/skill <名称>` | 查看单个技能详情（来源、provider、路径、适用场景、模型/用户可调用性） |
| `/skill on\|off <名称>` | 启用 / 停用技能（需安装 `@xxxyz/dsh-mcp-manager`，否则只读并提示） |
| `/mcp [页码]` 或 `/服务` | MCP 服务管理：分页列出服务（传输、层级、加载状态、工具数） |
| `/mcp <ID或名称>` | 查看单个 MCP 服务详情与工具清单 |
| `/mcp on\|off <ID>` | 启用 / 停用 MCP 服务 |
| `/mcp restart <ID>` | 重启 MCP 服务 |
| `/render [文本]` 或 `/渲染` | 把文本/Markdown 渲染成图片并发回 QQ；不带参数时渲染当前会话最近一条 Agent 回复 |
| `/send <路径>` 或 `/发送文件` | 把本地文件发送到 QQ（相对路径按当前会话工作目录解析） |

**Agent 可调用工具（由插件注册到 DSH）：**

| 工具 | 说明 |
| :--- | :--- |
| `qq_render_text_image` | 把 Markdown/纯文本渲染成图片（`text` 必填；`title`/`theme`/`width`/`send`/`filename` 可选），默认同时发送到当前绑定的 QQ 会话，返回本地文件路径与尺寸 |
| `qq_send_file` | 把本地文件或 base64 内容发送到 QQ（`path` 或 `data_base64`，`as_image`/`filename`/`msg_id` 可选） |

> 渲染引擎优先级：内嵌 Typst（霞鹜新晰黑 + Google 全彩 Emoji）→ 本机 Edge/Chrome 无头截图 → Pillow（需 Python + Pillow）→ 纯 SVG 兜底。可用环境变量 `QQ_ADAPTER_BROWSER` 指定浏览器路径、`QQ_ADAPTER_PYTHON` 指定 Python 解释器。

### 4. 实时执行同步

在活跃会话中，Agent 的所有实时执行动作均会推送到 QQ：
- 🛠️ 工具调用过程提示：如 `⚙️ [Agent 正在执行] 调用工具: pwsh ...`。
- 💬 最终思考与回复：清洗内部控制标记后完整呈现，长文本自动智能分段，且被动回复过期时自动优雅降级为主动消息，避免漏发。
- 🖼️ 回复中携带的图片/文件会自动转成 QQ 富媒体消息（`autoSendAttachments` 可关闭）。

### 5. 执行控制与辅助指令

| 指令 | 说明 |
| :--- | :--- |
| `/cancel` 或 `/stop` | 中止当前 Agent 正在运行的轮次 |
| `/approve [ID]` | 批准待审批请求（支持操作板一键点击） |
| `/reject [ID]` | 拒绝待审批请求（支持操作板一键点击） |
| `/answer <ID> <选项>` | 回答 Agent 的提问；多选题可回复 `A,B` 或点击操作板逐个选择后提交 |
| `/menu` | 手动强制向 QQ 开放平台同步底部快捷菜单 (`PUT /v2/menu`) |
| `/help` | 显示使用帮助菜单与全局快捷操作板 |

### 4. 自由对话

在设置活跃会话后，**发送任意非 `/` 开头的文本**，将直接转发给 DSH Agent：
- Agent 思考与执行过程在 QQ 与 Web UI 实时同步。
- 回复内容支持 Markdown 代码高亮、表格与长文本自动分段。
- Web UI 中的提问与操作亦会实时推送到 QQ 聊天中。

---

## 🧪 单元测试

本项目内置完整的单元测试套件（覆盖 API 客户端、媒体嗅探/富媒体上传、InlineKeyboard 与 emoji 操作板、会话分页、Gateway 网关协议、审批流与多问题/多选提问、消息桥接、渲染引擎与 agent 工具）：

```bash
# 运行全部测试
pnpm test
```

测试结果（DSH 0.2.1-rc.3 / Node 26，本机无头浏览器受限时浏览器用例会跳过）：
```text
✔ QQApiClient (21 tests passed)
✔ QQ media helpers (35 tests passed)
✔ KeyboardBuilder (19 tests passed)
✔ Session emoji palette (5 tests passed)
✔ SessionManager (17 tests passed)
✔ QQGatewayClient (6 tests passed)
✔ QQ scan-to-bind protocol (11 tests passed)
✔ ApprovalHandler / multi-question (5 tests passed)
✔ MessageBridge (27 tests passed)
✔ Task overview (11 tests passed)
✔ Usage billing integration (8 tests passed)
✔ Render engines (33 passed, 1 skipped)
✔ Typst engine / markdown conversion (7 tests passed)
✔ qq_render_text_image tool (14 tests passed)
✔ AdminInventory (27 tests passed)
✔ qq_send_file tool (20 tests passed)
ℹ tests 271
ℹ pass 270
ℹ skipped 1
ℹ fail 0
```

---

## ❓ 常见问题排查 (Troubleshooting)

1. **收到报错 `11255` 或发消息无响应？**
   - 检查 `sandbox` 配置是否与后台所处环境（测试沙箱 vs 正式）一致。
   - 检查 AppID 与 AppSecret 是否填写正确。
2. **提示 DNS 解析失败或连不上 `bots.qq.com`？**
   - 如果开启了代理软件（如 Clash、Shadowrocket TUN 模式等带有 fake-ip 功能），请确认 `bots.qq.com` 与 `*.qq.com` 直连，避免 fake-ip 解析异常拦截握手请求。
3. **切换预设提示 `session has already started; its agent preset is fixed`？**
   - DSH 原生架构约定：会话产生第一轮对话后，其 Agent 预设插件树即固化，不可热变更预设。如需使用其他预设，请使用 `/new [目录] <预设名>` 创建新会话。
4. **审批按钮点击无反应？**
   - 检查审批是否已在 Web UI 端先行处理；或者审批已超时关闭。两端任意一端处理后，状态会自动同步并提示已结算。
5. **QQ 发图报 `Declared image type does not match its bytes.`？**
   - 0.2.0 已修复：插件改为按字节魔数判定真实图片格式（png/jpeg/gif/webp），不再信任 QQ 的 `content_type`。若仍出现，请确认插件版本 ≥ 0.2.0 且 DSH 为 0.2.1-rc.3。
6. **`/skills` 或 `/mcp` 提示只读 / 未安装管理器？**
   - 启停能力依赖 `@xxxyz/dsh-mcp-manager`（其 HTTP API 必须可访问）。未安装或未启用时，菜单自动降级为只读列表；安装后发送 `/skills` 或 `/mcp` 刷新即可。
7. **`/render` 很慢或提示回退引擎？**
   - 默认使用**内嵌 Typst**（无需系统安装任何东西），中文与全彩 Emoji 由随包字体渲染，通常几十毫秒完成；若 Typst 不可用才回退本机 Edge/Chrome 无头截图 → Pillow → SVG。可用 `QQ_ADAPTER_BROWSER` 指定浏览器路径（设为 `off` 跳过浏览器），`QQ_ADAPTER_PYTHON` 指定 Python。
   - 若 Typst 报错，插件日志会打印最后三行 Typst 诊断（`[adapter-qq] Typst 渲染失败 ...`）。
8. **发送大文件失败？**
   - QQ 单聊文件软限制 200MB，>5MB 会自动走分片上传（prepare → 分片 PUT → part_finish → merge）；若网络中断请重试。图片 >20MB 会被 QQ 降级为文件类型上传。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
