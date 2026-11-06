// Platform seam for im-remote-control.
//
// Three jobs differ by OS: finding the running DSH host, launching it, and
// keeping the gateway alive as a login service. Everything else in this plugin
// is plain Node and identical everywhere.
//
//   darwin — ps + lsof, `open -b`, LaunchAgent
//   linux  — ps + lsof, `gtk-launch`/`xdg-open`, systemd --user
//   win32  — PowerShell CIM + Get-NetTCPConnection, Start-Process, schtasks
//
// Unsupported or unverified paths fail with an actionable message instead of a
// silent no-op.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Inputs every platform service definition needs. */
export interface ServiceOptions {
  readonly nodePath: string
  readonly scriptPath: string
  readonly cwd: string
  readonly logPath: string
}

/** Optional launch overrides. */
export interface LaunchOptions {
  readonly bundleId?: string
  readonly appPath?: string
}

/** Stable service identity across platforms. */
export const SERVICE_LABEL = 'ai.deepseek.im-remote-control-gateway'

/** Process argv marker that identifies the desktop host. */
const HOST_MARKER = 'dsh-desktop-host/lib/index.js'

/**
 * Run a command and return stdout, or an empty string on any failure.
 * @param command - executable name.
 * @param args - argv.
 * @returns stdout text.
 */
