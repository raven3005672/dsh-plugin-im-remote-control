# 设计文档

> 状态：2026-11-07 的已交付实现。本文描述**现在**的代码行为，不是规划。
> 交付范围：direct 模式、飞书、文本消息、单中控会话。gateway / 微信未交付。

## 1. 目标与非目标

**目标**

- 人在飞书里驱动本机的一个 DSH 会话：发消息进会话，回合结果回到聊天。
- 需要人决定的事情（工具审批、`ask_user_question` 反问/计划确认）能在飞书里完成，不必回到桌面。
- 中控会话可以把任务分发给任意执行会话，回复归属由插件负责。
- 不要求公网地址、不引入中转服务、不引入数据库。
- 安全边界明确：allowlist fail-closed、远程决定与桌面竞速、密钥不回显。

**非目标（当前版本）**

- 多租户 / 一个实例服务多个中控会话。
- gateway 冷启动与外部网关（源码保留，未构建）。
- 微信（代码/配置注释保留）。
- 图片、文件、语音消息。
- 限频重试、消息分片。
- 会话路由目录（按 chat 自动选目标会话）——仍在路线图。

## 2. 总体架构

```
飞书（私聊 / 群聊 @）
  │  WebSocket 长连接（插件持有，无公网地址）
  ▼
dsh-plugin-im-remote-control（Host，运行在 dsh 进程内）
  ├─ im.message.receive_v1 → admit()
  │    ├─ allowlist 校验
  │    ├─ 命令：/whoami、/approve、/deny、/answer
  │    ├─ 引用回复 → QuotedRoutes → 源会话
  │    └─ 默认 → 中控会话
  ├─ card.action.trigger → handleCardAction()
  │    ├─ 审批按钮 → ApprovalRegistry.resolveCard
  │    └─ 提问按钮 → QuestionRegistry.answerCard
  ├─ session/event
  │    ├─ user/message       → 绑定 turns
  │    ├─ assistant/message  → 收集最后一步文本
  │    └─ turn/end           → 回帖 / 记引用路由 / 抑制中控回执
  └─ ctx.webServer
       ├─ POST /im-remote-control/dispatch   Bearer + chat allowlist
       ├─ POST /im-remote-control/check      x-imrc-check: 1，只读探测
       └─ GET  /im-remote-control/status     布尔状态 + secret 末四位
```

**两半**

- **Host 半边**（`src/index.ts` 等）：长连接、投递、回帖、审批/提问、路由、设置页探测。
- **Client 半边**（`src/client/`）：设置页表单，`settings.section` 注册，走包内同一份 schema。

**DSH 接缝**

| 接缝 | 用途 |
|---|---|
| `sessionController.prompt({ mode: 'queue' })` | 把消息变成会话里的 user 消息；宿主里是 `agent.followup()`，每条消息自成一个回合 |
| `session/event` | `user/message`（rpcId 绑定）、`assistant/message`（文本）、`turn/end`（回帖） |
| `approval/request` | 审批瀑布流；`prepend` 抢在浏览器应答器之前 |
| `user-questions/request` | 结构化提问瀑布流；同样 `prepend` |
| `ctx.webServer.register` | dispatch / check / status 三条本地路由 |
| `settings` | 设置页读写 profile 行；`role('secret')` 让密钥只写 |

## 3. 模块

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](../src/index.ts) | 入口：配置解析、WS 长连接、入站路由、投递、回帖、dispatch/check/status、探测 |
| [`src/approval.ts`](../src/approval.ts) | 审批待决表：短 id、120s 超时、竞速、`ownLifetime`、卡片结算 |
| [`src/questions.ts`](../src/questions.ts) | 提问待决表：`user-questions/request` 竞速、多题聚合、5 分钟撤卡、`/answer` |
| [`src/cards.ts`](../src/cards.ts) | 纯函数卡片构造（审批/提问/结果/关闭）+ 按钮值解析 |
| [`src/replies.ts`](../src/replies.ts) | 引用回复路由表 + 中控回执抑制规则 |
| [`src/types.ts`](../src/types.ts) | 手写的窄 Host 契约 |
| [`src/client/`](../src/client/) | 设置页（settings.section id `im-remote-control`） |
| [`src/gateway/`](../src/gateway/) | PARKED：外部网关/冷启动，不构建 |

