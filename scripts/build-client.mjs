import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = process.env.DSH_CHECKOUT ?? '/home/carrotfish/deepseek-harness'
const tsdown = join(checkout, 'node_modules', '.bin', 'tsdown')
const output = join(root, '.build')
const temporary = join(output, 'index.cjs')
const result = spawnSync(tsdown, [
  '--config', join(root, 'scripts', 'tsdown.config.mjs'), '--out-dir', output, '--clean',
], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const body = readFileSync(temporary, 'utf8')
writeFileSync(join(root, 'client.js'), [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-plugin-file-and-terminal",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body.split('\n').map(line => line.length > 0 ? `    ${line}` : line).join('\n'),
  '    return module.exports;',
  '  }',
  '});',
].join('\n'))
rmSync(output, { recursive: true, force: true })
