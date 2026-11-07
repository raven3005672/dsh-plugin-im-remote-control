# dsh-plugin-im-remote-control

用飞书（Lark）机器人远程控制一个 DSH 会话：消息进会话，回合结果回到聊天，`ask` 档的审批可以在飞书里远程批准。

> 当前版本只交付 **direct 模式**：插件自己持有飞书长连接，不需要公网 IP。微信接入和 gateway 冷启动模式**尚未交付**，代码保留但未启用（见「路线图」）。

## 功能

| 能力 | 说明 |
|---|---|
| 飞书长连接 | 插件进程内持有 WebSocket，不需要公网回调地址 |
| 私聊 / 群聊 | 私聊直接处理；群聊必须 @ 机器人 |
| 消息进会话 | 走 `sessionController.prompt`，模型看到的与桌面输入框一致，不绕过 session log |
| 回合回帖 | 回合结束把**最后一步**的 assistant 文本发回聊天；`dispatch` 来的任务带 `【会话名】` 首行 |
| 表情回执 | 收到消息贴 `OK`；会话正忙时贴 `OneSecond` |
| 分发接口 | 中控会话把任务投给任意会话，回复绑定由插件负责（Bearer token + chat allowlist） |
| 审批转发 | `ask` 档会话的审批以**卡片**发到飞书，点按钮或回 `/approve` / `/deny` 决定，与桌面弹窗竞速 |
| 卡片提问 | `ask_user_question`（选方案、计划确认）以**卡片**发到飞书，选项即按钮；多选/自定义用 `/answer` |
| 设置页 | 中控会话、允许用户、飞书凭据（只写 + 掩码状态 + 清除）、渠道开关、配置探测（设置 → 远程控制） |
| `/whoami` | 返回发送者 open_id，用于配置 allowlist |

未交付：微信、gateway 冷启动、图片/文件、超限重试、多实例。

## 工作方式

```
飞书（私聊 / 群聊 @）
  │  WebSocket 长连接（插件持有，无公网地址）
  ▼
dsh-plugin-im-remote-control（Host）
  ├─ sessionController.prompt  → 目标会话新增一条 user 消息
  ├─ ctx.on('session/event')   → 回合结束把结论回帖
  ├─ ctx.on('approval/request')      → 卡片审批（按钮 / /approve /deny）
  ├─ ctx.on('user-questions/request')→ 卡片提问（选项按钮 / /answer）
  ├─ card.action.trigger             → 按钮点击结算，更新卡片
  └─ ctx.webServer                   → /dispatch（Bearer）/ /check（探测）/ /status（状态）
```

- `requests: requestId → chat` 记录本次投递属于哪个聊天；`user/message` 事件里带回 `rpcId`，据此绑定 `turns: sessionId → chat`。
- `mode: 'queue'` 在宿主里是 `agent.followup()`：每条消息自成一个回合，回合之间不重叠，所以按 session 绑定是安全的。
- 只有插件自己投递过的回合才回帖；桌面里手动发起的回合不受影响。

## 安装

```sh
# 从 npm 安装
dsh plugin --profile <profile> add dsh-plugin-im-remote-control

# 或者从 git checkout 安装：先装依赖并构建（lib/ 不入库）
cd /path/to/dsh-plugin-im-remote-control && npm install && npm run build
dsh plugin --profile <profile> add /path/to/dsh-plugin-im-remote-control
```

包的 `dsh.bundle.patch` 已经 **insert** 了插件行。profile 的 `cordis.patch.yml` 里只加一条**同 id 的覆盖行**（不要再 `insert` 一次：两条同 id 的行会各自挂载——两个飞书长连接、两份 token，而且设置页找不到这一行）：

```yaml
- id: dsh-plugin-im-remote-control
  name: dsh-plugin-im-remote-control
  config:
    feishu:
      appId: cli_xxxxxxxxxxxxxxxx
      appSecret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    controllerSessionId: session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    channels: [feishu]
    allowedChats:
      - oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    allowedUsers:
      - name: 我自己
        openId: ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    ack: true
    reply: true
```

