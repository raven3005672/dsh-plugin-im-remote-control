// External gateway for im-remote-control.
//
// Owns the Feishu long connection so a message can wake a closed DSH, and
// forwards each accepted message to the plugin's authenticated local route.
// It never talks to DSH's private /api: after `direct` → `gateway` the plugin
// exposes /im-remote-control/inbound and this process only needs the port.
//
//   node lib/gateway.mjs
//
// PARKED: `gatewayEnabled()` is false and `lib/gateway.mjs` is not built, so
// this file ships as source only. It still lacks the group @-mention filter and
// a durable queue; read docs/HANDOFF.md before enabling it.
//
// Mode comes from $DSH_HOME/im-remote-control.json; while the mode is `direct`
// this process stays alive but idle, so flipping the mode needs no restart.

import * as Lark from '@larksuiteoapi/node-sdk'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverHost, launchApp } from '../platform/index.ts'

/** One message forwarded to the plugin's inbound route. */
interface InboundPayload {
  readonly messageId: string
  readonly chatId: string
  readonly openId?: string
  readonly text: string
}

/** Harness home, matching the plugin and the mode script. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'im-remote-control.json')
const TOKEN_PATH = join(DSH_HOME, 'im-remote-control.token')
const LOG_PATH = join(DSH_HOME, 'im-remote-control.log')
const INBOUND_PATH = '/im-remote-control/inbound'
const IDLE_POLL_MS = 15_000
const START_TIMEOUT_MS = 60_000

function log(level: 'info' | 'warn', line: string): void {
  const entry = `${new Date().toISOString()} ${String(level)} [gateway] ${line}\n`
  try { appendFileSync(LOG_PATH, entry) } catch { /* log path unwritable */ }
  process.stdout.write(entry)
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** @returns the shared config object, or undefined when absent. */
function readConfig(): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

/** @returns the plugin's current bearer token, or undefined. */
function readToken(): string | undefined {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Return a reachable host, launching the desktop app when allowed.
 * @param autoStart - whether the config permits launching the app.
 * @returns the base URL, or undefined when unavailable.
 */
async function ensureHost(autoStart: boolean): Promise<string | undefined> {
  const known = discoverHost()
  if (known !== undefined) return known
  if (!autoStart) {
    log('warn', 'host is not running and autoStart is off')
    return undefined
  }
  log('info', 'host not running; launching com.deepseek.dsh')
  try {
    launchApp({ bundleId: process.env.IMRC_BUNDLE_ID ?? 'com.deepseek.dsh' })
  } catch (error) {
    log('warn', `launch failed: ${String(error).split('\n')[0]}`)
    return undefined
  }
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1_500)
    const base = discoverHost()
    if (base !== undefined) {
      log('info', `host started at ${base}`)
      return base
    }
  }
  log('warn', `host did not start within ${String(START_TIMEOUT_MS / 1000)}s`)
  return undefined
}

/**
 * Deliver one message to the plugin route, retrying until the token route exists.
 * @param payload - inbound message fields.
 * @param autoStart - whether launching DSH is allowed.
 * @param attempts - maximum attempts.
 * @returns whether the plugin accepted it.
 */
async function deliver(payload: InboundPayload, autoStart: boolean, attempts = 6): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const base = await ensureHost(autoStart)
    if (base === undefined) return false
    const token = readToken()
    if (token !== undefined) {
      try {
        const response = await fetch(`${base}${INBOUND_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        })
        if (response.status === 202) return true
        log('warn', `inbound ${response.status} (attempt ${String(attempt)})`)
      } catch (error) {
        log('warn', `inbound failed: ${String(error).split('\n')[0]}`)
      }
    } else {
      log('info', `no token yet (attempt ${String(attempt)})`)
    }
    await sleep(Math.min(1_000 * attempt, 5_000))
  }
  return false
}

/** Run the long connection until the process exits or the mode changes. */
async function runFeishu(raw: Record<string, unknown>): Promise<Lark.WSClient> {
  // The Settings page writes `feishu.*`; the top-level keys are the legacy form.
  const feishuConfig = raw.feishu !== null && typeof raw.feishu === 'object' ? raw.feishu as Record<string, unknown> : {}
  const appId = String(feishuConfig.appId ?? raw.appId ?? '')
  const appSecret = String(feishuConfig.appSecret ?? raw.appSecret ?? '')
  const allowedChats = Array.isArray(raw.allowedChats) ? raw.allowedChats.filter((item): item is string => typeof item === 'string') : []
  const autoStart = raw.autoStart !== false
  const feishu = new Lark.Client({ appId, appSecret })
  const allowed = new Set(allowedChats)
  const seen = new Set()

  async function reply(messageId: string | undefined, chatId: string, text: string): Promise<void> {
    try {
      if (messageId) {
        await feishu.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }) },
        })
      } else {
        await feishu.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        })
      }
    } catch (error) {
      log('warn', `reply failed: ${String(error).split('\n')[0]}`)
    }
  }

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const message = data?.message
      if (message === undefined) return
      const messageId = message.message_id
      if (seen.has(messageId)) return
      seen.add(messageId)
      if (seen.size > 500) seen.delete(seen.values().next().value)

      const chatId = message.chat_id
      if (allowed.size > 0 && !allowed.has(chatId)) {
        log('info', `ignored chat ${chatId} (not in allowedChats)`)
        return
      }

      let text = ''
      try {
        text = String(JSON.parse(message.content ?? '{}').text ?? '')
      } catch {
        // Non-text payloads carry no `text` field.
      }
      for (const mention of message.mentions ?? []) {
        if (typeof mention?.key === 'string') text = text.replaceAll(mention.key, '')
      }
      if (text.trim() === '') {
        await reply(messageId, chatId, '目前只支持文本消息')
        return
      }

      log('info', `recv ${messageId} chat=${chatId}`)
      const ok = await deliver({
        messageId,
        chatId,
        openId: data?.sender?.sender_id?.open_id,
        text,
      }, autoStart)
      if (!ok) {
        log('warn', `undeliverable ${messageId}`)
        await reply(messageId, chatId, '没能连上 DSH（启动超时或插件未就绪），消息没有送达')
      }
    },
  })

  const ws = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info })
  void ws.start({ eventDispatcher: dispatcher }).catch((error) => {
    log('warn', `long connection failed: ${String(error).split('\n')[0]}`)
  })
  log('info', 'gateway listening for Feishu events')

  // Stay connected; the process is stopped by launchctl or a mode change.
  return ws
}

async function main(): Promise<void> {
  log('info', 'gateway process started')
  let active
  let activeMode
  for (;;) {
    const config = readConfig()
    const mode = config?.mode === 'gateway' ? 'gateway' : 'direct'
    if (config === undefined || config.appId === undefined || config.appSecret === undefined) {
      log('warn', 'config missing or incomplete; idling')
      activeMode = undefined
    } else if (mode !== 'gateway') {
      if (activeMode === 'gateway' && active !== undefined) {
        try {
          const close: (options: { force: boolean }) => void = active.close
          close?.call(active, { force: true })
        } catch {
          // A failed close is not actionable here.
        }
        active = undefined
        log('info', 'mode=direct: plugin owns the connection, gateway connection closed')
      } else if (activeMode !== 'direct') {
        log('info', 'mode=direct: plugin owns the connection, gateway idle')
      }
      activeMode = 'direct'
    } else if (activeMode !== 'gateway') {
      active = await runFeishu(config)
      activeMode = 'gateway'
    }
    await sleep(IDLE_POLL_MS)
  }
}

await main()