**内存状态**

| 结构 | 内容 | 生命周期 |
|---|---|---|
| `requests` | `requestId → { chatId, messageId?, label?, dispatched, quoted?, topLevel? }` | 从投递到 `user/message` 绑定 |
| `turns` | `sessionId → { chatId, label?, text, messageId?, quoted?, topLevel?, dispatched }` | 一个回合 |
| `seen` | 最近 500 条消息 id | LRU |
| `ApprovalRegistry.pendings` | 审批 id → 待决 + 卡片 message_id | 到结算/超时/卸载 |
| `QuestionRegistry.pendings` | 提问 id → 问题/答案/卡片 | 到答完/超时/卸载 |
| `QuotedRoutes` | 出站 message_id → 源会话 | 24h / 200 条 |
| `dispatchAt` | chatId → 最近 dispatch 时间 | 120s 回执窗口 |

**文件**

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/im-remote-control.token` | dispatch Bearer token，0600，挂载时写、卸载时删 |
| `$DSH_HOME/im-remote-control.log` | 插件日志，0600 |
| `$DSH_HOME/im-remote-control.json` | 可选共享配置（兜底） |

## 4. 入站路径

### 4.1 长连接与去重

- direct 模式下插件创建 `Lark.WSClient`，用 `EventDispatcher` 注册 `im.message.receive_v1` 和 `card.action.trigger`。
- 群聊消息必须 @ 机器人（`mentions` 非空）；私聊不需要。
- `seen` 做 500 条 LRU 去重，飞书重投同一条消息不会重复入会话。

### 4.2 `admit()` 管道

顺序固定：

1. **chat allowlist**：`allowedChats` 非空时必须在里面。
2. **发送者 allowlist**：`allowedOpenIds` 非空时必须在里面；两个 allowlist 都为空时插件根本不连飞书。
3. 空文本 → 回「目前只支持文本消息」。
4. `/whoami` → 回 open_id。
5. `/approve` / `/deny` → `answerApproval()`。
6. `/answer` → `answerQuestion()`。
7. **引用回复**：`parent_id ?? root_id` 命中 `QuotedRoutes` → 投给源会话（带原 label）。
8. 否则 → 中控会话。

### 4.3 `promptSession()`

- `requestId = feishu-<message_id>`，登记 `requests`。
- 调用 `sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [text, ...images], clientTimeZone: 'Asia/Shanghai' })`。
- 模型看到的 body：`[飞书] <open_id> 在 <chat_id> 说：\n<text>\n\n（回复方式：…）`。
- 成功后贴表情（空闲 `OK`、忙 `OneSecond`，失败回落 `OK`）；失败回帖「投递失败：…」。

### 4.4 图片输入

`parseInbound()`（[`src/inbound.ts`](../src/inbound.ts)）把 `msg_type` 解析成 `{ text, imageKeys }`：

| `msg_type` | 处理 |
|---|---|
| `text` | `content.text` |
| `image` | `content.image_key` → 一个图片 key |
| `post`（富文本） | `zh_cn`/`en_us` 的标题 + 各段文本拼成 text；`tag: 'img'` 收集 image key |
| 其他（file/audio/media/sticker…） | text 与 image 都为空 → 「目前只支持文本和图片消息」 |

`admit()` 对每个 key 调 `downloadImage()`：

1. `feishu.im.messageResource.get({ path: { message_id, file_key }, params: { type: 'image' } })`——**必须用消息资源接口**；`im/v1/images` 只能下载机器人自己上传的图。
2. 流式读取，超过 `MAX_IMAGE_BYTES`（10 MB）立即中止。
3. `sniffImageMediaType()` 按字节识别 PNG/JPEG/GIF/WebP（不信 content-type）。
4. 转 base64，作为 `{ type: 'image', mediaType, data, name }` 附在 prompt 的 content 里；宿主负责把字节提升成持久附件引用。

边界：单条最多 4 张（`MAX_IMAGES_PER_MESSAGE`），多出的在文本里留一条「超出上限」说明；单张失败/格式不支持也留说明，不静默丢图。模型不支持图片时宿主拒绝，插件回「当前会话模型不支持图片输入，请换用支持视觉的模型后重发」。

## 5. 回合结果

### 5.1 绑定

`user/message` 事件带 `source.rpcId`，据此找到 `requests` 条目并绑定 `turns[sessionId]`。绑定发生在 `user/message` 而不是 `turn/start`：`mode: 'queue'` 是 `followup()`，排队项成为自己回合的唯一消息，`rpcId` 只在 `user/message` 上出现。

### 5.2 文本收集

`assistant/message` 只保留**最后一步的非空** assistant 文本，不拼接过程叙述。

### 5.3 回帖规则

| 回合来源 | 发送方式 |
|---|---|
| `dispatch`（`dispatched: true`） | `sendToChat`：主聊天新消息，带 `【label】` |
| 引用回复（`quoted: true`） | `sendToChat`：**主聊天新消息**（不挂线程，避免被飞书折叠） |
| 普通飞书消息 | `replyTo(messageId)`：引用用户原消息的线程回复 |

- 空文本 + `completed` 不发；`error` / `aborted` / `blocked` 等且无文本时发一句原因。
- 文本超过 3500 字符按开头截断，后缀「…（已截断）」。

### 5.4 中控回执抑制

`suppressesReceipt()`（[`src/replies.ts`](../src/replies.ts)）：只有同时满足

- 非 `dispatched`、非 `quoted`；
- 在**中控会话**里；
- 该 chat 在 120 秒内刚刚 dispatch 过

的回帖被吞掉（避免中控的「已派发」回声）。执行会话的结果、引用回复的结果永不抑制。

### 5.5 引用路由

```ts
QuotedRoutes.remember(outboundMessageId, { sessionId, chatId, label })
QuotedRoutes.take(quotedMessageId, chatId)   // 24h / 200 条 / 同 chat
```

`turn/end` 发送成功后登记 result message id。用户引用该消息回复时，`admit()` 命中 `take()` → 投给源会话，并标记 `quoted: true`（回帖走主聊天）。

边界：只有**重载后**发出的结果消息在表里；更早的引用仍进中控。引用用户自己的消息也仍进中控。

## 6. 审批

### 6.1 状态机

```
forward(chatId, label, request, next)
  ├─ 发审批卡片（message_id 回填）
  ├─ 与 next()（桌面应答器）竞速
  ├─ 点「批准一次」/「拒绝」 → resolveCard → settled
  ├─ /approve /deny            → answer      → settled
  ├─ 桌面先答                  → settled（卡片 patch 成实际结果：已批准/已拒绝）
  ├─ 120s 无人决定             → rejected + 回帖「已超时，自动拒绝」
  ├─ request.signal abort      → cancelled
  └─ dispose（卸载）           → cancelled
