/**
 * Build both halves of this plugin package.
 *
 * The Host half is TypeScript compiled to ESM with every package dependency
 * left external: the profile installs them, and bundling the Feishu SDK would
 * freeze a copy we cannot patch.
 *
 * The browser half is bundled to CommonJS and wrapped in the shell's
 * `window.__ModuleLoader__.load` closure, because the Web shell loads
 * `/plugins/<package>/client.js` as a classic script. React and the shared
 * primitives stay external: the browser seeds them in the platform module
 * table, and a second bundled copy would break hook identity.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Modules the browser shell seeds; never bundle these. */
const PLATFORM_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await mkdir(outdir, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
})

// `gateway` is parked with the plugin's gateway branch. `platform` stays for
// scripts/mode.mjs; `approval` is its own entry so the keyless smoke can import
// the state machine without widening the plugin entry's exports.
const SIDE_ENTRIES = [
  { source: 'src/platform/index.ts', outfile: 'lib/platform.mjs' },
  { source: 'src/approval.ts', outfile: 'lib/approval.js' },
  { source: 'src/cards.ts', outfile: 'lib/cards.js' },
  { source: 'src/questions.ts', outfile: 'lib/questions.js' },
  { source: 'src/replies.ts', outfile: 'lib/replies.js' },
  { source: 'src/inbound.ts', outfile: 'lib/inbound.js' },
  { source: 'src/images.ts', outfile: 'lib/images.js' },
]

for (const entry of SIDE_ENTRIES) {
  await build({
    absWorkingDir: root,
    entryPoints: [entry.source],
    outfile: entry.outfile,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  })
}

const bodyFile = join(outdir, 'client.body.cjs')
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: bodyFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_EXTERNAL,
  logLevel: 'warning',
})

const body = await readFile(bodyFile, 'utf8')
const registration = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    const module = { exports: {} };
    (function (module, exports, require) {
${body}
    })(module, module.exports, require);
    return module.exports;
  },
});
`
await writeFile(join(outdir, 'client.js'), registration)
await rm(bodyFile)
console.log(`built ${pkg.name}: lib/index.js, lib/client.js`)
