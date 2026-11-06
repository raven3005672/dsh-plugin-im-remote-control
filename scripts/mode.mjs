// Switch im-remote-control between `direct` and `gateway` modes.
//
//   node scripts/mode.mjs status
//   node scripts/mode.mjs gateway     # parked in this build; exits without changing anything
//   node scripts/mode.mjs direct      # plugin owns Feishu, works only while DSH runs
//
// The mode lives in $DSH_HOME/im-remote-control.json (default ~/.dsh), which
// both halves read. The plugin decides its mode at mount time, so a mode change
// needs a DSH restart. Service registration is delegated to the platform seam.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serviceStatus, serviceUninstall } from '../lib/platform.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'im-remote-control.json')

const [action] = process.argv.slice(2)
if (!['status', 'direct', 'gateway'].includes(action)) {
  console.error('usage: node scripts/mode.mjs status|direct|gateway')
  process.exit(1)
}
if (!existsSync(CONFIG_PATH)) {
  console.error(`missing ${CONFIG_PATH}`)
  process.exit(1)
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

if (action === 'status') {
  console.log(`mode:      ${config.mode ?? 'direct'}`)
  console.log(`session:   ${config.sessionId}`)
  console.log(`autoStart: ${config.autoStart !== false}`)
  console.log(`gateway:   ${serviceStatus()}   (${process.platform})`)
  process.exit(0)
}

if (action === 'gateway') {
  // Parked with the gateway branch in src/index.ts; keep the CLI honest by
  // refusing before the shared config is touched.
  console.error('gateway mode is parked in this build (no durable queue yet); nothing was changed')
  process.exit(1)
}

writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...config, mode: action }, null, 2)}\n`, { mode: 0o600 })
console.log(serviceUninstall())
console.log('restart DSH so the plugin resumes owning the Feishu connection')