覆盖行的 `config` 是**整体替换**而不是深合并，需要哪些键就写全。

然后**重启 DSH**：Host 半边只在启动时加载，配置改动也只在重启后应用到连接。之后可以在「设置 → 远程控制」里编辑同样的字段（设置页的改动同样需要重启才生效）。

### 飞书应用准备

1. 在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**，开启「机器人」能力。
2. 权限：接收消息（`im:message`、`im:message.group_msg`）、以应用身份发消息（`im:message:send_as_bot`）。
3. 事件订阅选**长连接**，订阅 `im.message.receive_v1`。这一步不需要公网地址。
4. **回调配置**页把 `card.action.trigger` 也设为**长连接**（这是「卡片回传交互」，不在事件订阅页）。少了这一步，点卡片按钮会报 `200340`。
5. 发布版本，把机器人加进目标会话，或者在私聊里使用。
6. 用 `/whoami` 拿到自己的 open_id，填进 `allowedUsers`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `feishu.appId` / `feishu.appSecret` | 空 | 自建应用的凭据。设置页对 App Secret **读不到明文**：只显示「已配置（\*\*\*\*末四位）/ 未配置」，保存后不回显，留空表示不修改，另有「清除」 |
| `controllerSessionId` | 空 | 中控会话 ID；兼容旧字段 `sessionId` |
| `channels` | 未设置 = 飞书 | 支持的渠道列表；`[]` 表示不连飞书 |
| `allowedChats` | 无 | 允许的 chat_id 列表 |
| `allowedUsers` | 无 | `{ name, openId }` 列表；openId 会并入 `allowedOpenIds` |
| `allowedOpenIds` | 无 | 直接按发送者 open_id 限制 |
| `ack` | `true` | 收到消息是否贴表情回执 |
| `reply` | `true` | 回合结束是否回帖 |
| `enabled` | `true` | `false` 时不启动（连探测路由也不注册） |

旧字段 `appId` / `appSecret` / `sessionId` 仍然可用，优先级低于 `feishu.*` / `controllerSessionId`。

**访问控制是 fail-closed 的**：`allowedChats`、`allowedUsers`、`allowedOpenIds` 至少要配一项，否则插件只注册设置页的配置探测、不连飞书（日志 `no access control configured`），dispatch 和消息处理都不会启动。数组类型写错会直接报错，不会被当成「空 = 不限制」。首次配置可以先填自己的 open_id（或者临时一个 chat），重启后用 `/whoami` 校准。

共享配置文件 `$DSH_HOME/im-remote-control.json`（默认 `~/.dsh/im-remote-control.json`）可以作为兜底来源：`feishu.*`、`appId`、`appSecret`、`sessionId`、`allowedChats`、`allowedUsers`、`allowedOpenIds`、`channels`、`ack`、`reply`、`enabled`、`mode`。行里显式给出的值优先，数组类 allowlist 取并集。它主要服务两个场景：凭据不写进 profile 的部署，以及（尚未交付的）外部网关。

## 命令

| 命令 | 作用 |
|---|---|
| `/whoami` | 回复发送者的 open_id |
| `/approve <id>` | 批准一次审批（`allowed-once`） |
| `/deny <id>` | 拒绝一次审批（`rejected`） |
| `/answer <id> <文本>` | 回答提问；多选可用逗号分隔选项，自定义回答直接写文本 |

群聊里发命令也要 @ 机器人；私聊不需要。

## 审批转发

会话处于 `ask` 审批档时，需要确认的工具调用（例如写工作区外的文件）会把审批以交互卡片发到绑定的飞书会话：

