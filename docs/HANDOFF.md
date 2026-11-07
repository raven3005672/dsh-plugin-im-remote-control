# 交接文档（2026-11-07）

给接手的 agent：读这一份就够，不要从头翻会话记录。

## 项目

`~/github/dsh-plugin-im-remote-control` —— 飞书机器人远程控制 DSH 会话。
TypeScript，esbuild 产物在 `lib/`。`npm run verify` = typecheck + build + smoke + smoke-approval + smoke-cards + smoke-client。

## 当前可用的功能

| 能力 | 实现位置 | 状态 |
|---|---|---|
| 飞书长连接收消息（direct 模式） | `src/index.ts` mount() | ✅ |
| 群聊必须 @ 才处理；私聊不需要 | 同上，chat_type 判定 | ✅ |
| 收到消息贴表情：空闲 `OK`，忙 `OneSecond`（失败回落 OK） | `react()` | ✅ |
| 发送者白名单（备注名 + open_id，`allowedUsers`） | `admit()` + 设置页 | ✅ |
| `/whoami` 只回 open_id | direct 分支 | ✅ |
| 分发接口：`POST /im-remote-control/dispatch`（Bearer token + chat allowlist） | mount() | ✅ |
| 执行会话 turn/end → 插件按 requestId 回帖，首行 `【会话名】`，引用原消息 | `turn/end` 分支 | ✅ |
| 中控零输出（dispatch 成功后吞掉它的回执） | `dispatchAt` 120s 抑制窗口 | ✅ |
| 审批转发（`ask` 档，**卡片按钮** / 飞书 `/approve` `/deny`） | `src/approval.ts` + `src/cards.ts` + `approval/request` 监听 | ✅ |
| 提问转发（`ask_user_question`，**选项卡片** / `/answer`） | `src/questions.ts` + `src/cards.ts` + `user-questions/request` 监听 | ✅ |
| 设置页：中控会话 / 允许用户 / IM 勾选 / 飞书凭据 / 检测配置 | `src/client/Section.tsx` | ✅ |
| gateway 模式（冷启动） | `gatewayEnabled()` 返回 false | ⏸ 暂停 |

辅助脚本：`scripts/dispatch.mjs <chat> <session> "<text>" "<label>" "<messageId>"`、`scripts/mode.mjs status`、`lib/platform.mjs`（发现 host 端口）。

## 关键设计决定（别推翻）

1. **中控只分发不执行**：它调用 dispatch 后立刻结束回合，禁止 sleep / 读目标日志 / 总结。
2. **回帖归属在插件**：`requests: requestId → {chatId, messageId, label, dispatched}`；`turns: sessionId → {chatId, requestId, text, ...}`。绑定发生在 `user/message`（不是 `turn/start`）：`mode: 'queue'` 走 `agent.followup()`，排队消息自成一个回合，`rpcId` 只在 `user/message` 上到达；回合之间不重叠，所以按 session 绑定是安全的。
3. **gateway 模式暂停**：没有持久队列，崩了会丢消息。`lib/gateway.mjs` 不再构建，源码留在 `src/gateway/`。
4. **设置写入的坑**：行必须由**包的 bundle patch** insert，profile 层只放 override，否则 `settings/reject`（"overridden by a home patch"）。
5. **客户端改动刷新页面即可**；Host 改动必须重启 DSH。
6. **审批要 prepend**：`api-remotes` 的浏览器应答器也是 `approval/request` 监听器，而且先注册；不 prepend 就永远轮不到飞书。竞速的另一半是 `next()`：桌面没人点它就一直挂着，正好给飞书机会。
7. **桌面弹窗靠 `signal` 撤回**：瀑布流没有「撤回别人已经弹出的审批」的接口，网关只把 `request.signal` 当中转事件的生命周期。`ApprovalRegistry.ownLifetime()` 把这个字段换成自己可 abort 的 signal（镜像原 signal），远程一决定就 abort → 网关取消 pending 事件 → 浏览器收到 cancel 帧 → 弹窗和被它占住的输入框一起收回。请求对象被冻结时换不掉，降级成「只能本地关掉」。