```

### 6.2 竞速与撤回

- 监听用 `prepend: true`，保证在浏览器应答器之前注册。
- `ownLifetime()` 把 `request.signal` 替换成自己的 `AbortController`（镜像原 signal）；任一来源先决定 → `abort()` → 网关取消已转发给浏览器的 pending 事件 → 桌面弹窗（以及被它占住的输入框）撤回。
- 请求对象被冻结时换不掉 signal：降级为「只能本地决定才能关掉桌面弹窗」。
- `unavailable` 或本地应答器抛错不算决定：用 never-settling promise 占位，继续等飞书或超时。

### 6.3 卡片与文本

- 卡片：`{k:'approval', id, v:'allow'|'deny'}`；结算后 `im.message.patch` 换成结果卡（按钮消失）。
- 文本：`/approve <id>` / `/deny <id>`（大小写不敏感）；校验 chat 归属，跨 chat 返回 foreign。
- 卡片发送失败 → 自动退回纯文本通知，文本命令始终可用。

## 7. 提问

### 7.1 状态机

与审批同构，但**超时的语义不同**：

```
forward(chatId, label, request, next)
  ├─ 发提问卡片（message_id 回填）
  ├─ 与 next()（桌面）竞速
  ├─ 选项按钮 / /answer <id> <文本> → 聚合
  │    ├─ 还有未答题目 → 更新卡片（progress），返回 partial
  │    └─ 全部答完      → 交回 { answers }，卡片换成「已回答」
  ├─ 桌面先答          → 卡片「已在其他界面处理」
  ├─ 300s 无人回答     → 只撤卡片，**不替你回答**，桌面继续等
  ├─ request.signal abort → 卡片「已取消」
  └─ dispose            → 卡片「已取消」