```
需要审批 · bash          [批准一次] [拒绝]
会话：股票分析
工具：bash
允许本次操作使用 danger-full-access 权限：需要写入工作区外
审批 3fa9c1 · 120 秒内有效 · 也可回复 /approve 3fa9c1
```

第三行是提问方给的说明：有本地化文案就用本地化，没有才退回 `原因：<原始 reason>`。

| 操作 | 结果 |
|---|---|
| 点「批准一次」或 `/approve <id>` | `allowed-once`，只授权这一次 |
| 点「拒绝」或 `/deny <id>` | `rejected` |
| 回合被中止 / 请求撤销 | `cancelled` |
| 120 秒没人回 | 自动 `rejected`，并回帖告知 |

决定后卡片会原地更新成结果（已批准 / 已拒绝 / 已超时），按钮消失，避免重复点击。卡片发送失败时自动退回纯文本通知（仍可用 `/approve` / `/deny`）。

**和桌面竞速**：插件用 `prepend` 抢在浏览器应答器之前注册监听，所以两边同时在等，谁先决定谁生效。飞书先答时，桌面那个弹窗（连同被它占住的输入框）会被撤回；桌面先答时，飞书里的 id 随即失效（再回会得到「没有待审批的请求」）。

只有绑定过 chat 的会话才会转发审批（飞书消息投递进来的，或 `dispatch` 进来的）；桌面上手动发起的会话照旧走桌面弹窗。

注意：`never` 档的会话不会产生审批请求，这个功能只对 `ask` 档有意义。

## 提问转发

agent 调用 `ask_user_question`（选方案、确认计划、补充缺失信息）时，如果这一轮是从飞书投递进来的，问题会以卡片发到同一个 chat：

- **有选项**：每个选项一个按钮，点一下即作答；
- **多选**：卡片列出选项，回复 `/answer <id> 选项1,选项2`；
- **没有选项 / 想自由回答**：回复 `/answer <id> <文本>`。

```
需要你回答
1. 用哪个包管理器？
[A] [B]
请求 cd34ef · 300 秒内有效 · 自定义回答：/answer cd34ef <文本>
```

卡片 5 分钟内有效；超时只撤回卡片，桌面弹窗继续等（不会替你拒绝）。和审批一样，飞书先答会撤回桌面提示，桌面先答会把卡片改成「已在其他界面处理」。多个问题时，答完一个卡片会更新进度，全部答完才把结果交回模型。

`/answer <id>` 里的 id 就是卡片底部那个 id；它和审批 id 一样是 6 位十六进制。

## 本地路由与鉴权

| 路由 | 用途 | 鉴权 |
|---|---|---|
| `POST /im-remote-control/dispatch` | 中控把任务投给任意会话 | `Authorization: Bearer <token>`，且 `chatId` 必须在 `allowedChats` 里 |
| `POST /im-remote-control/check` | 设置页的只读配置探测（3 次飞书调用） | 自定义头 `x-imrc-check: 1` |
| `GET /im-remote-control/status` | 设置页读取「哪些字段已配置」 | 无（布尔值 + App Secret 的掩码 `****abcd`，不含明文） |

token 每次挂载随机生成，写到 `$DSH_HOME/im-remote-control.token`（0600，卸载即删）。[scripts/dispatch.mjs](scripts/dispatch.mjs) 会自动读它；手工调用必须自己带上。

`/check` 只发三个只读请求（换 token、机器人信息、会话列表），不改状态，所以没有加 token；它有 10 秒超时。`/status` 只回答「哪些字段已配置」和一个末四位掩码，任何请求都拿不到密钥明文。

## 安全模型

- **飞书账号就是执行权**：allowlist 里的账号（或群里被 allowlist 允许的成员）能让 agent 执行 shell、读写文件。请给飞书账号开二次验证，并保持 allowlist 尽量小。
- **同一系统用户下的进程互相信任**：token、配置、会话日志都是 0600，能读它们的进程本来就能修改插件或配置；token 挡的是其他用户和随手脚本。
- **模型服务能看到消息内容和工具结果**：这些内容在对话上下文里，和桌面使用没有区别。
- **审批档决定有没有刹车**：从飞书驱动的会话建议用 `workspace-write` + `ask`；`danger-full-access` + `never` 等于让远程消息直接执行任何操作。

