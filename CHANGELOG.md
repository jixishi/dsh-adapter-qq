# Changelog

All notable changes to `dsh-adapter-qq` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [未发布]

### Fixed

- **三个设置项没有 UI 入口**。设置页是手写的字段列表（`updateField("key")` 行），不是按 schema 渲染的表单，因此只加 config 字段不会出现在界面上 —— `busyDelivery`、`notifyTurnAbnormal`、`notifyRestartRecovery` 三个键就处于「能生效但看不见」的状态。已补齐三行，并新增 `test/settings-coverage.test.js` 双向校验 schema 与设置页行：漏行现在是失败测试，而不是静默缺口（`token`、`activeSessionId`、`allowFrom` 作为内部字段排除）。
- **「插话方式」改为子菜单注册**。原先是一个顶层 `send_message` 项，占掉一个顶层名额（QQ 上限 10）且无法展示可选项。现在与「权限模式」「模型与思考」同构：子菜单下含 立即插话 `/delivery steer`、排队 `/delivery queue`、交互式选择 `/delivery`。

注：这两个改动在 `0.2.4` 发布之后合入 `main`，npm 上的 `0.2.4` 不包含它们（npm 不允许覆盖已发布版本）。

## [0.2.4] - 2026-11-06

### Added

- **Session subscriptions with coalesced background notifications.**
  - `lib/sync/subscriptions.js`: a persisted `SubscriptionStore` plus a
    single-timer `SubscriptionScheduler`. Messages from a subscribed session are
    buffered; the window opens on that session's first message and, when it
    closes, the batch is merged into **one** digest. A continuous stream never
    pushes the deadline back, and an empty window never fires.
  - Per-session intervals of **1 / 5 / 15 / 30 / 60 minutes** (default 5).
    Unknown or hand-edited values snap to the nearest bucket and the derived
    timers are clamped, so a corrupt store cannot schedule absurd delays.
  - Background capture happens in `handleDshSessionEvent` **before** the
    active-session filter — a subscribed session is by definition not the active
    one, so filtering first would have made the feature unreachable.
  - Digests carry an inline keyboard: 查看 / 快速回复 / 取消订阅 / 订阅列表.
  - `SubscriptionStore` persists to `$DSH_HOME/adapter-qq/subscriptions.json`
    with a temp-file + rename write; a corrupt file degrades to "no
    subscriptions" instead of failing plugin startup.
