// Keyless client smoke: the Settings bundle must load, register its slot, and
// render its component body without throwing. A null dereference during render
// takes the whole Settings section down, so this runs in `npm run verify`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let entry
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }

const jsx = (type, props) => ({ type, props })
const requireStub = (id) => {
  if (id === 'react') {
    return {
      useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      createElement: jsx,
    }
  }
  if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
  return new Proxy({}, { get: () => () => null })
}

new Function('window', 'require', code)(globalThis.window, requireStub)
const mod = entry.factory(requireStub)
assert.equal(entry.id, 'dsh-plugin-im-remote-control')
assert.deepEqual(mod.inject, ['slots', 'configForms'])

let component
const form = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    revision: 1,
    value: {
      coldStart: false,
      controllerSessionId: 'session-test',
      channels: ['feishu'],
      feishu: { appId: 'cli_test', appSecret: 'secret' },
      // 微信接入暂缓（2026-11-06）：占位字段先注释掉，恢复时取消注释。
      // wechat: {},
    },
  }),
  subscribe: () => () => {},
  mutate: async () => true,
}
mod.apply({
  slots: { inject: (_name, run) => run(), register: (_entry, value) => { component = value; return () => {} } },
  configForms: { get: () => form },
  effect: (fn) => fn(),
})
assert.ok(component, 'settings component registered')
const tree = component({ form })
assert.ok(tree, 'component rendered')

console.log('smoke-client ok')
