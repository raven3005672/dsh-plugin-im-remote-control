/**
 * Settings page body for im-remote-control.
 *
 * Three decisions live here: whether a cold start is allowed (experimental),
 * which Session the bot drives, and which IM channels are enabled. A channel
 * reveals its own credential block only while it is checked.
 *
 * `settings.section` hands the page no owner props, so this component owns its
 * subscription to the row's config form.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactElement } from 'react'
import { Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'

/** Values this page edits, as served by the settings document. */
export interface ConfigValue {
  readonly controllerSessionId?: string
  readonly channels?: readonly string[]
  readonly allowedUsers?: readonly { readonly name?: string; readonly openId?: string }[]
  readonly feishu?: {
    readonly appId?: string
    readonly appSecret?: string
  }
  // 微信接入暂缓（2026-11-06）：占位字段先注释掉，恢复时取消注释。
  // readonly wechat?: Record<string, never>
}

/** One settings write. */
export interface ConfigOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** Snapshot of the row's settings document. */
export interface ConfigSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: ConfigValue
  readonly revision?: number
  readonly writable?: boolean
}

/** The config-form face this page reads. */
export interface FormController {
  getSnapshot(): ConfigSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigOp[], revision?: number): Promise<boolean>
}

/** Props supplied by the `settings.section` registration. */
export interface SectionProps {
  /** Row settings form, resolved from the plugin's own namespace. */
  readonly form: FormController
}

/** One channel row: the checkbox and whether it has a settings panel. */
interface ChannelDefinition {
  readonly id: string
  readonly label: string
}

/** One probe result returned by the Host. */
interface ProbeStep {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

/** Probe state: in flight, finished, or absent. */
interface ProbeState {
  readonly checking?: boolean
  readonly steps?: readonly ProbeStep[]
  readonly botName?: string
  readonly error?: string
}

/** Channels this plugin can speak. Order is the display order. */
const CHANNELS: readonly ChannelDefinition[] = [
  // 微信接入暂缓（2026-11-06）：入口先注释掉，恢复时取消注释。
  // { id: 'wechat', label: '微信' },
  { id: 'feishu', label: '飞书' },
]

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '14px 0',
  borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.18))',
}

const labelStyle: CSSProperties = { width: 104, flex: 'none', fontSize: 13, lineHeight: '20px' }
const bodyStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'grid', gap: 8 }
const hintStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', opacity: 0.62 }
const inputStyle: CSSProperties = { width: '100%' }

const panelStyle: CSSProperties = {
  border: '1px dashed var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))',
  borderRadius: 8,
  padding: 12,
  display: 'grid',
  gap: 10,
}

const dangerColor = 'var(--dsw-alias-danger, #d33)'

/**
 * Render the three settings groups and their conditional credential panels.
 * @param props - the row settings form.
 * @returns the settings page body.
 */
