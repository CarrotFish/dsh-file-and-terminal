import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const localRequire = createRequire(join(root, 'package.json'))
const checkout = process.env.DSH_CHECKOUT ?? '/home/carrotfish/deepseek-harness'
const checkoutRequire = createRequire(join(checkout, 'packages/client/ui-sidebar-terminal/package.json'))
const resolvePackage = name => {
  try { return localRequire.resolve(name) } catch { return checkoutRequire.resolve(name) }
}
const xtermEntry = resolvePackage('@xterm/xterm')
const fitEntry = resolvePackage('@xterm/addon-fit')
const xtermDirectory = dirname(dirname(xtermEntry))
const fitDirectory = dirname(dirname(fitEntry))
const cssId = '\0dsh-xterm-css'

export default {
  entry: { index: join(root, 'client/index.jsx') },
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outDir: '.build',
  clean: true,
  deps: { neverBundle: specifier => specifier === 'react' || specifier === 'react/jsx-runtime' },
  plugins: [{
    name: 'dsh-xterm-client-dependencies',
    resolveId(source) {
      if (source === '@xterm/xterm') return xtermEntry.replace(/\.js$/u, '.mjs')
      if (source === '@xterm/addon-fit') return fitEntry.replace(/\.js$/u, '.mjs')
      if (source === '@xterm/xterm/css/xterm.css') return cssId
      return null
    },
    load(id) {
      if (id !== cssId) return null
      const css = readFileSync(join(xtermDirectory, 'css/xterm.css'), 'utf8')
      return `const css=${JSON.stringify(css)};if(typeof document!=="undefined"&&!document.querySelector("style[data-dsh-xterm]") ){const s=document.createElement("style");s.dataset.dshXterm="";s.textContent=css;document.head.appendChild(s)};export {};`
    },
  }],
}