已实现的防护：allowlist fail-closed、dispatch Bearer token + chat allowlist、App Secret 只写且最多回末四位掩码、审批 120 秒超时拒绝（fail-closed）、跨 chat 不能批准别人的审批、日志不记录消息正文。

DSH 的 GUI 有独立的浏览器认证（回环绑定、每进程随机启动 token、签名 cookie，未认证 401、跨站 403），但上面三条 `/im-remote-control/*` 路由是插件直接注册在 Host web server 上的，**不经过这层 cookie 认证**：`dispatch` 用独立 Bearer token，`/check` 和 `/status` 只读、只返回探测结果和掩码。它们默认只出现在回环地址上；如果把 Host 绑到非回环地址，这三条路由也会跟着暴露（`/status` 最坏泄露四个布尔值和末四位掩码）。

## 限制与已知问题

- **只支持文本**：图片、文件不会转发。
- **回帖只发最后一步**的 assistant 文本，过程叙述不发；超过 3500 字符按开头截断（飞书文本上限是 150 KB，这个值是本插件自己的上限）。
- 回合以 `error` / `aborted` / `blocked` 等原因结束且没有文本时，会回一句「回合出错/被中止」，而不是静默。
- **一个实例只驱动一个 `sessionId`**；一个飞书应用只能有一条长连接（不要再同时跑外部 bridge）。
- 审批只对 `ask` 档生效；群聊里**被 allowlist 允许的成员**都能批准同一个群里的审批，要更严格就只配 `allowedUsers` 一个人。
- **插件重载会丢正在进行的回合的回帖绑定**：重载时如果还有 `dispatch` 在跑，那个回合的结果不会自动回到飞书。
- 首次配置必须先给出一项 allowlist，否则插件不连飞书，`/whoami` 也用不了。
- 设置页的 App Secret 保存后不回显明文：只显示「已配置（\*\*\*\*末四位）」，Host 之外只出现这四个字符；要更换就粘贴新值，要删除点「清除」。
- **卡片按钮需要飞书回调配置**：开发者后台「回调配置」里的 `card.action.trigger` 必须设为长连接并发布版本；只订阅事件、不配回调时，点按钮会报 `200340`，但文本命令 `/approve`、`/deny`、`/answer` 仍然可用。

### 飞书接口频率限制

飞书开放平台对每个 API 按「应用 × 租户」限频，主流档位是 **1000 次/分钟 & 50 次/秒**，个别接口更低（10/20/100 次/分钟 或 1–100 次/秒），详见[频控策略](https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control)。发送消息还有额外限制：**同一用户 5 QPS**，**同一群内所有机器人共享 5 QPS**；文本消息体最大 150 KB（[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)）。

超限时飞书返回 **HTTP 429 + `code: 99991400`**（部分旧接口是 400），响应头 `x-ogw-ratelimit-reset` 给出建议等待秒数；发消息接口也可能返回 `230020`。

本插件的用量：收消息走长连接**不消耗接口配额**；每条消息大约 1–2 次调用（贴表情 + 回帖），审批每条 1 次，设置页「检测配置」3 次。个人使用离上限很远。

**插件不做重试**：一旦触发限频，只会写一条 `reply failed` / `approval notify failed` 日志，那条回复就丢了。需要重试的话可以按 `x-ogw-ratelimit-reset` 等待后重发（`im/v1/messages` 还支持用 `uuid` 去重）。

## 运维