## 刚做完：审批转发（2026-11-05）

人在飞书时，`ask` 档会话的审批可以远程批准。

- `src/approval.ts`：`ApprovalRegistry`（短 id / 120s 超时 / abort / 与桌面竞速 / 卸载清理）+ `parseApprovalCommand`。
- `src/index.ts`：`ctx.on('approval/request', …, { prepend: true })`；`turns` 里没有 chatId 绑定就直接 `next()`；`/approve` `/deny` 在 `admit()` 里先于投递识别，并校验 chatId 归属。
- `scripts/smoke-approval.mjs`：keyless，覆盖竞速 / 超时 / abort / 陌生 chat / 卸载。

结果映射：`/approve` → `allowed-once`、`/deny` → `rejected`、abort → `cancelled`、120s 超时 → `rejected` 并回帖告知。
通知文案：`【审批 <id>】<label|本会话> 要执行 <tool>，需要你确认` + 第二行 `displayReason.zh|en`（没有本地化才写 `原因：<reason>`）。

**已验证**：`npm run verify` 全绿（typecheck + build + smoke + smoke-approval + smoke-client）。

**真机联调（2026-11-06）**：飞书侧通了 —— 日志里 `/deny` → `approval fe5737 → rejected`、`/approve` → `approval ebbcd6 → allowed-once`，工具照常继续/报错，回合结果也回了飞书。但发现**桌面弹窗不消失**（输入框一直被占着）：插件抢先答完之后，网关那条已发给浏览器的 pending 事件没人取消。已按上面第 7 条修掉；`smoke-approval` 里有「远程决定 → 生命周期 abort → 转发出去的 prompt 被撤回」的覆盖。

**复测通过（2026-11-06 16:57）**：重启加载 16:54 的构建后走了一遍 `/approve`：插件日志 `approval ab0542 asked` → `sent 116 chars` → 27s 后 `approval ab0542 → allowed-once` → `sent 106 chars`；会话日志里 `approval/asked`(seq 90) → `approval/decided allowed-once`(seq 91) → 17ms 后 bash 出结果（exit 0，写文件成功）→ `turn/end completed`(seq 100)；`/Users/Shared/imrc-approval-test.txt` 内容 `approved`。桌面弹窗按预期消失，重启后无 warn。

接口事实（调研自 `packages/interaction/user-approval`，别再翻）：

