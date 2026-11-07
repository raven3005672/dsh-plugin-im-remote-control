/**
 * Host half of im-remote-control: a Feishu bot that drives one DSH Session.
 *
 * Two modes, chosen by the shared config file `~/.dsh/im-remote-control.json`
 * (which the external gateway also reads):
 *
 * - `direct`  — this plugin owns the Feishu long connection. Works only while
 *               DSH is running; no cold start.
 * - `gateway` — an external gateway owns the long connection, so a message can
 *               wake a closed DSH. The plugin then answers one authenticated
 *               local route instead of connecting to Feishu.
 *
 * In both modes a message enters through `ctx.sessionController.prompt`, so the
 * model sees exactly what the desktop composer would have produced. A session
 * whose turn was admitted from a chat is also answerable from that chat: its
 * turn result is posted back, and an approval ask can be decided with
 * `/approve` or `/deny` (see {@link ApprovalRegistry}).
 *
 * The packaged app exposes no reachable stdout, so diagnostics also go to
 * `~/.dsh/im-remote-control.log`. Mount failures are logged, never thrown: an
 * optional bridge must not keep the application from booting.
 *
 * @module dsh-plugin-im-remote-control
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import * as Lark from '@larksuiteoapi/node-sdk'
import z from '@deepseek-ai/schemastery'
import { ApprovalRegistry, parseApprovalCommand } from './approval.ts'
import type { ApprovalCommand, ApprovalNotice } from './approval.ts'
import {
  approvalCard,
  approvalResolvedCard,
  parseCardAction,
  questionCard,
  questionClosedCard,
} from './cards.ts'
import { parseAnswerCommand, QuestionRegistry } from './questions.ts'
import type { QuestionCommand, QuestionNotice } from './questions.ts'
import type {
  HostContext,
  PromptTextPart,
  RawConfig,
  SessionEventLike,
  SessionLike,
} from './types.ts'


/** Cordis plugin name used by loader diagnostics. */
export const name = 'im-remote-control'

/** Services this plugin needs: the Session it drives, and the route host. */
export const inject = ['sessionController', 'webServer']

/**
 * Settings document served to the Settings page.
 *
 * Volatile fields are the editable ones. `coldStart` is the UI face of the
 * gateway's `autoStart`, mirrored into the shared config file at mount.
 */
export const Config = z.object({
  controllerSessionId: z.string().default('').volatile(),
  channels: z.array(z.string()).volatile(),
  feishu: z.object({
    appId: z.string().default(''),
    // A secret role keeps the value out of form responses; the page can only
    // overwrite it, never read it back.
    appSecret: z.string().role('secret').default(''),
  }).default({}).volatile(),
  // 微信接入暂缓（2026-11-06）：先注释掉占位字段，恢复时取消注释。
  // wechat: z.object({}).default({}).volatile(),
  // No defaults: an absent list must fall through to the shared config file,
  // while an explicit empty list keeps meaning "no rows".
  allowedUsers: z.array(z.object({ name: z.string().default(''), openId: z.string().default('') })).volatile(),
  allowedOpenIds: z.array(z.string()).volatile(),
  // Legacy and transport-only fields. No defaults: an absent field must fall
  // through to the shared config file instead of erasing it.
  appId: z.string(),
  appSecret: z.string().role('secret'),
  sessionId: z.string(),
  allowedChats: z.array(z.string()),
  ack: z.boolean(),
  reply: z.boolean(),
  enabled: z.boolean(),
})

/**
 * A configuration value the plugin cannot run with. The entry point logs it and
 * stays inert instead of failing the application; any other thrown error is a
 * programming fault and propagates so the Loader reports FAILED.
 */