export function SettingsSection({ form }: SectionProps): ReactElement {
  const [state, setState] = useState<ConfigSnapshot>(() => form.getSnapshot())
  const [probe, setProbe] = useState<ProbeState | undefined>(undefined)

  useEffect(() => {
    const sync = (): void => { setState(form.getSnapshot()) }
    // Subscribe before the replay: a change landing in between would be lost.
    const unsubscribe = form.subscribe(sync)
    sync()
    return unsubscribe
  }, [form])

  const value: ConfigValue = state.value ?? {}
  const channels = value.channels ?? ['feishu']
  const feishu = value.feishu ?? {}
  const allowedUsers = value.allowedUsers ?? []
  const writable = state.writable !== false

  // Text fields commit on blur: a mutate per keystroke would rewrite the
  // profile patch and re-broadcast on every character.
  const [sessionDraft, setSessionDraft] = useState(value.controllerSessionId ?? '')
  const [appIdDraft, setAppIdDraft] = useState(feishu.appId ?? '')
  // The secret is write-only: the Host never serves it back, so the field
  // starts empty and an empty commit means "keep the saved value".
  const [appSecretDraft, setAppSecretDraft] = useState('')
  // `undefined` until the Host answers: the document never carries the secret.
  const [secretSet, setSecretSet] = useState<boolean | undefined>(undefined)
  const [secretHint, setSecretHint] = useState<string | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  /** Local sender row; the server list carries no identity of its own. */
  interface UserRow { key: string; name: string; openId: string }
  const rowSeq = useRef(0)
  const toRows = (rows: readonly { readonly name?: string; readonly openId?: string }[]): UserRow[] =>
    rows.map((row) => {
      rowSeq.current += 1
      return { key: `user-${String(rowSeq.current)}`, name: row.name ?? '', openId: row.openId ?? '' }
    })

  const [userRows, setUserRows] = useState<UserRow[]>(() => toRows(allowedUsers))
  const usersKey = JSON.stringify(allowedUsers)
  useEffect(() => {
    setSessionDraft(value.controllerSessionId ?? '')
    setAppIdDraft(feishu.appId ?? '')
  }, [value.controllerSessionId, feishu.appId])
  useEffect(() => {
    setUserRows(toRows(allowedUsers))
    // Only a server-side change to the list replaces local rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usersKey])
  const refreshStatus = (): void => {
    void fetch('/im-remote-control/status')
      .then((response) => (response.ok
        ? response.json() as Promise<{ appSecret?: boolean, appSecretHint?: string | null }>
        : undefined))
      .then((body) => {
        if (body === undefined) return
        setSecretSet(body.appSecret === true)
        setSecretHint(body.appSecretHint ?? null)
      })
      .catch(() => {
        // Advisory only: an older Host keeps the generic placeholder.
      })
  }
  useEffect(refreshStatus, [])

  /**
   * Persist the sender list. A half-filled row is kept local: writing it would
   * make the next snapshot drop it before its openId is typed.
   * @param rows - current local rows.
   */
  const commitUsers = (rows: readonly UserRow[]): void => {
    const next = rows.map((row) => ({ name: row.name.trim(), openId: row.openId.trim() })).filter((row) => row.openId !== '')
    if (next.length !== rows.length) return
    write(['allowedUsers'], next)
  }

  /** Ask the Host to probe the saved Feishu credentials. */
  const runProbe = async (): Promise<void> => {
    setProbe({ checking: true })
    try {
      const response = await fetch('/im-remote-control/check', {
        method: 'POST',
        headers: { 'x-imrc-check': '1' },
      })
      const text = await response.text()
      let body: { steps?: ProbeStep[], botName?: string, error?: string } = {}
      try {
        body = text === '' ? {} : JSON.parse(text) as typeof body
      } catch {
        body = {}
      }
      setProbe({
        steps: body.steps ?? [],
        ...(body.botName === undefined ? {} : { botName: body.botName }),
        ...(body.error !== undefined
          ? { error: body.error }
          : response.ok
            ? {}
            : { error: `HTTP ${String(response.status)}（检测接口不可用：插件可能未启动、未配置 allowlist，或 Host 还在跑旧版本）` }),
      })
    } catch (error) {
      setProbe({ steps: [], error: String(error) })
    }
  }

  /**
   * Write one field through the settings service.
   * @param path - field path inside this plugin's namespace.
   * @param next - new value.
   */
  const write = (path: readonly string[], next: unknown): Promise<boolean> => {
    if (!writable) return Promise.resolve(false)
    // No expected revision: this page writes immediately, and a revision
    // captured at render time would make two quick edits conflict with each
    // other and silently drop the second one.
    return form.mutate([{ op: 'set', path, value: next }])
      .then((ok) => {
        setNotice(ok ? undefined : '保存被拒绝：配置可能已被其他窗口修改，请重试。')
        return ok
      })
      .catch((error: unknown) => {
        setNotice(`保存失败：${String(error)}`)
        return false
      })
  }

  /** Remove the saved App Secret so the field can be re-entered. */
  const clearSecret = (): void => {
    if (!writable) return
    if (!window.confirm('清除已保存的 App Secret？重启前插件仍会使用旧值。')) return
    void write(['feishu', 'appSecret'], '').then((ok) => {
      if (ok) refreshStatus()
    })
  }

  /**
   * Enable or disable one channel.
   * @param id - channel id.
   * @param on - requested state.
   */
  const toggleChannel = (id: string, on: boolean): void => {
    const next = on ? [...new Set([...channels, id])] : channels.filter((channel) => channel !== id)
    write(['channels'], next)
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, margin: '0 0 6px' }}>远程控制</h2>
      <p style={{ fontSize: 12, lineHeight: '18px', margin: '0 0 10px', color: 'var(--dsw-alias-warning, #b58105)' }}>
        ⚠ 修改任何配置后都需要重启 DSH 才会生效。
      </p>
      <p style={{ ...hintStyle, margin: '0 0 18px' }}>
        通过 IM 机器人给一个 DSH 会话派活，回合结束后把结论发回聊天。
        配置修改后需要重启 DSH 才会应用到连接。
      </p>

      {notice === undefined
        ? null
        : <p style={{ ...hintStyle, margin: '0 0 12px', color: dangerColor }}>{notice}</p>}

      <div style={rowStyle}>
        <div style={labelStyle}>中控会话</div>
        <div style={bodyStyle}>
          <Input
            style={inputStyle}
            value={sessionDraft}
            placeholder="session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            onChange={(event) => { setSessionDraft(event.target.value) }}
            onBlur={() => {
              if (sessionDraft !== (value.controllerSessionId ?? '')) {
                write(['controllerSessionId'], sessionDraft.trim())
              }
            }}
            disabled={!writable}
          />
          <span style={hintStyle}>
            机器人收到的消息会投递到这条 Session（它不必是当前打开的会话）。
          </span>
        </div>
      </div>

      <div style={rowStyle}>
        <div style={labelStyle}>允许使用的用户</div>
        <div style={bodyStyle}>
          {userRows.map((row, index) => (
            <div key={row.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Input
                style={{ width: 120, flex: 'none' }}
                value={row.name}
                placeholder="备注名"
                onChange={(event) => { const next = [...userRows]; next[index] = { ...row, name: event.target.value }; setUserRows(next) }}
                onBlur={() => { commitUsers(userRows) }}
                disabled={!writable}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                <Input
                  style={{ width: '100%' }}
                  value={row.openId}
                  placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  onChange={(event) => { const next = [...userRows]; next[index] = { ...row, openId: event.target.value }; setUserRows(next) }}
                  onBlur={() => { commitUsers(userRows) }}
                  disabled={!writable}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  // Drop never-saved rows from the write so a delete always
                  // persists instead of being skipped by the completeness guard.
                  const next = userRows.filter((_, i) => i !== index)
                  const complete = next
                    .map((row) => ({ name: row.name.trim(), openId: row.openId.trim() }))
                    .filter((row) => row.openId !== '')
                  setUserRows(next.filter((row) => row.openId.trim() !== ''))
                  void write(['allowedUsers'], complete)
                }}
                disabled={!writable}
                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
              >
                删除
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => { setUserRows([...userRows, ...toRows([{}])]) }}
              disabled={!writable}
              style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
            >
              新增
            </button>
          </div>
          <span style={hintStyle}>
            只接受这些发送者；两项都为空时插件不会启动（所以 /whoami 也不可用）。首次配置请先填一项，重启后可用 <code>/whoami</code> 校准 open_id。
          </span>
        </div>
      </div>

      <div style={{ ...rowStyle, borderBottom: 'none' }}>
        <div style={labelStyle}>接入的 IM</div>
        <div style={bodyStyle}>
          <div style={{ display: 'flex', gap: 20 }}>
            {CHANNELS.map((channel) => (
              <Checkbox
                key={channel.id}
                checked={channels.includes(channel.id)}
                onChange={(next) => { toggleChannel(channel.id, next) }}
                label={channel.label}
                disabled={!writable}
              />
            ))}
          </div>

          {/* 微信接入暂缓（2026-11-06）：占位面板先注释掉，恢复时取消注释。
          {channels.includes('wechat')
            ? (
              <div style={panelStyle}>
                <span style={hintStyle}>微信接入尚未实现，这里先占位。</span>
              </div>
            )
            : null}
          */}

          {channels.includes('feishu')
            ? (
              <div style={panelStyle}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 12 }}>App ID</span>
                  <Input
                    style={inputStyle}
                    value={appIdDraft}
                    placeholder="cli_xxxxxxxxxxxxxxxx"
                    onChange={(event) => { setAppIdDraft(event.target.value) }}
                    onBlur={() => {
                      if (appIdDraft !== (feishu.appId ?? '')) {
                        write(['feishu', 'appId'], appIdDraft.trim())
                      }
                    }}
                    disabled={!writable}
                  />
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    App Secret
                    {secretSet === undefined
                      ? null
                      : (
                        <span style={{ fontSize: 11, opacity: 0.62 }}>
                          {secretSet
                            ? (secretHint === undefined || secretHint === null ? '已配置，不会回显' : `已配置（${secretHint}）`)
                            : '未配置'}
                        </span>
                      )}
                    {secretSet === true
                      ? (
                        <button
                          type="button"
                          onClick={clearSecret}
                          disabled={!writable}
                          style={{
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 6,
                            border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: writable ? 'pointer' : 'default',
                          }}
                        >
                          清除
                        </button>
                      )
                      : null}
                  </span>
                  <SecretField
                    value={appSecretDraft}
                    placeholder={secretSet === true ? '留空表示不修改；粘贴新密钥可替换' : '粘贴应用密钥'}
                    disabled={!writable}
                    onChange={setAppSecretDraft}
                    onCommit={() => {
                      const next = appSecretDraft.trim()
                      if (next === '') return
                      void write(['feishu', 'appSecret'], next).then((ok) => {
                        if (!ok) return
                        setAppSecretDraft('')
                        refreshStatus()
                      })
                    }}
                  />
                </div>
                <span style={hintStyle}>
                  在
                  {' '}
                  <a
                    href="https://open.feishu.cn/app"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--dsw-alias-link, inherit)', textDecoration: 'underline' }}
                  >
                    飞书开放平台
                  </a>
                  {' '}
                  创建自建应用后获取；需要开启机器人能力并订阅接收消息事件。
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => { void runProbe() }}
                    disabled={probe?.checking === true}
                    style={{
                      // Keep the label on one line: the hint beside it wraps instead.
                      flex: 'none',
                      whiteSpace: 'nowrap',
                      fontSize: 12,
                      padding: '5px 16px',
                      borderRadius: 6,
                      border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: probe?.checking === true ? 'default' : 'pointer',
                    }}
                  >
                    {probe?.checking === true ? '检测中…' : '检测配置'}
                  </button>
                  <span style={{ ...hintStyle, flex: 1, minWidth: 0 }}>
                    使用本次启动时加载的凭据，只读探测，不会发消息；改完凭据需重启。
                  </span>
                </div>

                {probe?.steps === undefined ? null : (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {probe.steps.length > 0 && probe.steps.every((step) => step.ok)
                      ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: '#22c55e' }} />
                          <span>{probe.botName ?? '机器人'}</span>
                          <span style={{ opacity: 0.62 }}>配置正常</span>
                        </span>
                      )
                      : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: dangerColor }}>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: 'currentColor' }} />
                          <span>配置有问题</span>
                        </span>
                      )}
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                      {probe.steps.map((step) => (
                        <li
                          key={step.id}
                          style={{ fontSize: 12, lineHeight: '18px', color: step.ok ? 'inherit' : dangerColor }}
                        >
                          {step.ok ? '✓' : '✗'} {step.label}：{step.detail}
                        </li>
                      ))}
                      {probe.steps.length === 0
                        ? (
                          <li style={{ fontSize: 12 }}>
                            没有拿到检测结果{probe.error === undefined ? '' : `：${probe.error}`}
                          </li>
                        )
                        : null}
                    </ul>
                  </div>
                )}
              </div>
            )
            : null}

          {state.status === 'unavailable'
            ? <span style={hintStyle}>当前行没有可编辑的配置项。</span>
            : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Eye glyph; `off` adds the slash used for the revealed state.
 * @param props.off - whether to draw the slash.
 * @returns the icon.
 */
function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off ? <path d="M4 20 20 4" /> : null}
    </svg>
  )
}