function run(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * Run a command and report whether it exited zero.
 * @param command - executable name.
 * @param args - argv.
 * @returns true on a zero exit.
 */
function ok(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * Enumerate candidate host process ids.
 * @returns process ids that look like the DSH desktop host.
 */
function hostPids(): number[] {
  if (process.platform === 'win32') {
    const out = run('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${HOST_MARKER}*' } | Select-Object -ExpandProperty ProcessId`])
    return out.split(/\s+/u).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
  }
  return run('ps', ['-eo', 'pid=,args='])
    .split('\n')
    .filter((line) => line.includes(HOST_MARKER))
    .map((line) => Number(line.trim().split(/\s+/u)[0]))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
}

/**
 * Read one listening port owned by a process.
 * @param pid - process id.
 * @returns the port, or undefined.
 */
function listenPort(pid: number): number | undefined {
  if (process.platform === 'win32') {
    const out = run('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -OwningProcess ${String(pid)} -State Listen | Select-Object -First 1).LocalPort`]).trim()
    const port = Number(out)
    return Number.isSafeInteger(port) && port > 0 ? port : undefined
  }
  const out = run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'])
  const match = /127\.0\.0\.1:(\d+) \(LISTEN\)/u.exec(out)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * Locate the running desktop host.
 * @returns `http://127.0.0.1:<port>`, or undefined when it is not running.
 */
export function discoverHost(): string | undefined {
  for (const pid of hostPids()) {
    const port = listenPort(pid)
    if (port !== undefined) return `http://127.0.0.1:${String(port)}`
  }
  return undefined
}

/**
 * Launch the desktop application in the background.
 * @param options - `bundleId` (macOS) and `appPath` (other platforms).
 * @throws when the platform offers no usable launcher.
 */
export function launchApp({ bundleId = 'com.deepseek.dsh', appPath }: LaunchOptions = {}): void {
  if (process.platform === 'darwin') {
    if (!ok('open', ['-g', '-b', bundleId])) throw new Error(`open -g -b ${bundleId} failed`)
    return
  }
  const target = process.env.IMRC_APP_PATH ?? appPath
  if (process.platform === 'linux') {
    if (ok('gtk-launch', ['dsh'])) return
    if (target !== undefined && ok('xdg-open', [target])) return
    throw new Error('cannot launch DSH on Linux: install gtk-launch, or set IMRC_APP_PATH to the app binary/AppImage')
  }
  if (target === undefined) {
    throw new Error('cannot launch DSH on Windows: set IMRC_APP_PATH to the DeepSeek Harness executable')
  }
  if (!ok('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${target}'`])) {
    throw new Error(`Start-Process ${target} failed`)
  }
}

/** @returns absolute path of the service definition this platform uses. */
export function servicePath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  if (process.platform === 'linux') return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`)
  return ''
}

/**
 * Write the platform service definition.
 * @param options - `nodePath`, `scriptPath`, `cwd`, `logPath`.
 * @returns the definition path.
 */
function writeServiceDefinition({ nodePath, scriptPath, cwd, logPath }: ServiceOptions): string {
  const path = servicePath()
  mkdirSync(dirname(path), { recursive: true })
  if (process.platform === 'darwin') {
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${nodePath}</string><string>${scriptPath}</string></array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${logPath}.out.log</string>
  <key>StandardErrorPath</key><string>${logPath}.err.log</string>
</dict>
</plist>
`)
  } else if (process.platform === 'linux') {
    writeFileSync(path, `[Unit]
Description=Feishu gateway for DeepSeek Harness (im-remote-control)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${nodePath} ${scriptPath}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}.out.log
StandardError=append:${logPath}.err.log

[Install]
WantedBy=default.target
`)
  }
  return path
}

/**
 * Install and start the gateway service.
 * @param options - `nodePath`, `scriptPath`, `cwd`, `logPath`.
 * @returns a human-readable result line.
 */
export function serviceInstall(options: ServiceOptions): string {
  if (process.platform === 'win32') {
    const tr = `"${options.nodePath}" "${options.scriptPath}"`
    const created = ok('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', SERVICE_LABEL, '/TR', tr])
    if (!created) return 'schtasks create failed (Windows service support is unverified)'
    ok('schtasks', ['/Run', '/TN', SERVICE_LABEL])
    return 'scheduled task created (runs at logon; no KeepAlive on Windows)'
  }
  const path = writeServiceDefinition(options)
  if (process.platform === 'linux') {
    ok('systemctl', ['--user', 'daemon-reload'])
    return ok('systemctl', ['--user', 'enable', '--now', SERVICE_LABEL])
      ? `systemd unit installed: ${path}`
      : `systemd unit written but enable failed: ${path} (check \`systemctl --user status ${SERVICE_LABEL}\`)`
  }
  const uid = String(process.getuid?.() ?? 0)
  ok('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`])
  return ok('launchctl', ['bootstrap', `gui/${uid}`, path])
    ? `LaunchAgent installed: ${path}`
    : `launchctl bootstrap failed for ${path}`
}

/**
 * Stop and remove the gateway service.
 * @returns a human-readable result line.
 */
export function serviceUninstall(): string {
  if (process.platform === 'win32') {
    ok('schtasks', ['/End', '/TN', SERVICE_LABEL])
    return ok('schtasks', ['/Delete', '/F', '/TN', SERVICE_LABEL])
      ? 'scheduled task removed'
      : 'scheduled task not present'
  }
  if (process.platform === 'linux') {
    ok('systemctl', ['--user', 'disable', '--now', SERVICE_LABEL])
    const path = servicePath()
    if (existsSync(path)) rmSync(path, { force: true })
    ok('systemctl', ['--user', 'daemon-reload'])
    return 'systemd unit disabled and removed'
  }
  const uid = String(process.getuid?.() ?? 0)
  const stopped = ok('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`])
  const path = servicePath()
  if (existsSync(path)) rmSync(path, { force: true })
  return stopped ? 'LaunchAgent unloaded and removed' : 'LaunchAgent was not loaded; removed definition if present'
}

/**
 * Report whether the gateway service is active.
 * @returns `running`, `loaded`, or `absent`.
 */
export function serviceStatus(): 'running' | 'loaded' | 'absent' {
  if (process.platform === 'win32') {
    const out = run('schtasks', ['/Query', '/TN', SERVICE_LABEL])
    return out === '' ? 'absent' : 'loaded'
  }
  if (process.platform === 'linux') {
    const out = run('systemctl', ['--user', 'is-active', SERVICE_LABEL]).trim()
    return out === 'active' ? 'running' : out === '' ? 'absent' : 'loaded'
  }
  const uid = String(process.getuid?.() ?? 0)
  const out = run('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`])
  if (out === '') return 'absent'
  return out.includes('state = running') ? 'running' : 'loaded'
}