```ts
ctx.on('approval/request', async (req, next) => ApprovalOutcome)
// req: { agent, toolName, callId?, reason?, displayReason?, signal? }
// req.agent.session.id → 查 turns 拿 chatId
// 返回 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

注意：策略 `never` 的会话不会产生审批请求，这个功能只对 `ask` 档有意义。

## 刚做完：卡片审批与提问（2026-11-07）

审批和 `ask_user_question` 现在都以飞书交互卡片（card 1.0）发到 chat；文本命令保留为 fallback。

- `src/cards.ts`：纯函数卡片构造 + `parseCardAction`。按钮 value 形如 `{ k: 'approval', id, v: 'allow' }` / `{ k: 'question', id, q, v: label }`；结算后卡片原地更新成结果。
- `src/approval.ts`：新增 `resolveCard` / `attachCard` / `noticeOf`；`resolved(notice, messageId, resolution)` 在结算后 patch 卡片（`allowed-once` / `rejected` / `timeout` / `cancelled`）。
- `src/questions.ts`：`QuestionRegistry`，与审批同构的竞速（`prepend` + `next()` + `ownLifetime` 撤回桌面提示）；5 分钟超时只撤卡片、不替你回答；多问题聚合进度；多选/自定义走 `/answer <id> <文本>`。
- `src/index.ts`：`sendCard`/`patchCard`（`im.message.create` + `im.message.patch`）；`card.action.trigger` 回调按 chatId + operator allowlist 校验后结算，返回 `{ toast, card: { type: 'raw', data } }`；`/answer` 在 `admit()` 里先于投递识别。
- 卡片发送失败自动退回纯文本通知（审批/提问都一样），文本命令始终可用。

**配置前提**：开发者后台「回调配置」里的 `card.action.trigger` 必须设为**长连接**并发布版本；只订阅 `im.message.receive_v1` 不配回调时，点按钮报 `200340`。

**已验证**：`npm run verify` 全绿（新增 `scripts/smoke-cards.mjs`：卡片形状、按钮值、答题聚合、竞速、超时、abort、dispose、本地先答）；`npm run rehearsal` 通过。

**真机验证（2026-11-07 16:04–16:06，机器人发布 + 回调配置完成后）**：

- **提问卡片**：`question c4abc5 asked` → 卡片 `om_x100…` → 16:04:25 点击 → `question c4abc5 answered from card (ou_6bfe…)` → 无 patch 错误 → 16:04:26 回合继续并回帖（45 字符）。卡片更新为「已回答」。
- **审批卡片**：`approval 768369 asked (bash)` → 卡片 `om_x100…` → 16:06:06 点「拒绝」→ `approval 768369 → rejected from card` → 工具被拦、目标文件未写 → 16:06:09 回帖（301 字符）；无 patch 错误。
- `200340` 未出现（「卡片回传交互」长连接配置已生效）。
- 待补：点「批准」路径（与拒绝共用同一回调，风险低）；桌面弹窗撤回的肉眼确认。

## 2026-11-07 引用回复路由修复（真机发现）

**现象**：审批卡片测试里点了「拒绝」，飞书收到 `【审批卡片测试】…` 的结果（执行会话问「用哪种方式？」）。用户**引用**这条消息回复「3」，结果中控会话收到了「3」——中控不知道它对应哪个执行会话，流程中断。

**原因**：所有入站文本都投给中控；`im.message.receive_v1` 里的 `parent_id`/`root_id`（引用/线程关系）被忽略，结果消息的 message_id 也没有留档。

**修复**：
- `src/replies.ts`：`QuotedRoutes`，出站结果 message_id → `{ sessionId, chatId, label }`，24h / 200 条上限，跨 chat 不匹配。
- `sendToChat` / `replyTo` 返回 Feishu message_id；`turn/end` 发完结果后登记。
- 入站解析 `parent_id ?? root_id`；`admit()` 命中路由时把消息投给源会话（带原 label），不再进中控。`promptSession()` 抽出复用。
- `scripts/smoke-replies.mjs`：命中 / 跨 chat / 未知 / 过期 / 淘汰 / 可选 label。

**已验证**：`npm run verify` 全绿（新增 `scripts/smoke-replies.mjs`）。

**真机复测（2026-11-07 16:10:18）**：dispatch 一条结果到 chat，用户引用该结果回复「3」，日志：

```
quoted reply om_x100b61d980502cb4b0fab745200489d → session-9ce7213e-8bb6-4271-bfbe-c9a8e29f4d45
admitted om_x100b61d980502cb4b0fab745200489d → session-9ce7213e-8bb6-4271-bfbe-c9a8e29f4d45 (direct)
```

中控会话没有收到这条回复，路由生效。注意：只有**重载之后**发出的结果消息才在路由表里（24h / 200 条），更早的结果引用仍会进中控。

**续（2026-11-07 16:17，用户反馈「session 收到了 3 但没回飞书」）**：查聊天记录发现回复其实发了，但 `im.message.reply` 把结果挂成了「用户那条 3 的线程回复」，飞书折叠在线程里，主聊天看不到。改为：**引用回复产生的回合结果直接发主聊天**（`replyTo(undefined, …)`，即 `sendToChat`），不再挂线程。验证：16:17:53 引用 → 16:17:55 `sent 47 chars`，消息 API 里该消息 `parent_id` 为空（TOP），主聊天可见。

顺带确认：之前多条引用回复的结果其实都发出去了，只是都藏在以用户消息为父的线程里；现在改为顶层，`sent` 日志也回来了。

## 2026-11-06 审查修复（Claude Code + 本 agent 双审）

按开发手册（`docs/cordis-tutorial`、`package-surface`、`defensive-patterns`、`adding-a-settings-card`）审了一轮，修掉的：

- **dispatch 鉴权**：改 Bearer token（每次挂载随机生成，`~/.dsh/im-remote-control.token` 0600，卸载删除）；`chatId` 必须命中 `allowedChats`；超限 413；`scripts/dispatch.mjs` 自动读 token。
- **allowlist fail-closed**：类型写错直接报错；`allowedChats` 与用户白名单都空时拒绝启动（不再「空 = 不限制」）。
- **shared 配置**：legacy 字段去掉 schema 默认值，`appId/appSecret/sessionId/allowedChats` 显式按 row → shared 回落；shared JSON 损坏会写 warn。
- **审批竞速**：`unavailable` 和本地异常不再算「决定」，继续等飞书或 120s 超时（旧实现会把刚发出的审批瞬间作废）。
- **设置页**：新增用户不再被 name 的 blur 过滤掉；写入失败/冲突会显示；行 key 稳定；App Secret 改 `role('secret')` 只写不回显；`channels` 勾选现在真的生效（空数组 = 不连飞书）。
- **回帖**：只发最后一步 assistant 文本；`turn/end` 的 error/aborted/blocked 等会回一句提示；`/whoami` 移到 allowlist 之后。
- **杂项**：优先 `DSH_HOME`、日志 0600、smoke 不再污染真实日志、探测请求带 10s 超时、入口只保留 Loader 四件套（`lib/approval.js` 单独构建）。

**验证**：`npm run verify` 全绿；`npm run rehearsal`（假凭据 + 临时路径跑真实 mount）覆盖 token 0600、401/403/413/202、卸载删 token；profile 配置加一行注释触发 HMR 后，运行中的进程已重载新代码（日志 21:40:12），真实端口上实测无 token / 错 token / 旧 header → 401、越界 chat → 403。

**未做（记录在案）**：dispatch 的 target session 仍不设白名单（中控要投任意会话）；`/check` 仍只靠自定义头（只读）；gateway 死代码未清理；`requests` 没有 TTL；设置页仍直接订阅 form（未用 hooks 席位）与内联样式。

## 2026-11-06 第二轮复审（Claude Code + 本 agent）

对修复轮做了一次独立复审。**确认为真并已修**：

- `allowedUsers`/`allowedOpenIds` 的 `.default([])` 吃掉了 shared 回落（只配 shared 白名单会退化成「只按 chat 放行」）→ 去掉默认值。
- dispatch 的 `chatId` 校验在 `allowedChats` 为空时被跳过 → 改为无条件要求 `allowedChats.has(chatId)`（没有发送人身份时只能用 chat 做边界）。
- `replyTo` 的 reply 通道不走截断 → 抽出 `truncate()` 两路共用，后缀计入上限。
- 删除用户时若同时有未完成行，删除被跳过 → 删除直接写已保存行，未完成行本地丢弃。
- Secret 写入失败也会清空 draft；点「显示」按钮触发 blur 提交并清空 → 只在成功后清空，眼睛按钮 `onMouseDown` 阻止 blur。
- 设置页一个 effect 重置所有草稿 → 拆成 session/appId 与用户列表两个 effect。
- `mode.mjs gateway` 先写配置再拒绝 → 拒绝提前；`gateway-old` 死分支删除；路径改读 `DSH_HOME`。
- `NO_DECISION` 模块级共享导致每个 ask 挂一条永久 reaction → 改成每个 ask 自己的 never-promise。
- dispatch body 为 `null` 时 `body.chatId` 抛错 → 显式校验为对象。
- token/日志：删除前比对内容（不误删新实例的 token）、写入后 `chmod 0600`。
- README 的「必须用 insert」是错的（bundle patch 已经 insert，profile 层应裸行覆盖，否则出现两条同 id 行）→ 已改；首次配置的 `/whoami` 引导也改成先填一项 allowlist。

**确认为误报**：Claude 认为 `turns` 只按 sessionId 绑定会在两个 chat 之间互相覆盖/串审批。实际 `mode: 'queue'` 是 `agent.followup()`（每条消息自成一个回合，回合不重叠），绑定按回合切换是正确的；HANDOFF 里原来「排队消息被 spliced 进当前回合」的说法才是错的，已修正。

**第二轮收尾时又做了**：
- 配置错误用 `ConfigError` 承接，`apply` 只吞这一类；其他异常抛回 Loader → fiber FAILED（不再静默半挂载）。
- allowlist 为空不再直接 throw：插件照常注册 `/check` 和 token，然后返回（探测可用，dispatch/WS 不启动）；配置页提示同步改成「接口不可用：插件可能未启动/未配置 allowlist」。
- smoke 增加 `IMRC_TOKEN_PATH` 到 `/tmp`，避免误写真实 token。

**仍未修（记录在案）**：
- `/check` 无 token（只读）。
- 探测用挂载时凭据，改完配置不重启测的是旧值。
- `channels: []` 会连带停掉 token/路由（飞书关了 dispatch 本来也没意义，但页面提示不准确）。
- 设置页仍直接订阅 form、内联样式、硬编码中文（手册偏离）。
- `apply()` 吞异常导致部分挂载可能；`requests` 无 TTL；`dispatchAt` 用 120s 时间窗；`/check` 405 语义；gateway 死代码。

## 发布前整理（2026-11-06）

- **清理**：去掉 `coldStart` / `mode` 两个未读取的 schema 字段、冷启动镜像代码、`SharedConfig`/`logger` 类型、客户端未用的 `Switch`；网关源码统一走 `DSH_HOME`、凭据读 `feishu.*` 并标注 PARKED。
- **README 重写**：按实际交付功能写（飞书 direct 模式、回帖规则、dispatch token、审批转发、设置页、安全模型、飞书频控与不重试、限制、运维排障、开发、路线图）；删除所有 gateway/微信的过时描述。
- **发布准备**：`package.json` 补 `repository`/`homepage`/`bugs`；`npm pack --dry-run` = 9 个文件（LICENSE、README、cordis.patch.yml、icon.png、lib/*、package.json），118.1 kB；`verify` + `rehearsal` 全绿。
- **图标**：`icon.png`（256×256 RGBA，来自 `~/github/deepseek-assets/icon/transparent/24-ticker-tape.png`），`package.json` 的 `icon` 字段声明；宿主规则是「包内相对路径、SVG/PNG/JPEG/WebP、≤256 KiB」，会被转成 data URI 显示在插件列表。
- **设置页 Secret 体验**：新增 `GET /im-remote-control/status`（返回 `appId/appSecret/sessionId/allowlist` 四个布尔值 + `appSecretHint` 掩码），页面据此显示「已配置（****末四位）/ 未配置」、动态占位符和「清除」；眼睛按钮在没有内容时禁用。明文仍只留在 Host。
- 线上进程仍跑 22:15 的构建（只差这次清理的 schema 字段），下次重启生效；对当前配置无行为变化。

## 下一件事：路由目录

`~/.dsh/im-remote-control.routes.json`（名称 / openId / sessionId / 用途 / 关键词），`scripts/routes.mjs suggest` 自动补未登记会话，中控每轮读它；只是不再靠标题猜。

## 更后面的待办

1. 排队条数提示（现在只有表情）。
2. 微信接入（占位代码与配置已在 2026-11-06 注释掉，恢复时全仓搜 `微信接入暂缓`）。

## 环境

- 日志：`~/.dsh/im-remote-control.log`（含 smoke 噪声，可忽略）。
- 配置：profile `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 override 行。
- 飞书应用：`cli_<app-id>`（自建应用 App ID，在飞书开放平台查看），机器人名「DSH总控」。
- 中控会话：`session-<controller-id>`（本机 profile 里配置的 `controllerSessionId`）。