| 东西 | 位置 |
|---|---|
| 日志 | `$DSH_HOME/im-remote-control.log`（默认 `~/.dsh/im-remote-control.log`），0600 |
| dispatch token | `$DSH_HOME/im-remote-control.token`，0600，挂载时写入、卸载时删除 |
| 共享配置 | `$DSH_HOME/im-remote-control.json` |
| 持久化会话 | DSH 自己的 `$DSH_HOME/sessions/` |

`DSH_HOME` 环境变量优先，未设置时用 `~/.dsh`，和 DSH 的 home 解析一致。

**改配置要重启 DSH**（Host 代码只在启动时加载）；改设置页后同样要重启才应用到连接。设置页本身是客户端代码，更新插件后刷新浏览器即可。

排障：

| 现象 | 先看 |
|---|---|
| 飞书发消息没反应 | 日志里有没有 `admitted` / `ignored sender` / `ignored chat` |
| 回合结束没有回帖 | 这条回合是不是从飞书或 dispatch 发起的；日志里的 `bound` / `sent` |
| 没有收到审批 | 会话是不是 `ask` 档；这条回合有没有绑定 chat；日志 `approval <id> asked` |
| `/approve` 回「没有待审批的请求」 | id 抄错，或已超过 120 秒 |
| dispatch 返回 401 | token 文件不存在或已轮换；重启 DSH 或重读文件 |
| 日志 `no access control configured` | 先配 `allowedChats` 或 `allowedUsers` 再重启 |

启停：把行 `disabled: true`（或 `enabled: false` 配置项）后重启；彻底移除用 `dsh plugin --profile <profile> remove dsh-plugin-im-remote-control`。

## 开发

```sh
npm run typecheck   # tsc --noEmit
npm run build       # lib/index.js + lib/client.js + lib/approval.js + lib/platform.mjs
npm run smoke       # 配置解析 + 审批状态机 + 客户端渲染（无网络、无凭据）
npm run rehearsal   # 真实 mount 演练：假凭据 + 临时路径，验证 token/路由/鉴权/卸载（会连一次飞书）
npm run verify      # typecheck + build + smoke
```

产物：`lib/index.js`（Host）、`lib/client.js`（设置页）、`lib/approval.js`（审批状态机，独立产物供测试）、`lib/platform.mjs`（脚本用的平台适配）；`icon.png` 是插件列表图标（256×256 PNG，宿主限制 ≤256 KiB）。`src/gateway/` 是暂停的网关源码，不构建、不随包发布。

目录：

```
src/index.ts          Host 半边：连接、投递、回帖、路由、审批接线
src/approval.ts       审批状态机（短 id、超时、abort、竞速、撤回）
src/types.ts          手写的窄契约（只描述本插件用到的宿主接口）
src/client/           设置页（settings.section）
src/gateway/          暂停的网关源码（不构建）
src/platform/         平台适配（发现 host 端口、启动应用、登录服务）
scripts/              build / smoke / rehearsal / dispatch / mode
docs/HANDOFF.md       交接文档：设计决定、接口事实、未做事项
```

**类型策略**：Host 与 Client 各自声明本插件用到的那部分契约，不直接依赖 `@deepseek-ai/dsh-*` 的发布类型。好处是运行时隔离，代价是宿主升级不会让本仓库的 `tsc` 失败——手写契约会静默漂移，升级 DSH 后要按 `docs/HANDOFF.md` 里的接口事实抽查一遍。

## 路线图

1. **路由目录**：`~/.dsh/im-remote-control.routes.json` 记录会话名称、用途、关键词，中控每轮读它，不再靠标题猜。
2. 排队条数提示（现在只有表情）。
3. 微信接入（企业微信自建应用或微信客服，需要公网回调网关）。
4. gateway 冷启动模式：先补持久队列和按 chat 的回复绑定，再重新构建 `src/gateway/`。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-plugin-im-remote-control
```

然后删掉 profile `cordis.patch.yml` 里的覆盖行并重启 DSH。日志、token、共享配置文件可以直接删除。

## License

MIT
