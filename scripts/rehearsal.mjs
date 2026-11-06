// Mount rehearsal: exercises the real Host half with a valid config shape but
// throwaway paths and bogus Feishu credentials, so it never touches the live
// bot. Verifies config resolution, access-control refusal, token file, route
// auth and the dispatch handler end to end.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

process.env.IMRC_CONFIG_PATH = '/tmp/imrc-rehearsal-config.json'
process.env.IMRC_TOKEN_PATH = '/tmp/imrc-rehearsal.token'
process.env.IMRC_LOG_PATH = '/tmp/imrc-rehearsal.log'
writeFileSync(process.env.IMRC_LOG_PATH, '')
rmSync(process.env.IMRC_TOKEN_PATH, { force: true })

const { apply } = await import('../lib/index.js')

const routes = new Map()
const disposers = []
const prompts = []
const listeners = new Map()

const ctx = {
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  on: (event, listener) => { listeners.set(event, listener); return () => {} },
  sessionController: {
    prompt: async (request) => { prompts.push(request); return { accepted: true } },
  },
  webServer: {
    register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) },
  },
}

apply(ctx, {
  appId: 'cli_bogus',
  appSecret: 'bogus-secret',
  sessionId: 'session-test',
  channels: ['feishu'],
  allowedChats: ['oc_allowed'],
  allowedOpenIds: [],
  allowedUsers: [],
  ack: true,
  reply: true,
})

// --- token file --------------------------------------------------------------
assert.ok(existsSync(process.env.IMRC_TOKEN_PATH), 'token file written at mount')
const token = readFileSync(process.env.IMRC_TOKEN_PATH, 'utf8').trim()
assert.match(token, /^[A-Za-z0-9_-]{24,}$/u)
assert.equal(statSync(process.env.IMRC_TOKEN_PATH).mode & 0o777, 0o600, 'token file is 0600')

// --- routes ------------------------------------------------------------------
assert.ok(routes.has('/im-remote-control/check'), 'probe route registered')

const status = routes.get('/im-remote-control/status')
assert.ok(status, 'status route registered')
{
  const { req, res } = request({ method: 'GET' })
  await status.handler(req, res)
  assert.equal(res.status, 200)
  // The secret itself never leaves the Host; only the masked hint does.
  assert.deepEqual(JSON.parse(res.body), {
    appId: true, appSecret: true, appSecretHint: '****cret', sessionId: true, allowlist: true,
  })
}
const dispatch = routes.get('/im-remote-control/dispatch')
assert.ok(dispatch, 'dispatch route registered')
assert.ok(listeners.has('approval/request'), 'approval waterfall listener registered')
assert.ok(listeners.has('session/event'), 'session event listener registered')

// One fake request/response pair.
function request({ body = '', authorization, method = 'POST' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body)]
  const req = {
    method,
    headers: authorization === undefined ? {} : { authorization },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; return this },
    end(body = '') { this.body = body; return this },
  }
  return { req, res }
}

async function call(options) {
  const { req, res } = request(options)
  await dispatch.handler(req, res)
  return res
}

// No token → 401.
assert.equal((await call({ body: '{}' })).status, 401)
// Wrong token → 401.
assert.equal((await call({ body: '{}', authorization: 'Bearer nope' })).status, 401)
// Valid token but a chat outside the allowlist → 403.
assert.equal((await call({ body: JSON.stringify({ chatId: 'oc_evil', sessionId: 'session-test', text: 'hi' }), authorization: `Bearer ${token}` })).status, 403)
// Valid token + allowed chat → 202 and one prompt.
assert.equal((await call({ body: JSON.stringify({ chatId: 'oc_allowed', sessionId: 'session-target', text: 'do it', label: '测试' }), authorization: `Bearer ${token}` })).status, 202)
assert.equal(prompts.length, 1)
assert.equal(prompts[0].sessionId, 'session-target')
assert.equal(prompts[0].content[0].text, 'do it')
// Oversized body → 413.
assert.equal((await call({ body: 'x'.repeat(70 * 1024), authorization: `Bearer ${token}` })).status, 413)

const log = readFileSync(process.env.IMRC_LOG_PATH, 'utf8')
assert.match(log, /direct mode: listening for Feishu events/u, 'mount reached the connection step')
assert.match(log, /dispatched feishu-dispatch-/u)

// Unmount: the token file must be gone.
for (const dispose of disposers) dispose()
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(existsSync(process.env.IMRC_TOKEN_PATH), false, 'token file removed on unload')

console.log('rehearsal ok')
console.log(log.trimEnd().split('\n').slice(-3).join('\n'))
process.exit(0)
