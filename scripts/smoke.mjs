// Keyless smoke test: the module loads, exposes the Cordis plugin surface,
// stays inert when disabled, reports bad configuration without throwing, and
// refuses to start without access control (an optional bridge must never block
// application boot, and must never fail open either).
//
// The shared config file and the log are redirected so this test never touches
// the real credentials, the real log, and never opens a Feishu connection.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

process.env.IMRC_CONFIG_PATH = '/tmp/imrc-smoke-does-not-exist.json'
process.env.IMRC_TOKEN_PATH = '/tmp/imrc-smoke.token'
const LOG_PATH = '/tmp/imrc-smoke.log'
process.env.IMRC_LOG_PATH = LOG_PATH

const { apply, inject, name } = await import('../lib/index.js')
writeFileSync(LOG_PATH, '')

assert.equal(name, 'im-remote-control')
assert.deepEqual(inject, ['sessionController', 'webServer'])

const ctx = {
  effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposer() },
  on: () => () => {},
  sessionController: { prompt: async () => ({ accepted: true }) },
  webServer: { register: () => () => {} },
}

apply(ctx, { enabled: false })
apply(ctx, { sessionId: 'session-x' })
apply(ctx, { appId: 'cli_x', appSecret: 'y' })
apply(ctx, { appId: 'cli_x', appSecret: 'y', sessionId: 'session-x' })

const log = readFileSync(LOG_PATH, 'utf8')
assert.match(log, /disabled by config/u)
assert.match(log, /appId is required/u)
assert.match(log, /sessionId is required/u)
assert.match(log, /no access control configured/u, 'an empty allowlist serves the probe only')

console.log('smoke ok')
console.log(log.trimEnd().split('\n').slice(-2).join('\n'))
