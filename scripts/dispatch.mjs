// Hand one task to another Session and return immediately.
//
//   node scripts/dispatch.mjs <chat_id> <session_id> "<text>" [label]
//
// The plugin owns the reply binding, so the executor's turn result is sent to
// that chat automatically. Callers must NOT wait for it.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverHost } from '../lib/platform.mjs'

const TOKEN_PATH = process.env.IMRC_TOKEN_PATH
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'im-remote-control.token')

const [chatId, sessionId, text, label, messageId] = process.argv.slice(2)
if (!chatId || !sessionId || !text) {
  console.error('usage: node scripts/dispatch.mjs <chat_id> <session_id> "<text>" [label] [message_id]')
  process.exit(1)
}
if (!existsSync(TOKEN_PATH)) {
  console.error(`missing ${TOKEN_PATH} — restart DSH so the plugin writes its route token`)
  process.exit(1)
}
const token = readFileSync(TOKEN_PATH, 'utf8').trim()
if (token === '') {
  console.error(`empty ${TOKEN_PATH} — restart DSH so the plugin rotates its route token`)
  process.exit(1)
}
const base = discoverHost()
if (base === undefined) {
  console.error('DSH host is not running')
  process.exit(1)
}
const response = await fetch(`${base}/im-remote-control/dispatch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ chatId, sessionId, text, ...(label ? { label } : {}), ...(messageId ? { messageId } : {}) }),
})
console.log(response.status, await response.text())
process.exit(response.status === 202 ? 0 : 1)