- **Quick reply without switching the active session.**
  - `/reply <session> [text]`: with text it delivers immediately, without text it
    arms a one-shot target for the next message. `/reply off` clears it.
  - Replying on QQ to a subscription notice routes the text back to that session
    (resolved from the notice's message id, bounded to the newest 200).
  - `handleUserPrompt` now resolves a target session instead of always using the
    active one; the attachment cwd follows the target through the new
    `SessionManager#getSessionInfoById`.
- **Left sidebar "订阅管理" entry.** Registered in the left navigation bar
  (the same column as Logcat / 插件 / 远程工作区) as a matching pair:
  `sidebar.panellist` (`id` / `order` / `label` + icon component) and `main`
  (`key` **must equal** that `id`). Registering only one side loads cleanly but
  shows nothing when the row is clicked, so the pairing is pinned by a test that
  runs the real client factory against a fake slot registry.
  The panel lists subscriptions with interval, pending count and active flag;
  supports add, remove, per-session interval edits and "立即推送".
- **Subscription HTTP API** at `POST /dsh-adapter-qq/subscriptions`
  (`list` / `subscribe` / `unsubscribe` / `setInterval` / `flush`), with the same
  `x-dsh-plugin` header guard and 64 KiB body cap as the onboarding route.
- Commands: `/subscribe` (`/订阅`), `/subscriptions` (`/订阅列表`),
  `/unsubscribe` (`/取消订阅`), `/reply` (`/回复`); bottom-menu name mapping and
  `/help` entries updated.
- **Sidebar row matches the built-in icon style.** The left column renders
  monochrome stroked SVG glyphs; this row used a coloured 🔔 emoji, which broke
  both the visual language and theme following. Replaced with an inline
  `<svg viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.2">` bell that
  takes the host's `size` prop (default 16, junk values fall back). Decorative
  emoji were also dropped from the pane's buttons, group headers and running
  marker; only the semantic warning glyph stays, and the group header now shares
  the row padding so labels line up.
- **Relative activity time + workspace grouping in the subscription pane.**
  - Every row now shows how long ago the session was last active, using the same
    units and wording as the DSH left sidebar (`刚刚 / N分钟 / N小时 / N天 /
    N个月 / N年`, taken from `dsh-client-ui-workspace`'s `time.*` locale keys plus
    `relativeTime`). Missing, zero and future timestamps all collapse to `刚刚`
    rather than rendering `NaN` or a negative duration.
  - The "add subscription" picker is grouped by workspace (final path segment),
    newest workspace first and newest session first inside each group. Groups are
    keyed by the full path, so two projects sharing a tail segment
    (`W:/x/proj` vs `W:/z/proj`) stay apart.
  - **Next-push countdown.** Each subscription shows `4分12秒后推送` next to its
    interval, computed from the live buffer window (`formatDueIn`), so the
    interval setting becomes observable rather than abstract. It disappears once
    the buffer is drained.
  - `formatRelativeTime` / `workspaceLabel` / `groupByWorkspace` live in
    `lib/sync/display-time.js`; the route attaches `updatedLabel`, `workspace`
    and `workspaceGroups` to the list payload, and accepts an injectable `now()`
    for deterministic tests.
- Tests: 77 new cases (376 total, 375 pass, 1 skipped).

- **Over-long subscription digests are delivered as an image.** QQ truncates a
  single markdown message beyond ~4000 characters, so a digest that exceeds the
  budget (3800, the same figure the plugin already uses for reply chunking) is
  rendered with the embedded Typst engine and sent as a picture instead of being
  cut off. New setting `subscriptionSendMode`:
  - `text` (**default**) — plain markdown, switching to an image only when too long
  - `auto` — image only when too long (same effect as `text`, kept for explicitness)
  - `image` — always render

  Rendering failure falls back to text (trimmed, with a note) rather than dropping
  the notification. The action keyboard is sent as a short companion message
  because QQ keyboards attach to text, not media.
- `fitDigestForImage()` bounds the rendered height: a 30-message digest otherwise
  produced a 1800x12685 image that QQ scales into unreadable text. The body is
  trimmed on a line boundary with an explicit "已截断，完整 N 条请在 Web UI 查看"
  subtitle; measured 1800x6618 after the cap.

- Integration with [`dsh-token-metrics`](https://github.com/hugoyee75-cmyk/dsh-token-metrics)
  as an alternative `/usage` data source. Detected via the Loader tree or the
  plugin inventory; when present it is preferred over
  `@kenz1117/dsh-ui-usage-billing` and the command renders extra sections that
  only token-metrics can supply: average TTFT, output speed (t/s), per-project
  and per-origin (main / subagent / workflow) usage, provider balance and
  subscription quota windows, the daily-budget progress bar, and the list of
  models that matched no price. Costs are converted from USD with the snapshot's
  own `cost.fx.usdCny`.
- Both sources share one code path (`lib/sync/token-metrics.js` normalises the
  token-metrics snapshot into the existing document shape), so `/usage`, the
  bottom menu entry and the `/help` line behave identically whichever plugin is
  installed; with neither installed the reply lists both install commands.
- **轮次异常结束会告诉你**（Issue #8）。以前一轮对话因报错、达到输出上限、被策略拦截或中断而结束时，QQ 端只会看到「正在输入」消失，没有任何回执，分不清还在跑还是早已死掉。
  - 新增 `turn/start` 跟踪：记录本轮开始时间、最后调用的工具（在 `syncToolCalls` 开关**之前**记录，所以关掉工具同步也照样能报「刚才停在哪个工具」）、以及本轮是否产出过内容。
  - `turn/end` 读取 `reason.kind` 后推送状态提示 + 操作板（查看状态 / 会话列表）。
  - `reason.kind` 取值**以 DSH 源码为准**（`turnEndToStopReason`）：`completed` / `max-tokens` / `aborted` / `interrupted` / `blocked` / `error`。issue 里提到的 `max-steps`、`step-limit` 并不存在，未按其实现；该类型被注释为 merge-extensible，因此对未知 kind 用 `default` 兜底播报而不是丢弃。
  - 错误摘要按 `error → failure → message → text → reason` 逐级回落（DSH 实际会出现这五种字段，不能假定一定有 `error`）。
  - 不打扰的两种情形：`completed` 不播报；用户自己按 `/cancel` 触发的 `aborted` 不播报（`/cancel` 已有回执）。底层会自动重试的瞬态错误码（`STREAM_CLOSED` 等）也保持安静 —— 位于 `reason.error.code` 而非 `kind`。
  - 新设置 `notifyTurnAbnormal`（默认开启）。
- **插话方式可选**（PR #4）。运行中直接发普通文本，以前固定 `steer`，现在可以选：
  - 新设置 `busyDelivery`：`steer`（立即插话，默认）/ `queue`（本轮结束后发送）。
  - `/delivery`（`/投递`）展示当前选择并带切换按钮；`/steer <文本>` / `/queue <文本>` 可单次覆盖。
  - 空闲时一律走 `queue`（插话只在运行中的轮次里存在，`queue` 就是开下一轮）。
  - 只在**需要你知道或操作**时才回执：排队 → `📥 已排队（第 N 条）` 带插话/移除按钮；请求插话但本轮刚好结束 → 提示已转为排队；空闲时显式 `/steer` → 说明已按普通消息发送。按默认插话成功、以及空闲时的普通消息都不多出消息。
  - `/queue`（无参数）列出排队中的消息并给出 `/qsteer`、`/qdrop` 操作；`/qsteer <ID>` 改为插话、`/qdrop <ID>` 移除。
- **会话卡显示最后一条用户消息**（PR #5）。`/sessions`、切换会话卡、`/current` 新增一行：
  - 来自实时事件流 → 标注「最后一条用户消息」（含中途 steer）；
  - 来自 `turnOutline` 投影或持久化投影缓存 → 标注「最近一轮提问」（投影只保存每轮第一句，所以措辞不同）。
  - 单行化处理：去换行、去反引号（否则一个反引号会吞掉卡片后半段）、超过 80 字截断；会话卡内存上限 200 条。
- QQ 底部菜单新增「插话方式」入口（PR #6），点一下就是 `/delivery`，不必手打。
- **宿主重启后补发中断提示**（Issue #8 第二层）。第一层只解释「轮次在**同一个进程内**结束」，这一层覆盖另一半：**进程本身消失**。宿主重启、崩溃或 HMR 重载时，正在跑的轮次不会发出 `turn/end`，内存里的状态也随之消失，QQ 端又只剩一个停掉的「正在输入」。
  - 新增 `lib/sync/turn-ledger.js`：把在途轮次写到 `$DSH_HOME/adapter-qq/active-turns.json`（会话、接收人、轮次号、最后工具、bootId、更新时间），原子写（临时文件 + rename）。
  - `turn/start` 记账，工具变化时刷新，`turn/end` 时清除。
  - **优雅退出保护**：进程退出时产生的 `aborted (disposed)` 如果照常清除，就会删掉下一次启动恰恰需要的记录。`SIGTERM` / `SIGINT` 与插件 dispose 会把账本标记为「正在退出」，此时 `clear()` 不生效。
  - 在 **gateway ready** 之后（不能更早：机器人还发不出消息时推送等于丢失）读取**属于更早 boot** 的条目，按时间倒序逐条播报并消费；超过 24 小时的条目直接丢弃 —— 一天前的「还在运行」是噪音而不是信息。
  - **默认关闭**（新设置 `notifyRestartRecovery`）。账本无论开关都会写，所以以后打开仍能生效。
  - 文案只说「进程退出了」，不编造失败原因，并提示「直接发消息即可接着往下做」。
  - `currentBootId()` 增加随机后缀：同一 pid 在同一毫秒内重启两次会被判成同一次启动，从而把残留轮次当成自己的而保持沉默。

### Changed

- **Sandbox mode is now on by default** (`sandbox: true`). A bot that has not gone
  live can only reach testers, so the old default (`false`) made a fresh install
  fail to connect with nothing obvious to blame. The setting still accepts an
  explicit `false`, so existing profiles that saved it keep their choice, and the
  setup docs now say to keep it on until the bot is published (the operator's QQ
  number must be in 开放平台 → 测试人员管理).

- **The bottom menu groups its "look at something" entries under 管理**:
  技能管理 / MCP 服务 / 统计信息 / 用量计费（装了计费插件时）/ 会话订阅.
  They used to occupy top-level slots (QQ allows only 10), and 会话订阅 had no
  menu entry at all — the feature existed but was unreachable from the menu.
  Friendly-name mapping and `/help` were updated to match.

### Removed

- **The self-imposed "5 previews" fold.** It was never a requirement: it dropped
  messages from the digest and — worse — kept every digest under the character
  budget, which made the "too long → send an image" rule unreachable. The digest
  now represents every buffered message; the delivery form is decided by the
  measured length, and `full` mode only widens the per-message preview.

### Fixed
- **Scheduled subscription pushes never fired.** `MessageBridge#start()` begins
  with `this.stop()`, and `stop()` nulled `subscriptionScheduler`. Every later
  `enqueue()` then called `arm()` on `null`, so no timer was ever armed while the
  pane still counted buffered messages ("3 条待推送"). The scheduler's lifetime
  belongs to `index.js` (disposed with the plugin), not to the bridge's
  start/stop cycle; `stop()` now only clears per-process state (one-shot reply
  targets, notice index) and leaves persisted subscriptions and the scheduler
  intact.
- **A digest could be lost without being sent.** `digestFor()` consumed the
  buffer before the send, so a failed delivery (no bound user, QQ down, throw)
  silently destroyed the messages and the next "立即推送" reported "没有待推送的消息".
  `digestFor()` is now read-only and `commit()` drops the window only after the
  bridge confirms delivery; `flushSubscriptionDigest()` returns `true`/`false`
  instead of returning silently.
- **Failure could spin the timer.** With the buffer preserved, an already-expired
  window made `arm()` re-fire at 0ms, retrying a permanently failing send at full
  speed (observed: 14 attempts in 40ms). Added per-session exponential backoff
  (30s, 1m, 2m … capped at the subscription's own interval) that `arm()` honours.
- **"立即推送" now actually pushes.** It called `runDue()`, which only flushes
  sessions whose coalescing window had already closed — so for anything buffered
  but not yet due (the normal case) the button did nothing. Added
  `SubscriptionScheduler#flushAll()` that ignores the window, plus visible
  feedback: the button is no longer disabled when nothing is buffered, it shows
  `推送中…` while running, and the outcome is reported
  (`已立即推送 N 个会话的摘要到 QQ` / `当前没有待推送的消息`). `runDue()` keeps
  honouring the window for scheduled flushes.
- **The subscription pane no longer has a fixed height.** It used
  `height:100%` + `overflow:hidden` on the host container and a hard
  `max-height:190px` on the candidate list, so a short window clipped content the
  user could not scroll to. The host now grows with the pane
  (`flex:1 1 auto`, `max-height:100%`, `overflow-y:auto`), the subscription list
  takes the leftover space, and the candidate list uses
  `max-height: clamp(140px, 32vh, 460px)` so it tracks the real screen size.
- The subscription panel is now reachable. The first attempt registered
  `sidebar.right.pane.tab` / `.title`, which is the RIGHT-side pane slot — the
  right pane's own "开始" page is driven by `sidebarRightTabs.register({ guide })`
  instead, so nothing surfaced and the panel could not be opened at all. Moved to
  the left sidebar pair (`sidebar.panellist` + `main`).
- `SubscriptionScheduler` now inherits the store's clock. Two independent clocks
  could disagree, leaving a window that never closes.
- Subscription lookups no longer assume `SessionManager#getSessionInfoById`
  exists; a defensive `describeSession` falls back to the listing entry.
- `MessageBridge#stop()` no longer throws when the scheduler stub lacks `stop()`.
- Provider identifiers in the site table (`workbuddy`, `deepseek`) are no longer
  masked as hostnames — they are billing routes, not domains, so masking hid the
  only information the column carried.
- Every `$` that reaches a Typst content block is escaped; formatted USD amounts
  used to open inline math and abort the whole compile.
- The `累计` range now reads the source's lifetime totals instead of summing
  per-day buckets, which are pruned by the retention window (400 days by
  default) and would silently under-report.
- **Web UI 没接手审批时，不再被当成「已拒绝」**（PR #2）。`approval/request` 的 waterfall 返回 `unavailable` 只表示「Web UI 没有接这个请求」，旧实现把它和 QQ 的决定放进同一个 race，于是它立刻赢下：Agent 直接 fail closed、QQ 卡片上的按钮变成点不动的死按钮，还发出假通知「ℹ️ 【审批同步】已在 DSH Web UI 中完成处理: ❌ 已拒绝」。
  - 现在只有真实决定（`allowed-once` / `rejected`）才算数；`unavailable`、越界返回值、下行 reject 统一视为「Web UI 没决定」，继续等 QQ 点击。
  - 仅在**卡片确实送达**且 **caller 的 signal 仍能兜住等待**时才挂起，否则保持原来的快速失败，避免请求卡死。
  - 同步通知只在真实决定时发送，不再替 Web UI 说话。
  - 补上「进入监听器时 signal 已 aborted」的情形：abort 监听器对已 aborted 的 signal 不会再触发，原来会让这个 race 永久挂住。
- **测试 fixture 的 cwd 改成可移植路径**（PR #3）。`test/message-bridge.test.js` 把会话 cwd 写死为 `F:/dsh-plugin/qq-bot`：Windows 上是绝对路径，POSIX 上是**相对**路径，而附件用例会走真实的 `join(sessionCwd, 'uploads')` 落盘，于是 Linux/macOS 每次跑测试都在仓库根目录造一个字面量 `F:` 目录 —— 因为落在已忽略的 `uploads/` 里，`git status` 还看不见。
  - 改为 `tmpdir()` 下的 fixture，并在测试结束后删除；顺带补上 `getSessionInfoById` 桩（缺它时附件路径会回退到 `process.cwd()`），并新增断言确认两个附件确实落在 fixture 的 `uploads/` 下。
- `byDayModelsSite` uses the `{ day: { model: { site: cell } } }` shape the
  aggregator expects; the flattened shape produced a table of `***` rows.
- **Card pictures silently lost their template.** Two causes, found in
  sequence. First, `ensureOutputDir()` accepted a directory on `mkdir` alone, so a
  path that exists but refuses new files could be chosen; the check now writes and
  removes a real probe file before committing. Second — and this is what actually
  produced the plain-text pictures — Typst was asked to create the PNG itself
  (`typst compile doc.typ <outPath>`), which a confined host denies with
  `EACCES`; the headless browser is unavailable there, so the render fell through
  to Pillow, which ignores the card body and draws Markdown as text. Typst now
  compiles to stdout and Node persists the bytes, so the renderer never opens a
  file for writing.
- **`/tasks`, `/status` and `/jobs` never passed `typstBody`.** They handed raw
  Markdown to the generic renderer, so their pictures could not look like
  `/usage` or `/stats`. Added `buildScheduleTypst()` and
  `buildAgentStatusTypst()` / `buildJobsTypst()`, and every card command now sets
  `expectTypstBody` so an empty body is logged instead of degrading silently. The
  caption also states which layout was used (卡片模板 / 通用排版).
- Tests: 387 cases (386 pass, 1 skipped).

## [0.2.3] - 2026-10-29

### Added

- `streamReply` setting (default **off**) plus `streamIntervalMs` (default
  1500 ms, clamped 500–10000): when enabled, assistant output is pushed to QQ
  incrementally with throttling, and the final message only carries the unsent
  remainder so streamed text is never duplicated. Internal `<think>` /
  `<system-reminder>` / runtime-context fragments are stripped from each
  streamed piece.
- `/usage [日|月|年|累计]`（also `day/month/year/all`, default 本月）aggregates
  the selected range from `byDay` / `byDayModels` / `byDayModelsSite` and renders
  a dedicated Typst card with:
  - stat cards for cost, calls, total tokens, average cost, cache-hit rate,
    input/output ratio, reasoning share and peak day;
  - a recent-30-day cost heatmap with legend and 30-day totals;
  - model and site tables scoped to the selected range.
- `sendOverviewCaption` setting (default **off**): `/usage`, `/status`, `/tasks`
  and `/jobs` no longer send a trailing text block after the image; enable it in
  the settings tab to restore the caption.
- `/stats`（`/统计`）now renders a dedicated Typst card — eight metric cards
  (turns, steps, LLM time, tool time, TTFT, decode speed, cache-hit rate, total
  tokens) plus a token breakdown table with a cache bar — instead of plain text.
- The QQ bottom menu gains parameterised presets generated from live data: a
  「模型与思考」submenu uses the **current model's** reasoning efforts
  (`/effort off|low|medium|high|xhigh|max`) and a 「权限模式」submenu lists every
  configured permission preset (`/permission read-only|workspace-write|…`). The
  interactive `/effort` and `/permission` commands stay as the first submenu
  entry, and `/menu` re-registers the presets on demand.
- CI: `.github/workflows/publish.yml` publishes on `v*` tags (and manual
  dispatch) to npmjs (`dsh-adapter-qq`) and GitHub Packages
  (`@<owner>/dsh-adapter-qq`), with tag/version validation, duplicate-version
  skipping, and a scoped tarball prepared by
  `.github/scripts/prepare-gh-package.mjs`.

### Fixed

- `/usage` model rows now use the billing catalog display names from
  `GET /api/billing/pricing` (`flash` → DeepSeek V4.1 Flash, `gemini-3.8-flash`
  → Gemini 3.8 Flash, …), falling back to the raw key when the catalog is
  unavailable.
- `/usage` site rows now use the registered relay names from
  `GET /api/billing/relay-quotas` (`CLI Proxy API`, `WorkBuddy`, …); unknown
  domains are masked (`***.example.org`) instead of exposing the full host.

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
- CI: npmjs publishing uses **npm trusted publishing (OIDC)** instead of a
  long-lived `NPM_TOKEN` — the workflow declares `id-token: write`, verifies the
  npm CLI is ≥ 11.5.1, strips any `_authToken` from `.npmrc`, and fails fast if
  `NODE_AUTH_TOKEN` is present so a token cannot silently override OIDC.
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

[0.2.4]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.4
[0.2.3]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.3
[0.2.2]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.2
[0.2.1]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.1
[0.2.0]: https://github.com/jixishi/dsh-adapter-qq/releases/tag/v0.2.0