class ConfigError extends Error {
  /**
   * @param message - what the operator must configure.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Accepted-and-idle marker; every tenant supports it. */
const IDLE_EMOJI = 'OK'

/** Queued-behind-a-running-turn marker (飞书「稍等」). */
const BUSY_EMOJI = 'OneSecond'

/** Feishu rejects oversized text bodies; long answers are truncated, not split. */
const MAX_REPLY_CHARS = 3500

/** Remembered message ids used for redelivery deduplication. */
const SEEN_LIMIT = 500

/** Ceiling for one Feishu probe call; the settings check must answer. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * How long a chat may take to answer an approval before it is rejected. The
 * tool call is blocked while the ask is pending, so the wait is bounded; a
 * rejection is the fail-closed outcome the approval service already documents.
 */
const APPROVAL_TIMEOUT_MS = 120_000

/**
 * How long a question card stays actionable. A question is not a fail-closed
 * decision: a timeout withdraws the card and leaves the rest of the answerer
 * chain to handle the request, exactly as if this plugin were not mounted.
 */
const QUESTION_TIMEOUT_MS = 5 * 60_000

/** Gateway-mode inbound route registered on the Host WebServer. */
const INBOUND_PATH = '/im-remote-control/inbound'

/**
 * Gateway mode is parked: the transport has no durable queue yet, so a gateway
 * crash can drop messages that direct mode would simply never receive. Flip this
 * back to `true` once the queue and per-chat reply binding land.
 */
function gatewayEnabled(): boolean {
  return false
}

/** Settings-page probe route. */
const CHECK_PATH = '/im-remote-control/check'

/** Settings-page status route: which non-secret facts the Host resolved. */
const STATUS_PATH = '/im-remote-control/status'

/**
 * Harness home: `$DSH_HOME` when the deployment sets one, else `~/.dsh`. The
 * harness resolves its own home the same way, so logs and the shared files
 * stay beside the profile they belong to.
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Diagnostics file; the packaged app has no reachable stdout. */
const LOG_PATH = process.env.IMRC_LOG_PATH ?? join(DSH_HOME, 'im-remote-control.log')

/** Shared mode/config file, read by this plugin and the external gateway. */
const CONFIG_PATH = process.env.IMRC_CONFIG_PATH ?? join(DSH_HOME, 'im-remote-control.json')

/** Bearer token for the local routes; written here and read by the scripts. */
const TOKEN_PATH = process.env.IMRC_TOKEN_PATH ?? join(DSH_HOME, 'im-remote-control.token')

/** Whether the log directory has been prepared for this process. */
let logDirReady = false

/** One inbound message in either transport. */
interface InboundMessage {
  readonly messageId: string
  readonly chatId: string
  readonly openId?: string
  readonly text: string
}

/** One probe result rendered by the Settings page. */
interface ProbeStep {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

/** Feishu JSON payloads this plugin reads. */
interface FeishuResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  bot?: { app_name?: string }
}

/**
 * Append one diagnostic line; logging must never break the caller.
 * @param level - `info` or `warn`.
 * @param line - message text.
 */
function logLine(level: 'info' | 'warn', line: string): void {
  try {
    if (!logDirReady) {
      logDirReady = true
      mkdirSync(dirname(LOG_PATH), { recursive: true, mode: 0o700 })
      // `mode` only applies on creation, so tighten a log left by an older build.
      if (existsSync(LOG_PATH)) chmodSync(LOG_PATH, 0o600)
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${line}\n`, { mode: 0o600 })
  } catch {
    // An unwritable log path is not actionable from inside a plugin.
  }
}

/**
 * Unwrap schemastery reactive fields into plain values.
 * @param value - a config field, possibly a reactive accessor.
 * @returns the plain value.
 */
function plainValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const accessor = value as { get?: () => unknown }
  if (typeof accessor.get === 'function') return plainValue(accessor.get())
  if (Array.isArray(value)) return value.map(plainValue)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]))
}

/**
 * Project a Cordis plugin config row into a plain object.
 * @param config - row config, with reactive fields for volatile entries.
 * @returns plain values keyed by field name.
 */
function plainConfig(config: RawConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, plainValue(value)]))
}

/**
 * Read one JSON object from disk, or undefined when absent or unparsable.
 * @param path - absolute path.
 * @returns the object, or undefined.
 */
function readOptionalJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    logLine('warn', `shared config ${path} is not a JSON object; ignoring it`)
    return undefined
  } catch (error) {
    // A missing file is normal; a corrupt one must be visible.
    logLine('warn', `shared config ${path} is unreadable: ${String(error)}`)
    return undefined
  }
}

/**
 * Read a string field, or a fallback when absent.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is not a string.
 * @returns the string.
 */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a security-relevant string array, refusing a malformed value instead of
 * silently treating it as empty (an empty allowlist must never be inferred from
 * a typo).
 * @param value - candidate value.
 * @param field - config field name used in the error.
 * @returns the string entries, or an empty array when the field is absent.
 */
function requiredStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ConfigError(`${field} must be an array of strings`)
  }
  return value
}

/**
 * Mask one configured secret for display: only the last four characters of a
 * long value leave the Host, and a short value is not partially revealed.
 * @param secret - the resolved secret.
 * @returns a display hint, or null when nothing is configured.
 */
function secretHint(secret: string): string | null {
  if (secret === '') return null
  return secret.length > 8 ? `****${secret.slice(-4)}` : '****'
}

/**
 * Return the first non-empty string.
 * @param values - candidates in precedence order.
 * @returns the first non-empty candidate, or an empty string.
 */
function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value !== '') ?? ''
}

/**
 * Read a nested plain object field.
 * @param value - candidate value.
 * @returns the record, or an empty object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Concatenate the text parts of one assembled assistant message.
 * @param message - the `assistant/message` event message.
 * @returns the visible text, without reasoning or tool-call parts.
 */
function assistantText(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  const parts = message?.content ?? []
  return parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
}

/**
 * Describe a `turn/end` reason for a chat reader.
 * @param kind - the reason kind recorded on the event.
 * @returns one short user-facing sentence.
 */
function describeTurnEnd(kind: string): string {
  switch (kind) {
    case 'aborted': return '回合被中止'
    case 'blocked': return '回合被拦截'
    case 'error': return '回合出错'
    case 'max-tokens': return '回合达到输出上限'
    case 'interrupted': return '回合被中断'
    case 'forked': return '回合在分叉处结束'
    default: return `回合以 ${kind} 结束`
  }
}

/**
 * Read one request body up to a byte ceiling.
 * @param req - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the decoded text, or undefined when the ceiling was exceeded.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the bot in either mode.
 * @param ctx - Host context with `sessionController` and `webServer` injected.
 * @param config - plugin config row, overlaid by the shared config file.
 */
function mount(ctx: HostContext, config: RawConfig): void {
  const shared = readOptionalJson(CONFIG_PATH) ?? {}
  // The row (what the Settings page edits) is the primary source. Legacy
  // fields carry no schema default precisely so an absent row field can fall
  // through to the shared file instead of erasing it with a default.
  const row = plainConfig(config)
  const rowFeishu = asRecord(row.feishu)
  const sharedFeishu = asRecord(shared.feishu)

  if ((row.enabled ?? shared.enabled) === false) {
    logLine('info', 'disabled by config')
    return
  }

  // An absent field keeps the built-in default; only an explicit list (for
  // example the Settings switch clearing the last channel) can disable it.
  const channelValue = row.channels ?? shared.channels
  const channels = channelValue === undefined ? ['feishu'] : requiredStringArray(channelValue, 'channels')
  if (!channels.includes('feishu')) {
    logLine('info', 'feishu channel is disabled by config')
    return
  }

  const appId = firstNonEmpty(
    asString(rowFeishu.appId), asString(row.appId), asString(sharedFeishu.appId), asString(shared.appId),
  )
  const appSecret = firstNonEmpty(
    asString(rowFeishu.appSecret), asString(row.appSecret), asString(sharedFeishu.appSecret), asString(shared.appSecret),
  )
  if (appId === '') throw new ConfigError('appId is required')
  if (appSecret === '') throw new ConfigError('appSecret is required')

  const sessionId = firstNonEmpty(
    asString(row.controllerSessionId), asString(row.sessionId), asString(shared.sessionId),
  )
  if (sessionId === '') throw new ConfigError('sessionId is required')

  const allowedChats = new Set([
    ...requiredStringArray(shared.allowedChats, 'allowedChats'),
    ...requiredStringArray(row.allowedChats, 'allowedChats'),
  ])
  const allowedUsers = row.allowedUsers ?? shared.allowedUsers
  if (allowedUsers !== undefined && !Array.isArray(allowedUsers)) {
    throw new ConfigError('allowedUsers must be an array of { name, openId } rows')
  }
  const allowedOpenIds = new Set([
    ...requiredStringArray(shared.allowedOpenIds, 'allowedOpenIds'),
    ...requiredStringArray(row.allowedOpenIds, 'allowedOpenIds'),
    ...(allowedUsers ?? [])
      .map((entry) => (entry !== null && typeof entry === 'object' ? asString((entry as Record<string, unknown>).openId) : ''))
      .filter((id) => id !== ''),
  ])
  // An empty allowlist would let any chat member drive the agent. The mount
  // continues far enough to serve the settings probe, then returns before the
  // dispatch route or the Feishu connection start.
  const unconfigured = allowedChats.size === 0 && allowedOpenIds.size === 0
  const ack = (row.ack ?? shared.ack) !== false
  const replyOnTurnEnd = (row.reply ?? shared.reply) !== false
  const mode = gatewayEnabled() && shared.mode === 'gateway' ? 'gateway' : 'direct'
  if (!gatewayEnabled() && shared.mode === 'gateway') {
    logLine('warn', 'gateway mode is parked in this build; running direct')
  }

  const feishu = new Lark.Client({ appId, appSecret })
  const seen = new Set<string>()

  /** Request ids this plugin admitted, mapped to the chat that asked. */
  const requests = new Map<string, { chatId: string; messageId?: string; label?: string; dispatched: boolean }>()
  /** Chats where a dispatch already produced the visible receipt. */
  const dispatchAt = new Map<string, number>()
  /** Reply state per Session: only turns this plugin admitted are answered. */
  interface TurnState { chatId: string; requestId: string; text: string; messageId?: string; label?: string; dispatched: boolean }
  const turns = new Map<string, TurnState>()
  /** Long-connection handle in direct mode; undefined when a gateway owns it. */
  let wsClient: Lark.WSClient | undefined

  /**
   * Probe the configured Feishu app without side effects.
   * @returns ordered check results plus the bot name when reachable.
   */
  async function probeFeishu(): Promise<{ steps: ProbeStep[]; botName?: string }> {
    const steps: ProbeStep[] = []
    let token: string | undefined
    let botName: string | undefined

    try {
      const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = await response.json() as FeishuResponse
      if (body.code === 0) {
        token = body.tenant_access_token
        steps.push({ id: 'token', label: '应用凭据', ok: true, detail: '已换取 tenant_access_token' })
      } else {
        steps.push({ id: 'token', label: '应用凭据', ok: false, detail: `${String(body.code)}: ${String(body.msg)}` })
      }
    } catch (error) {
      steps.push({ id: 'token', label: '应用凭据', ok: false, detail: String(error) })
    }

    if (token === undefined) return { steps, botName }

    try {
      const response = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = await response.json() as FeishuResponse
      if (body.code === 0) {
        // Reachability is the signal: a missing bot capability fails this call.
        // `activate_status` is not interpreted — its numbering is undocumented.
        botName = body.bot?.app_name ?? 'unnamed'
        steps.push({ id: 'bot', label: '机器人能力', ok: true, detail: `机器人「${botName}」` })
      } else {
        steps.push({ id: 'bot', label: '机器人能力', ok: false, detail: `${String(body.code)}: ${String(body.msg)}` })
      }
    } catch (error) {
      steps.push({ id: 'bot', label: '机器人能力', ok: false, detail: String(error) })
    }

    try {
      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?page_size=1', {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = await response.json() as FeishuResponse
      if (body.code === 0) {
        steps.push({ id: 'chats', label: '会话读取', ok: true, detail: '可读取机器人所在会话' })
      } else {
        steps.push({ id: 'chats', label: '会话读取', ok: false, detail: `${String(body.code)}: ${String(body.msg)}（可选权限 im:chat:readonly）` })
      }
    } catch (error) {
      steps.push({ id: 'chats', label: '会话读取', ok: false, detail: String(error) })
    }

    return { steps, botName }
  }

  /**
   * Fit text into one Feishu body.
   * @param text - message body.
   * @returns the body, shortened with an explicit marker when it was too long.
   */
  function truncate(text: string): string {
    const suffix = '\n…（已截断）'
    const budget = MAX_REPLY_CHARS - suffix.length
    return text.length > MAX_REPLY_CHARS ? `${text.slice(0, budget)}${suffix}` : text
  }

  /**
   * Send text to one chat, truncating what Feishu would reject.
   * @param chatId - target chat.
   * @param text - message body.
   */
  async function sendToChat(chatId: string, text: string): Promise<void> {
    const body = truncate(text)
    await feishu.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: body }) },
    })
    logLine('info', `sent ${String(body.length)} chars to ${chatId}`)
  }

    /** Mark an accepted message with a Feishu emoji reaction instead of a reply. */
  async function react(messageId: string, emoji = IDLE_EMOJI): Promise<void> {
    try {
      await feishu.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } })
      return
    } catch (error) {
      // An unsupported emoji differs per tenant; fall back so feedback never vanishes.
      logLine('warn', `reaction ${emoji} failed: ${String(error)}`)
    }
    if (emoji !== IDLE_EMOJI) {
      try {
        await feishu.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: IDLE_EMOJI } } })
      } catch (error) {
        logLine('warn', `reaction fallback failed: ${String(error)}`)
      }
    }
  }

  /**
   * Reply inside the triggering message's thread, or send standalone.
   * @param messageId - Feishu message id; empty means "send to the chat".
   * @param chatId - target chat.
   * @param text - short status text.
   */
  async function replyTo(messageId: string | undefined, chatId: string, text: string): Promise<void> {
    try {
      if (messageId !== undefined && messageId !== '') {
        await feishu.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text: truncate(text) }) },
        })
      } else {
        await sendToChat(chatId, text)
      }
    } catch (error) {
      logLine('warn', `reply failed: ${String(error)}`)
    }
  }

  /**
   * Send one interactive card and return the message it became.
   * @param chatId - target chat.
   * @param card - card JSON.
   * @returns the new message id, or undefined when Feishu returned none.
   */
  async function sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    const response = await feishu.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    const messageId = (response as { data?: { message_id?: string } }).data?.message_id
    logLine('info', `sent card ${String(messageId ?? '?')} to ${chatId}`)
    return messageId
  }

  /**
   * Replace the content of one card this app sent.
   * @param messageId - Feishu message id of the card.
   * @param card - new card JSON.
   */
  async function patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await feishu.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
  }

  /** Text fallback for an approval ask when its card cannot be posted. */
  function approvalText(notice: ApprovalNotice): string {
    return [
      `【审批 ${notice.id}】${notice.name} 要执行 ${notice.toolName}，需要你确认`,
      ...(notice.detail !== undefined ? [notice.detail] : notice.reason === undefined ? [] : [`原因：${notice.reason}`]),
      `回复 /approve ${notice.id} 批准，/deny ${notice.id} 拒绝（${String(APPROVAL_TIMEOUT_MS / 1000)} 秒内有效）`,
    ].join('\n')
  }

  /** Text fallback for a question ask when its card cannot be posted. */
  function questionText(notice: QuestionNotice): string {
    const lines = [`【问题 ${notice.id}】${notice.name} 需要你回答：`]
    notice.questions.forEach((question, index) => {
      lines.push(`${String(index + 1)}. ${question.question}`)
      if (question.detail !== undefined && question.detail !== '') lines.push(question.detail)
      const options = question.options ?? []
      if (options.length > 0) lines.push(`选项：${options.map((option) => option.label).join(' / ')}`)
    })
    lines.push(`回复 /answer ${notice.id} <文本> 回答`)
    return lines.join('\n')
  }

  /** Approvals this chat can still answer; the registry owns their deadlines. */
  const approvals = new ApprovalRegistry({
    timeoutMs: APPROVAL_TIMEOUT_MS,
    notify: (notice) => {
      void sendCard(notice.chatId, approvalCard(notice, APPROVAL_TIMEOUT_MS / 1_000))
        .then((messageId) => {
          if (messageId !== undefined) approvals.attachCard(notice.id, messageId)
        })
        .catch((error: unknown) => {
          // An unreachable chat must not settle the ask: the desktop can still answer.
          logLine('warn', `approval card failed: ${String(error)}; falling back to text`)
          void sendToChat(notice.chatId, approvalText(notice)).catch((fallback: unknown) => {
            logLine('warn', `approval notify failed: ${String(fallback)}`)
          })
        })
      logLine('info', `approval ${notice.id} asked in ${notice.chatId} (${notice.toolName})`)
    },
    resolved: (notice, messageId, resolution) => {
      if (messageId === undefined) return
      void patchCard(messageId, approvalResolvedCard(notice, resolution)).catch((error: unknown) => {
        logLine('warn', `approval card patch failed: ${String(error)}`)
      })
    },
    expire: (notice) => {
      logLine('info', `approval ${notice.id} expired`)
      void replyTo(undefined, notice.chatId, `审批 ${notice.id} 超时，已自动拒绝：${notice.toolName}`)
    },
  })

  /** Questions this chat can still answer; the registry owns their deadlines. */
  const questions = new QuestionRegistry({
    timeoutMs: QUESTION_TIMEOUT_MS,
    notify: (notice) => {
      void sendCard(notice.chatId, questionCard(notice))
        .then((messageId) => {
          if (messageId !== undefined) questions.attachCard(notice.id, messageId)
        })
        .catch((error: unknown) => {
          logLine('warn', `question card failed: ${String(error)}; falling back to text`)
          void sendToChat(notice.chatId, questionText(notice)).catch((fallback: unknown) => {
            logLine('warn', `question notify failed: ${String(fallback)}`)
          })
        })
      logLine('info', `question ${notice.id} asked in ${notice.chatId} (${String(notice.questions.length)} question(s))`)
    },
    updated: (notice, messageId) => {
      if (messageId === undefined) return
      void patchCard(messageId, questionCard(notice)).catch((error: unknown) => {
        logLine('warn', `question card progress patch failed: ${String(error)}`)
      })
    },
    resolved: (notice, resolution, messageId) => {
      if (messageId === undefined) return
      void patchCard(messageId, questionClosedCard(notice, resolution)).catch((error: unknown) => {
        logLine('warn', `question card patch failed: ${String(error)}`)
      })
    },
  })

  /**
   * Apply one `/approve` or `/deny` reply to a pending approval.
   * @param message - the command message.
   * @param command - parsed verb and approval id.
   */
  async function answerApproval(message: InboundMessage, command: ApprovalCommand): Promise<void> {
    const { messageId, chatId } = message
    const answer = approvals.answer(chatId, command)
    switch (answer.status) {
      case 'settled':
        await replyTo(messageId, chatId, `${answer.outcome === 'allowed-once' ? '已批准' : '已拒绝'} ${answer.id}：${answer.toolName}`)
        logLine('info', `approval ${answer.id} → ${answer.outcome} from ${message.openId ?? 'unknown'} (${chatId})`)
        break
      case 'foreign':
        await replyTo(messageId, chatId, `审批 ${command.id} 不属于本会话`)
        break
      case 'unknown':
        await replyTo(messageId, chatId, `没有待审批的请求 ${command.id}（可能已超时或被桌面处理）`)
        break
    }
  }

  /**
   * Apply one `/answer` reply to a pending question.
   * @param message - the command message.
   * @param command - parsed request id and answer text.
   */
  async function answerQuestion(message: InboundMessage, command: QuestionCommand): Promise<void> {
    const { messageId, chatId } = message
    const result = questions.answerText(command.id, chatId, command.text)
    switch (result.status) {
      case 'settled':
        await replyTo(messageId, chatId, `已收到回答（${command.id}）`)
        logLine('info', `question ${command.id} answered from ${message.openId ?? 'unknown'} (${chatId})`)
        break
      case 'partial':
        await replyTo(messageId, chatId, `已记录，还有 ${String(result.remaining)} 个问题待回答`)
        break
      case 'foreign':
        await replyTo(messageId, chatId, `问题 ${command.id} 不属于本会话`)
        break
      case 'unknown':
        await replyTo(messageId, chatId, `没有待回答的问题 ${command.id}（可能已超时或被桌面处理）`)
        break
      case 'unsupported':
        await replyTo(messageId, chatId, result.reason)
        break
    }
  }

  /**
   * Apply one interactive-card click: an approval decision or a question option.
   * @param data - raw `card.action.trigger` payload from Feishu.
   * @returns the callback response (toast plus an updated card), when handled.
   */
  async function handleCardAction(data: unknown): Promise<Record<string, unknown> | undefined> {
    const payload = data as {
      context?: { open_chat_id?: string; open_message_id?: string }
      open_chat_id?: string
      operator?: { open_id?: string }
      action?: { value?: unknown }
    }
    const action = parseCardAction(payload.action?.value)
    if (action === undefined) return undefined
    const chatId = payload.context?.open_chat_id ?? payload.open_chat_id ?? ''
    const openId = payload.operator?.open_id ?? ''
    if (allowedOpenIds.size > 0 && !allowedOpenIds.has(openId)) {
      logLine('info', `ignored card click from ${openId} (not in allowedOpenIds)`)
      return { toast: { type: 'error', content: '你不在允许列表里' } }
    }
    if (allowedChats.size > 0 && !allowedChats.has(chatId)) {
      logLine('info', `ignored card click in ${chatId} (not in allowedChats)`)
      return { toast: { type: 'error', content: '这个对话没有授权' } }
    }
    if (action.kind === 'approval') {
      const notice = approvals.noticeOf(action.id)
      const allow = action.value === 'allow'
      const answer = approvals.resolveCard(action.id, chatId, allow)
      if (answer.status === 'settled') {
        logLine('info', `approval ${action.id} → ${allow ? 'allowed-once' : 'rejected'} from card (${openId || 'unknown'}, ${chatId})`)
        return {
          toast: { type: 'success', content: allow ? '已批准' : '已拒绝' },
          ...(notice === undefined ? {} : { card: { type: 'raw', data: approvalResolvedCard(notice, allow ? 'allowed-once' : 'rejected') } }),
        }
      }
      return {
        toast: {
          type: 'warning',
          content: answer.status === 'foreign' ? '这个审批不属于本对话' : '这个审批已经结束或超时了',
        },
      }
    }
    if (chatId === '') return { toast: { type: 'warning', content: '无法识别这个对话' } }
    const before = questions.noticeOf(action.id)
    const result = questions.answerCard(action.id, chatId, action.questionId ?? '', action.value ?? '')
    switch (result.status) {
      case 'settled':
        logLine('info', `question ${action.id} answered from card (${openId || 'unknown'}, ${chatId})`)
        return {
          toast: { type: 'success', content: '已收到回答' },
          ...(before === undefined ? {} : { card: { type: 'raw', data: questionClosedCard(before, 'answered') } }),
        }
      case 'partial':
        return {
          toast: { type: 'info', content: `已记录，还有 ${String(result.remaining)} 个问题` },
          ...(before === undefined ? {} : { card: { type: 'raw', data: questionCard(before) } }),
        }
      case 'unsupported':
        return { toast: { type: 'warning', content: result.reason } }
      case 'foreign':
        return { toast: { type: 'warning', content: '这个问题不属于本对话' } }
      case 'unknown':
        return { toast: { type: 'warning', content: '这个问题已经结束或超时了' } }
    }
  }

  /**
   * Admit one message as a Session prompt and acknowledge it.
   * @param message - inbound message in either transport.
   */
  async function admit(message: InboundMessage): Promise<void> {
    const { messageId, chatId, openId, text } = message
    if (allowedChats.size > 0 && !allowedChats.has(chatId)) {
      logLine('info', `ignored chat ${chatId} (not in allowedChats)`)
      return
    }
    if (allowedOpenIds.size > 0 && (openId === undefined || !allowedOpenIds.has(openId))) {
      logLine('info', `ignored sender ${String(openId)} (not in allowedOpenIds)`)
      return
    }
    if (text.trim() === '') {
      await replyTo(messageId, chatId, '目前只支持文本消息')
      return
    }
    if (text.trim() === '/whoami') {
      await replyTo(messageId, chatId, openId ?? 'unknown')
      logLine('info', `whoami: ${openId ?? 'unknown'} in ${chatId}`)
      return
    }
    const command = parseApprovalCommand(text)
    if (command !== undefined) {
      await answerApproval(message, command)
      return
    }

    const answerCommand = parseAnswerCommand(text)
    if (answerCommand !== undefined) {
      await answerQuestion(message, answerCommand)
      return
    }

    const requestId = `feishu-${messageId}`
    // The prompt is what the model sees; label its origin so the Session log is honest.
    const body = `[飞书] ${openId ?? 'unknown'} 在 ${chatId} 说：\n${text.trim()}\n\n（回复方式：飞书 chat_id=${chatId}，message_id=${messageId}）`

    requests.set(requestId, { chatId, messageId, dispatched: false })
    try {
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: body }] satisfies PromptTextPart[],
        clientTimeZone: 'Asia/Shanghai',
      }, new AbortController().signal)
    } catch (error) {
      requests.delete(requestId)
      logLine('warn', `prompt rejected: ${String(error)}`)
      await replyTo(messageId, chatId, `投递失败：${String(error).slice(0, 120)}`)
      return
    }
    logLine('info', `admitted ${messageId} → ${sessionId} (${mode})`)
    if (ack) await react(messageId, turns.has(sessionId) ? BUSY_EMOJI : IDLE_EMOJI)
  }

  // Approvals: a turn bound to a chat can be decided from Feishu. `prepend`
  // matters — the browser answerer must not consume the ask before the chat has
  // a chance to see it. Both paths race; whichever answers first settles it.
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    const state = turns.get(request.agent.session.id)
    if (state === undefined) return next()
    return approvals.forward(state.chatId, state.label ?? '本会话', request, next)
  }, { prepend: true }), 'im-remote-control: approval forwarding')

  // A reload must not leave a chat-facing ask pending: cancel whatever is open.
  ctx.effect(() => () => { approvals.dispose() }, 'im-remote-control: pending approvals')

  // Questions: the same race as approvals, so a chat answer retracts the
  // desktop prompt and a desktop answer retracts the card.
  ctx.effect(() => ctx.on('user-questions/request', (request, next) => {
    const sessionId = request.agent?.session.id
    const state = sessionId === undefined ? undefined : turns.get(sessionId)
    if (state === undefined) return next()
    return questions.forward(state.chatId, state.label ?? '本会话', request, next)
  }, { prepend: true }), 'im-remote-control: question forwarding')

  // A reload must not leave a question card actionable either.
  ctx.effect(() => () => { questions.dispose() }, 'im-remote-control: pending questions')

  // Turn results: bind each admitted turn to its chat, then answer when it closes.
  ctx.effect(() => ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    switch (event.type) {
      case 'user/message': {
        // Bind here, not on turn/start: `mode: 'queue'` is `agent.followup()`,
        // so the queued item becomes the sole message of its own turn and this
        // event (not turn/start) is where its `rpcId` arrives.
        const requestId = event.data?.source?.rpcId
        const entry = requestId === undefined ? undefined : requests.get(requestId)
        if (requestId !== undefined && entry !== undefined) {
          requests.delete(requestId)
          turns.set(session.id, { chatId: entry.chatId, requestId, text: '', ...(entry.label === undefined ? {} : { label: entry.label }), ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }), dispatched: entry.dispatched })
          logLine('info', `bound '${session.id}' to ${entry.chatId}`)
        }
        break
      }
      case 'turn/start': {
        const state = turns.get(session.id)
        if (state !== undefined) state.text = ''
        break
      }
      case 'assistant/message': {
        const state = turns.get(session.id)
        // One message per step: the last non-empty one is the turn's answer,
        // not the concatenation of every step's narration.
        if (state !== undefined) {
          const text = assistantText(event.data?.message)
          if (text !== '') state.text = text
        }
        break
      }
      case 'turn/end': {
        const state = turns.get(session.id)
        if (state === undefined) break
        turns.delete(session.id)
        const text = state.text.trim()
        const reason = event.data?.reason?.kind
        const receipt = !state.dispatched && (dispatchAt.get(state.chatId) ?? 0) > Date.now() - 120_000
        if (receipt) dispatchAt.delete(state.chatId)
        // An empty successful turn needs no post; a failed or cancelled one
        // must say so, otherwise the chat sees a receipt and then silence.
        const body = text !== ''
          ? (state.label === undefined ? text : `【${state.label}】\n${text}`)
          : (reason === undefined || reason === 'completed'
              ? ''
              : `【${state.label ?? '本会话'}】${describeTurnEnd(reason)}`)
        if (replyOnTurnEnd && !receipt && body !== '') {
          void replyTo(state.messageId, state.chatId, body).catch((error: unknown) => {
            logLine('warn', `send failed: ${String(error)}`)
          })
        }
        break
      }
      default:
        break
    }
  }), 'im-remote-control: turn replies')

  // Every state-changing local route is bearer-authenticated. The token lives
  // beside the shared config (0600) so the dispatch script and the external
  // gateway can read it; it rotates on every mount and is removed on unload.
  const token = randomBytes(24).toString('base64url')
  try {
    mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 })
    writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
    // `mode` only applies on creation; fix a file left by an older build.
    chmodSync(TOKEN_PATH, 0o600)
  } catch (error) {
    logLine('warn', `token write failed: ${String(error)}`)
  }
  ctx.effect(() => () => {
    try {
      // Only remove the file this instance wrote: a newer mount may already
      // have rotated it, and deleting that one would break routing for it.
      if (readFileSync(TOKEN_PATH, 'utf8').trim() === token) rmSync(TOKEN_PATH, { force: true })
    } catch {
      // A missing or unreadable token file is already inert.
    }
  }, 'im-remote-control: token file')

  /**
   * Test whether one request carries this mount's bearer token.
   * @param req - incoming request.
   * @returns whether the authorization header matches.
   */
  function authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${token}`
  }

  // Settings-page probe. Harmless (three read-only Feishu calls), so it needs no
  // token; the custom header only blocks drive-by cross-origin POSTs.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CHECK_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST' || req.headers['x-imrc-check'] !== '1') {
        res.writeHead(405, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'POST with x-imrc-check: 1 required' }))
        return
      }
      try {
        const result = await probeFeishu()
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ steps: result.steps, botName: result.botName }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ steps: [], error: String(error) }))
      }
    },
  }), 'im-remote-control: config probe')

  // The page cannot learn whether a `role('secret')` field is set from the
  // settings document (the Host strips the value), so it asks here. Booleans
  // only; the secret itself never leaves the Host.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        appId: appId !== '',
        appSecret: appSecret !== '',
        appSecretHint: secretHint(appSecret),
        sessionId: sessionId !== '',
        allowlist: allowedChats.size > 0 || allowedOpenIds.size > 0,
      }))
    },
  }), 'im-remote-control: status route')

  if (unconfigured) {
    logLine('warn', 'no access control configured; serving the settings probe only (configure allowedChats or allowedUsers)')
    return
  }

  // Dispatch route: the control session hands a message to any Session and the
  // plugin owns the reply binding, so the executor never needs a chat channel.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/im-remote-control/dispatch',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Bearer token required (see ~/.dsh/im-remote-control.token)' }))
        return
      }
      const raw = await readBody(req, 64 * 1024)
      if (raw === undefined) {
        res.writeHead(413).end()
        return
      }
      let body: { chatId?: unknown, sessionId?: unknown, text?: unknown, label?: unknown, messageId?: unknown } = {}
      try {
        const parsed: unknown = JSON.parse(raw)
        body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as typeof body
          : {}
      } catch {
        body = {}
      }
      const chatId = asString(body.chatId)
      const target = asString(body.sessionId)
      const text = asString(body.text)
      if (chatId === '' || target === '' || text.trim() === '') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'chatId, sessionId and text are required' }))
        return
      }
      // A dispatch may only reply into a configured chat. Unlike the inbound
      // path there is no sender identity here, so the chat list is the only
      // access control available.
      if (!allowedChats.has(chatId)) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'chatId is not in allowedChats' }))
        return
      }
      const requestId = `feishu-dispatch-${randomBytes(8).toString('hex')}`
      requests.set(requestId, { chatId, ...(typeof body.messageId === 'string' && body.messageId !== '' ? { messageId: body.messageId } : {}), dispatched: true, ...(typeof body.label === 'string' && body.label !== '' ? { label: body.label } : {}) })
      dispatchAt.set(chatId, Date.now())
      try {
        await ctx.sessionController.prompt({
          requestId,
          sessionId: target,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: 'Asia/Shanghai',
        }, new AbortController().signal)
      } catch (error) {
        requests.delete(requestId)
        dispatchAt.delete(chatId)
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: false, error: String(error) }))
        return
      }
      logLine('info', `dispatched ${requestId} → ${target} (chat ${chatId})`)
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true, requestId }))
    },
  }), 'im-remote-control: dispatch route')

  if (gatewayEnabled() && mode === 'gateway') {
    // Gateway mode: an external process owns the Feishu connection and answers
    // the inbound route with the shared token.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: INBOUND_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        if (!authorized(req)) {
          res.writeHead(401).end()
          return
        }
        const raw = await readBody(req, 64 * 1024)
        if (raw === undefined) {
          res.writeHead(413).end()
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          res.writeHead(400).end()
          return
        }
        const message = parsed as Partial<InboundMessage> | null
        if (typeof message?.messageId !== 'string' || typeof message.chatId !== 'string') {
          res.writeHead(400).end()
          return
        }
        // Acknowledge before the turn starts; the gateway only reports delivery.
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}')
        try {
          await admit({
            messageId: message.messageId,
            chatId: message.chatId,
            text: typeof message.text === 'string' ? message.text : '',
            ...(typeof message.openId === 'string' ? { openId: message.openId } : {}),
          })
        } catch (error) {
          logLine('warn', `inbound admit failed: ${String(error)}`)
        }
      },
    }), 'im-remote-control: inbound route')

    logLine('info', `gateway mode: inbound ${INBOUND_PATH} → ${sessionId}`)
    return
  }

  // Direct mode: own the Feishu long connection.
  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: unknown) => handleCardAction(data),
    'im.message.receive_v1': async (data: unknown) => {
      const payload = data as {
        message?: {
          message_id: string
          chat_id: string
          chat_type?: string
          content?: string
          mentions?: { key?: string }[]
        }
        sender?: { sender_id?: { open_id?: string } }
      }
      const message = payload.message
      if (message === undefined) return
      // The app holds `im:message.group_msg`, so Feishu delivers every group
      // message; only an @-mention addresses the bot. Direct chats need none.
      if (message.chat_type === 'group' && (message.mentions ?? []).length === 0) {
        return
      }
      if (seen.has(message.message_id)) return
      seen.add(message.message_id)
      const first = seen.values().next()
      if (seen.size > SEEN_LIMIT && first.value !== undefined) seen.delete(first.value)

      let text = ''
      try {
        const content = JSON.parse(message.content ?? '{}') as { text?: string }
        text = content.text ?? ''
      } catch {
        // Non-text payloads carry no `text` field; treated as empty below.
      }
      for (const mention of message.mentions ?? []) {
        if (typeof mention.key === 'string') text = text.replaceAll(mention.key, '')
      }
      const senderOpenId = payload.sender?.sender_id?.open_id ?? 'unknown'
      try {
        await admit({
          messageId: message.message_id,
          chatId: message.chat_id,
          text,
          ...(senderOpenId === 'unknown' ? {} : { openId: senderOpenId }),
        })
      } catch (error) {
        logLine('warn', `admit failed: ${String(error)}`)
      }
    },
  })

  wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info })
  void wsClient.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
    logLine('warn', `long connection failed: ${String(error)}`)
  })
  ctx.effect(() => () => {
    try {
      const client = wsClient as unknown as { close?: (options: { force: boolean }) => void, stop?: (options: { force: boolean }) => void }
      const close = client.close ?? client.stop
      close?.call(client, { force: true })
    } catch {
      // A failed close is not actionable during teardown.
    }
  }, 'im-remote-control: long connection')

  logLine('info', `direct mode: listening for Feishu events → ${sessionId}`)
}

/**
 * Cordis entry point. Configuration failures are logged, never thrown: an
 * optional bridge must not be able to keep the application from booting.
 * @param ctx - Host context.
 * @param config - plugin config row.
 */
export function apply(ctx: HostContext, config: RawConfig = {}): void {
  try {
    mount(ctx, config)
  } catch (error) {
    logLine('warn', `mount failed: ${String(error)}`)
    // A configuration problem leaves the plugin inert; anything else is a
    // defect and must surface as a FAILED fiber instead of a silent no-op.
    if (!(error instanceof ConfigError)) throw error
  }
}