```

### 7.2 答案聚合

- 单选 + 有选项 → 按钮点击即选中该 label。
- 多选 → `/answer <id> X, Z`（逗号/顿号分隔），精确匹配选项标签则记为 `selected`。
- 无选项 / 自由回答 → `/answer <id> <文本>`，记为 `custom`（`selected: []`）。
- 多题：`answers` 按题目 id 聚合，全部到齐才 resolve；进度通过卡片更新。
- `intent.kind === 'plan-review'` 时卡片标题为「计划待确认」。

### 7.3 卡片渲染

- 有选项且单选：每题一个按钮行；推荐项（第一个）用 `primary`。
- 多选 / 无选项：列出选项并提示 `/answer`。
- 已答题目显示「✅ 已回答：…」。
- 底部 note 带请求 id、有效期和 `/answer` 用法。

## 8. 卡片回调

`card.action.trigger` → `handleCardAction()`：

1. `parseCardAction()` 只接受 `{ k: 'approval' | 'question', id: /^[0-9a-f]{4,12}$/, v?, q? }`。
2. 校验 `operator.open_id`（若配置了 `allowedOpenIds`）和 `context.open_chat_id`（若配置了 `allowedChats`）。
3. 审批：`resolveCard(id, chatId, allow)`；提问：`answerCard(id, chatId, qid, label)`。
4. 返回 `{ toast: { type, content }, card: { type: 'raw', data } }`：立即更新卡片并弹 toast；`resolved` 回调同时 patch 一次。
5. 未知 id / 跨 chat → `{ toast: { type: 'warning', ... } }`，不改变状态。

**飞书侧前提**：开发者后台「回调配置 → `card.action.trigger` → 长连接」并发布版本；否则点按钮报 `200340`（文本命令不受影响）。

## 9. dispatch 接口

`POST /im-remote-control/dispatch`

```json
{ "chatId": "oc_…", "sessionId": "session-…", "text": "…", "label": "…", "messageId": "om_…" }
```

- **鉴权**：`Authorization: Bearer <token>`；token 每次挂载随机生成，写 0600 文件，卸载只删自己写入的内容。
- **chat 边界**：`chatId` 必须命中 `allowedChats`（无条件，不因空而放行）。
- **校验**：body 必须是对象；`text` 非空；超过 64 KiB 返回 413；未知 session 由宿主拒绝。
- **行为**：`sessionController.prompt(mode:'queue')`，登记 `requests`（`dispatched: true`、label、messageId）；成功 202。
- **中控零输出**：dispatch 成功后 120s 内，中控会话的回合结果被抑制（见 §5.4），执行会话的结果正常回帖并带 `【label】`。

## 10. 配置与设置页

优先级：**profile 行 → legacy 顶层字段 → 共享文件**。

- 行里显式给出的值优先；数组类 allowlist 取并集。
- `feishu.*` 优先于 `appId`/`appSecret`；`controllerSessionId` 优先于 `sessionId`。
- 共享文件 `$DSH_HOME/im-remote-control.json` 作为兜底（凭据不写进 profile 的部署，以及未来的网关）。
- 配置错误用 `ConfigError` 承接，`apply()` 只吞这一类；其他异常抛回 Loader。
- allowlist 为空时：注册 `/check` 和 token 后返回，不连飞书、不注册 dispatch。
- 设置页：中控会话、允许用户、飞书凭据（只写 + 掩码 + 清除）、渠道、探测；`/status` 给页面读取「哪些字段已配置」。

## 11. 安全模型

- **飞书账号 = 执行权**：allowlist 里的账号（或群里被允许的成员）能让 agent 执行 shell、读写文件。建议 `workspace-write` + `ask`，账号开二次验证。
- **同一系统用户下的进程互相信任**：token / 配置 / 会话日志都是 0600；token 挡的是其他用户和随手脚本。
- **allowlist fail-closed**：类型写错直接报错；空 allowlist 不连飞书。
- **chat 归属**：审批/提问 id 只能被对应 chat 结算；卡片点击同时校验 operator 和 chat。
- **路由鉴权**：dispatch 用独立 Bearer；`/check` 只读 + 自定义头；`/status` 只返回布尔和末四位。三条路由绕过 GUI cookie 认证，默认只监听回环。
- **密钥**：`role('secret')` 只写不回显；Host 之外只出现「已配置（****末四位）」。
- **日志**：不记录消息正文，只记录长度、id 前缀、结果。

## 12. 时序与容量

| 项 | 值 | 语义 |
|---|---|---|
| 审批等待 | 120s | 超时 `rejected`（fail-closed），回帖告知 |
| 提问等待 | 300s | 超时只撤卡片，不替你回答 |
| 回帖文本上限 | 3500 字符 | 截断并标记 |
| 引用路由 | 24h / 200 条 | 同 chat 才匹配 |
| 消息去重 | 500 条 | 内存 LRU |
| 图片 | 单张 10 MB、单条 4 张 | PNG/JPEG/GIF/WebP；超限/失败在文本里说明 |
| dispatch 回执抑制 | 120s | 只作用于中控会话的非 quoted/dispatched 回合 |
| 探测超时 | 10s | token / bot / 会话列表三次调用 |
| 卡片按钮有效期 | 审批 120s / 提问 300s | 卡片 note 标注 |

## 13. 错误与降级

| 场景 | 行为 |
|---|---|
| 卡片发送失败 | 退回纯文本通知（审批/提问），文本命令可用 |
| 回帖失败 | 写 `reply failed` 日志，不重试 |
| 审批超时 | 自动 `rejected` + 回帖 |
| 提问超时 | 撤卡，桌面继续等 |
| WS 长连接失败 | 写 `long connection failed` 日志；SDK 自动重连 |
| 配置缺失/类型错 | `ConfigError`，日志并停止该部分挂载 |
| 模型不支持图片 | 宿主拒绝；插件回「当前会话模型不支持图片输入」 |
| 插件重载 | 在途 `turns`、`requests`、审批/提问/引用表全丢；结果不会回帖 |
| 飞书限频 | 429 / `99991400` / `230020`；插件不重试，只记日志 |

## 14. 测试

```sh
npm run typecheck
npm run build
npm run smoke          # 配置解析 + 客户端渲染
npm run smoke-approval # 审批竞速 / 超时 / abort / 陌生 chat / 卡片结算
npm run smoke-cards    # 卡片形状 / 按钮值 / 提问聚合 / 超时 / 路由动作
npm run smoke-replies  # 引用路由表 + 回执抑制规则
npm run smoke-images   # 入站解析（text/image/post）+ 图片格式嗅探
npm run smoke-client   # 设置页渲染
npm run verify         # 以上全部
npm run rehearsal      # 真实 mount：token 0600、401/403/413/202、卸载清理
```

**真机验证记录**（2026-11-07）：审批卡片拒绝、提问卡片点击、引用回复路由、引用回复主聊天可见——均通过；`200340` 未出现。

## 15. 未交付与边界

- gateway 冷启动 / 外部网关（`src/gateway/` PARKED）。
- 微信接入（注释保留；需要企业微信应用或微信客服 + 公网回调）。
- 文件（非图片）/ 语音；图片已支持，但仅 PNG/JPEG/GIF/WebP ≤10 MB。
- 限频重试与消息分片。
- 多实例 / 一个实例多中控会话。
- 会话路由目录（按 chat 自动选目标会话）。
- 引用路由表只在内存，重载即丢。
- 群聊里被 allowlist 允许的任何成员都能决定同一群的审批/提问；要更严格就只配一个 `allowedUsers`。