/** Props of the secret field. */
interface SecretFieldProps {
  readonly value: string
  readonly placeholder: string
  readonly disabled: boolean
  onChange(next: string): void
  onCommit(): void
}

/**
 * Password-style field with a reveal action.
 *
 * The value is never generated here: a locally invented secret would be
 * rejected by Feishu, so this control only hides, reveals, and stores what the
 * user pastes.
 * @param props - staged text plus its change and commit callbacks.
 * @returns the field with its reveal button.
 */
function SecretField({ value, onChange, onCommit, disabled, placeholder }: SecretFieldProps): JSX.Element {
  const [revealed, setRevealed] = useState(false)

  const actionStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.55,
    cursor: disabled ? 'default' : 'pointer',
    flex: 'none',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* The primitive's wrapper is inline-flex: a grid parent stretches it to
          the row width, which a plain block parent would not. */}
      <div style={{ flex: 1, minWidth: 0, display: 'grid' }}>
        <Input
          style={{ width: '100%' }}
          type={revealed ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          placeholder={placeholder}
          onChange={(event) => { onChange(event.target.value) }}
          onBlur={onCommit}
          disabled={disabled}
        />
      </div>
      <button
        type="button"
        style={{
          ...actionStyle,
          opacity: disabled || value === '' ? 0.22 : 0.55,
          cursor: disabled || value === '' ? 'default' : 'pointer',
        }}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setRevealed(!revealed) }}
        disabled={disabled || value === ''}
        title={value === '' ? '没有可显示的内容' : (revealed ? '隐藏' : '显示')}
        aria-label={revealed ? '隐藏' : '显示'}
      >
        <EyeIcon off={revealed} />
      </button>
    </div>
  )
}
