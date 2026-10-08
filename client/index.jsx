import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const API = new URL('api/file-and-terminal', document.baseURI)
let explorerCache
let explorerRequest = 0
const explorerListeners = new Set()
let fileManagerState = { downloading: new Set(), downloadError: '' }
const fileManagerListeners = new Set()
let terminalRuntime

function endpoint(action, path) {
  const url = new URL(API)
  url.searchParams.set('action', action)
  if (path) url.searchParams.set(action === 'stream' ? 'id' : 'path', path)
  return url
}

function updateExplorerCache(state) {
  explorerCache = state
  for (const listener of explorerListeners) listener(state)
}

function useExplorer() {
  const [state, setState] = useState(() => explorerCache ?? { phase: 'loading', root: '', path: '', items: [], parent: null, error: '' })
  const load = async path => {
    const request = ++explorerRequest
    updateExplorerCache({ ...(explorerCache ?? state), phase: 'loading', error: '' })
    try {
      const response = await fetch(endpoint('list', path), { credentials: 'same-origin' })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      if (request === explorerRequest) updateExplorerCache({ ...value, phase: 'ready', error: '' })
    } catch (error) {
      if (request === explorerRequest) updateExplorerCache({ ...(explorerCache ?? state), phase: 'failed', error: error?.message ?? String(error) })
    }
  }
  useEffect(() => {
    const sync = value => setState(value)
    explorerListeners.add(sync)
    if (explorerCache) sync(explorerCache)
    else void load('')
    return () => explorerListeners.delete(sync)
  }, [])
  return { state, load, reload: () => load(state.path) }
}

function updateFileManagerState(update) {
  fileManagerState = update(fileManagerState)
  for (const listener of fileManagerListeners) listener(fileManagerState)
}

function useFileManagerState() {
  const [state, setState] = useState(fileManagerState)
  useEffect(() => {
    fileManagerListeners.add(setState)
    setState(fileManagerState)
    return () => fileManagerListeners.delete(setState)
  }, [])
  return state
}

function FileManager() {
  const { state, load, reload } = useExplorer()
  const { downloading, downloadError } = useFileManagerState()
  const fileInput = useRef(null)
  const directoryInput = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const download = async item => {
    updateFileManagerState(current => ({
      ...current,
      downloadError: '',
      downloading: new Set(current.downloading).add(item.path),
    }))
    try {
      const response = await fetch(endpoint('download', item.path), { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        const body = await response.json().catch(() => undefined)
        throw new Error(body?.error || `${response.status} ${response.statusText}`)
      }
      const blobUrl = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = blobUrl
      anchor.download = item.type === 'directory' ? `${item.name}.zip` : item.name
      anchor.hidden = true
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
    } catch (error) {
      updateFileManagerState(current => ({ ...current, downloadError: `${item.name}: ${error?.message ?? String(error)}` }))
    } finally {
      updateFileManagerState(current => {
        const next = new Set(current.downloading)
        next.downloading.delete(item.path)
        return { ...current, downloading: next }
      })
    }
  }
  const upload = async selected => {
    if (!selected?.length) return
    setUploading(true)
    setUploadError('')
    try {
      const form = new FormData()
      for (const file of selected) {
        form.append('files', file)
        form.append('paths', file.webkitRelativePath || file.name)
      }
      const response = await fetch(endpoint('upload', state.path), {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      await reload()
    } catch (error) {
      setUploadError(error?.message ?? String(error))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
      if (directoryInput.current) directoryInput.current.value = ''
    }
  }
  return <section className="fat-explorer" aria-label="文件管理">
    <header className="fat-toolbar">
      <div><h1>文件管理</h1><p title={state.path}>{state.path || '正在读取主机目录…'}</p></div>
      <div className="fat-toolbar-actions">
        <button className="fat-toolbar-button" type="button" disabled={uploading} onClick={() => fileInput.current?.click()}><ExplorerGlyph kind="upload" />{uploading ? '上传中…' : '上传文件'}</button>
        <button className="fat-toolbar-button" type="button" disabled={uploading} onClick={() => directoryInput.current?.click()}><ExplorerGlyph kind="upload-folder" />{uploading ? '上传中…' : '上传目录'}</button>
        <button className="fat-toolbar-button" type="button" onClick={reload} aria-label="刷新目录"><ExplorerGlyph kind="refresh" />刷新</button>
      </div>
      <input ref={fileInput} className="fat-file-input" type="file" multiple onChange={event => void upload(event.target.files)} />
      <input ref={directoryInput} className="fat-file-input" type="file" multiple webkitdirectory="" onChange={event => void upload(event.target.files)} />
    </header>
    {downloadError && <p className="fat-error" role="alert">下载失败：{downloadError}</p>}
    {uploadError && <p className="fat-error" role="alert">上传失败：{uploadError}</p>}
    {uploading && <p role="status">正在上传文件…</p>}
    {state.parent !== null && <button className="fat-entry fat-parent" type="button" onClick={() => load(state.parent)}><ExplorerGlyph kind="up" /><span>上一级</span></button>}
    {state.phase === 'loading' && <p role="status">正在读取目录…</p>}
    {state.phase === 'failed' && <p className="fat-error" role="alert">{state.error}</p>}
    {state.phase === 'ready' && <>
      {state.items.length === 0 && <p className="fat-empty">此文件夹为空</p>}
      <ul className="fat-list">{state.items.map(item => <li key={item.path} className={item.hidden ? 'fat-hidden' : undefined}>
        {item.type === 'directory'
          ? <><button className="fat-entry" type="button" onClick={() => load(item.path)}><ExplorerGlyph kind="folder" /><span>{item.name}</span></button><button className="fat-download" type="button" disabled={downloading.has(item.path)} onClick={() => void download(item)} aria-label={`打包下载 ${item.name}`}>{downloading.has(item.path) ? '打包中…' : '打包下载'}</button></>
          : item.type === 'file'
            ? <><span className="fat-entry"><ExplorerGlyph kind="file" /><span>{item.name}</span><small>{formatSize(item.size)}</small></span><button className="fat-download" type="button" disabled={downloading.has(item.path)} onClick={() => void download(item)} aria-label={`下载 ${item.name}`}>{downloading.has(item.path) ? '下载中…' : '下载'}</button></>
            : <span className="fat-entry fat-muted"><span aria-hidden="true">◇</span><span>{item.name}</span></span>}
      </li>)}</ul>
      {state.truncated && <p className="fat-muted">目录过大，仅显示前 {state.items.length} 项。</p>}
    </>}
    <footer>浏览范围限制在配置的主机目录内。</footer>
  </section>
}

function ExplorerGlyph({ kind, size = 18 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'folder' && <path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V8A1.5 1.5 0 0 1 4 6.5Z M2.8 10.5h18.4" />}
    {kind === 'file' && <path d="M6 2.75h8l4 4V21a.75.75 0 0 1-.75.75h-11.5A.75.75 0 0 1 5 21V3.5a.75.75 0 0 1 .75-.75Z M14 2.75V7h4 M8 12h8 M8 16h8" />}
    {kind === 'upload' && <path d="M12 16V4m0 0 4 4m-4-4-4 4M5 14v5h14v-5" />}
    {kind === 'upload-folder' && <><path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V8A1.5 1.5 0 0 1 4 6.5Z M2.8 10.5h18.4" /><path d="M12 16v-4m0 0 2 2m-2-2-2 2" /></>}
    {kind === 'refresh' && <path d="M20 7v5h-5M20 12a8 8 0 0 0-14.5-4.7L4 9m0 8v-5h5m-5 0a8 8 0 0 0 14.5 4.7L20 15" />}
    {kind === 'up' && <path d="M12 19V5m0 0 6 6m-6-6-6 6" />}
  </svg>
}

function TerminalGlyph({ size = 18 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 6 6 6-6 6M13 18h7" />
  </svg>
}

function formatSize(value) {
  if (!Number.isFinite(value)) return ''
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`
}

async function terminalRequest(payload, keepalive = false) {
  const response = await fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (response.status === 204) return undefined
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}

function publishTerminalState(runtime, state) {
  runtime.state = { ...runtime.state, ...state }
  for (const listener of runtime.listeners) listener(runtime.state)
}

function syncTerminalView(runtime) {
  if (runtime.closed) return
  const views = [...runtime.views].filter(view => view.visible)
  const owner = views.find(view => view.source === 'main') ?? views[0]
  if (!owner) {
    runtime.owner = undefined
    return
  }
  if (runtime.terminal.element?.parentElement !== owner.host) owner.host.appendChild(runtime.terminal.element)
  runtime.owner = owner
  runtime.fit.fit()
  runtime.terminal.refresh(0, runtime.terminal.rows - 1)
  if (runtime.id) void terminalRequest({ action: 'resize', id: runtime.id, cols: runtime.terminal.cols, rows: runtime.terminal.rows }).catch(() => {})
}

function createTerminalRuntime(host) {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 10000,
    theme: { background: '#111318', foreground: '#e6e8ed', cursor: '#e6e8ed', selectionBackground: '#414b5b' },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host)
  fit.fit()
  const runtime = {
    terminal,
    fit,
    id: undefined,
    cwd: '',
    stream: undefined,
    listeners: new Set(),
    views: new Set(),
    owner: undefined,
    state: { status: '正在启动宿主 Bash…', error: '', fontSize: 13 },
    closed: false,
  }
  const close = () => {
    if (runtime.closed) return
    runtime.closed = true
    runtime.stream?.close()
    if (runtime.id) void terminalRequest({ action: 'close', id: runtime.id }, true).catch(() => {})
    terminal.dispose()
    window.removeEventListener('pagehide', close)
    if (terminalRuntime === runtime) terminalRuntime = undefined
  }
  window.addEventListener('pagehide', close, { once: true })
  terminal.onData(data => {
    if (!runtime.id || runtime.closed) return
    void terminalRequest({ action: 'input', id: runtime.id, data }).catch(cause => {
      if (!runtime.closed) publishTerminalState(runtime, { error: cause?.message ?? String(cause) })
    })
  })
  runtime.ready = (async () => {
    try {
      const created = await terminalRequest({ action: 'create', cols: terminal.cols, rows: terminal.rows })
      runtime.id = created.id
      runtime.cwd = created.cwd
      if (runtime.closed) {
        void terminalRequest({ action: 'close', id: runtime.id }, true).catch(() => {})
        return
      }
      publishTerminalState(runtime, { status: `Bash · ${runtime.cwd}` })
      runtime.stream = new EventSource(endpoint('stream', runtime.id), { withCredentials: true })
      runtime.stream.onmessage = event => {
        const message = JSON.parse(event.data)
        if (message.type === 'output') terminal.write(message.data)
        else if (message.type === 'exit') {
          terminal.write(`\r\n\x1b[90m[进程已退出，exit code: ${message.exitCode ?? message.signal ?? 'unknown'}]\x1b[0m\r\n`)
          publishTerminalState(runtime, { status: 'Bash 已退出' })
        } else if (message.type === 'error') publishTerminalState(runtime, { error: message.message })
      }
      runtime.stream.onerror = () => {
        if (!runtime.closed) publishTerminalState(runtime, { error: '与宿主终端的连接已中断。' })
      }
      syncTerminalView(runtime)
    } catch (cause) {
      if (!runtime.closed) publishTerminalState(runtime, { error: cause?.message ?? String(cause) })
    }
  })()
  return runtime
}

function TerminalPanel({ visible = true, source = 'main' }) {
  const host = useRef(null)
  const page = useRef(null)
  const terminalRef = useRef(null)
  const runtimeRef = useRef(null)
  const resizeRef = useRef(() => {})
  const [fontSize, setFontSize] = useState(13)
  const [fullscreen, setFullscreen] = useState(false)
  const [status, setStatus] = useState('正在启动宿主 Bash…')
  const [error, setError] = useState('')
  const adjustFontSize = delta => {
    const next = Math.max(8, Math.min(28, fontSize + delta))
    if (next === fontSize) return
    setFontSize(next)
    if (terminalRef.current) terminalRef.current.options.fontSize = next
    if (runtimeRef.current) publishTerminalState(runtimeRef.current, { fontSize: next })
    resizeRef.current()
  }
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === page.current) await document.exitFullscreen()
      else await page.current?.requestFullscreen()
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    }
  }
  useEffect(() => {
    let observer
    let mounted = true
    const active = source === 'main' || visible !== false
    let runtime = terminalRuntime
    if (!active && !runtime) {
      setStatus('切换到终端标签以启动')
      return () => { mounted = false }
    }
    if (active && (!runtime || runtime.closed)) {
      runtime = createTerminalRuntime(host.current)
      terminalRuntime = runtime
    }
    if (!runtime) return () => { mounted = false }
    terminalRef.current = runtime.terminal
    runtimeRef.current = runtime
    setFontSize(runtime.terminal.options.fontSize)
    setStatus(runtime.state.status)
    setError(runtime.state.error)
    const unsubscribe = state => {
      if (!mounted) return
      setStatus(state.status)
      setError(state.error)
      setFontSize(state.fontSize)
    }
    runtime.listeners.add(unsubscribe)
    const view = { source, host: host.current, visible: active }
    if (active) {
      runtime.views.add(view)
      syncTerminalView(runtime)
    }
    const resize = () => {
      if (!runtime.closed && runtime.owner === view) syncTerminalView(runtime)
    }
    view.onVisible = resize
    resizeRef.current = resize
    const onFullscreenChange = () => { setFullscreen(document.fullscreenElement === page.current) }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    if (active) {
      observer = new ResizeObserver(resize)
      if (host.current) observer.observe(host.current)
      window.addEventListener('resize', resize)
      void runtime.ready.then(() => { if (mounted) resize() })
    }
    return () => {
      mounted = false
      if (active) window.removeEventListener('resize', resize)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      observer?.disconnect()
      runtime.listeners.delete(unsubscribe)
      runtime.views.delete(view)
      if (runtime.owner === view) runtime.owner = undefined
      syncTerminalView(runtime)
      terminalRef.current = null
      runtimeRef.current = null
      resizeRef.current = () => {}
    }
  }, [source, visible])
  return <section className="fat-terminal-page" aria-label="宿主 Bash 终端" ref={page}>
    <header className="fat-terminal-bar"><span className="fat-terminal-mark" aria-hidden="true">$_</span><span className="fat-terminal-status">{status}</span><span className="fat-error" role="status">{error}</span>
      <div className="fat-terminal-controls" aria-label="终端显示设置">
        <button type="button" title="减小字体" aria-label="减小终端字体" disabled={fontSize <= 8} onClick={() => adjustFontSize(-1)}>A−</button>
        <span aria-live="polite">{fontSize}px</span>
        <button type="button" title="增大字体" aria-label="增大终端字体" disabled={fontSize >= 28} onClick={() => adjustFontSize(1)}>A+</button>
        <button type="button" title={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出终端全屏' : '终端全屏'} onClick={toggleFullscreen}>
          {fullscreen ? '退出全屏' : <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>}
        </button>
      </div>
    </header>
    <div className="fat-terminal-screen" ref={host} />
  </section>
}

function SidebarTerminalPanel(props) {
  return <TerminalPanel {...props} source="sidebar" />
}

const styleText = `
.fat-explorer{height:100%;min-height:0;overflow:auto;padding:28px clamp(18px,4vw,48px);color:var(--dsw-alias-label-primary);font:inherit}
.fat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l2)}.fat-toolbar h1{margin:0;font-size:22px;font-weight:650}.fat-toolbar p{max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.fat-toolbar-actions{display:flex;align-items:center;gap:8px;flex:none}.fat-toolbar-button,.fat-parent{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s}.fat-toolbar-button:hover:not(:disabled),.fat-parent:hover{border-color:var(--dsw-alias-brand-primary)}.fat-toolbar-button:disabled{opacity:.55;cursor:wait}.fat-file-input{display:none}
 @media(max-width:600px){.fat-toolbar{align-items:flex-start;flex-wrap:wrap}.fat-toolbar>div:first-child{min-width:0;flex:1}.fat-toolbar-actions{width:100%;flex-wrap:wrap}.fat-toolbar-button{flex:1;padding:0 10px}}
.fat-explorer .fat-toolbar-actions .fat-toolbar-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;flex:none;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:color .15s}.fat-explorer .fat-toolbar-actions .fat-toolbar-button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.fat-explorer button.fat-parent{flex:none;margin:12px 0 8px;border:0;background:transparent;color:inherit}
.fat-parent{margin:16px 0 8px}.fat-list{list-style:none;margin:0;padding:0}.fat-list li{display:flex;align-items:center;min-height:42px;border-bottom:1px solid var(--dsw-alias-border-l1)}.fat-list li.fat-hidden{opacity:.46}.fat-entry{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:8px 6px;color:inherit;text-decoration:none}.fat-list button.fat-entry{border:0;background:none;text-align:left;font:inherit;cursor:pointer}.fat-list button.fat-entry:hover{background:var(--dsw-alias-bg-layer-2)}.fat-entry>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fat-entry small{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}.fat-download{margin:0 8px;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.fat-download:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.fat-download:disabled{opacity:.55;cursor:wait}.fat-empty,.fat-muted,.fat-explorer footer{color:var(--dsw-alias-label-tertiary);font-size:13px}.fat-explorer footer{margin-top:24px}.fat-error{color:#ff7d7d}.fat-terminal-page{height:100%;min-height:0;display:flex;flex-direction:column;background:#111318;color:#e6e8ed;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.fat-terminal-page:fullscreen{width:100vw;height:100vh}.fat-terminal-bar{height:42px;flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid #292d36;color:#aeb4c0}.fat-terminal-mark{font-weight:700;color:#74a7ff}.fat-terminal-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fat-terminal-screen{flex:1;min-height:0;padding:8px}.fat-terminal-screen .xterm{height:100%}.fat-terminal-controls{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}.fat-terminal-controls button{min-width:30px;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 7px;border:1px solid #343a46;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.fat-terminal-controls button:hover:not(:disabled){background:#292d36;color:#fff}.fat-terminal-controls button:disabled{opacity:.4;cursor:default}.fat-terminal-controls>span{min-width:28px;text-align:center;font-size:11px}.fat-terminal-bar .fat-error{font-size:12px}.fat-terminal-page:fullscreen .fat-terminal-controls{margin-left:0}
`

function installStyles() {
  if (document.getElementById('dsh-file-and-terminal-style')) return
  const style = document.createElement('style')
  style.id = 'dsh-file-and-terminal-style'
  style.textContent = styleText
  document.head.appendChild(style)
}

export const inject = ['slots', 'locale', 'layout']

function warnRegistration(moduleName, error) {
  console.warn(`[dsh-plugin-file-and-terminal] ${moduleName} registration skipped:`, error)
}

function registerFallbackPanel(ctx, descriptor) {
  const inject = (slot, factory) => {
    try {
      ctx.slots.inject(slot, () => {
        try { return factory() } catch (error) {
          warnRegistration(descriptor.id, error)
          return () => {}
        }
      })
    } catch (error) {
      warnRegistration(`${descriptor.id} (${slot})`, error)
    }
  }
  inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: descriptor.id, order: descriptor.order, label: descriptor.title,
  }, ({ size }) => descriptor.icon(size)))
  inject('main', () => ctx.slots.register({ name: 'main', key: descriptor.id }, descriptor.component))
}

export function apply(ctx) {
  try { installStyles() } catch (error) { warnRegistration('styles', error) }
  const modules = [
    {
      id: 'dsh-file-and-terminal:files',
      title: '文件管理',
      description: '浏览并下载宿主目录中的文件',
      order: 40,
      single: true,
      icon: size => <ExplorerGlyph kind="folder" size={size} />,
      component: FileManager,
    },
    {
      id: 'dsh-file-and-terminal:terminal',
      title: '终端',
      description: '宿主 Bash 终端',
      order: 50,
      single: true,
      icon: size => <TerminalGlyph size={size} />,
      component: TerminalPanel,
    },
  ]
  for (const descriptor of modules) registerFallbackPanel(ctx, descriptor)

  try {
    ctx.inject(['betterSidebar'], betterCtx => {
      try {
        const betterSidebar = betterCtx.betterSidebar
        if (typeof betterSidebar?.registerTab !== 'function') {
          warnRegistration('better-sidebar service', new Error('registerTab is unavailable'))
          return
        }
        betterCtx.effect(() => {
          const disposers = []
          for (const descriptor of modules) {
            try {
              const tab = descriptor.id === 'dsh-file-and-terminal:terminal'
                ? { ...descriptor, component: SidebarTerminalPanel }
                : descriptor
              const dispose = betterSidebar.registerTab(tab)
              if (typeof dispose !== 'function') throw new Error('registerTab did not return a disposer')
              disposers.push(dispose)
            } catch (error) {
              warnRegistration(descriptor.id, error)
            }
          }
          return () => {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch (error) { warnRegistration('better-sidebar cleanup', error) }
            }
          }
        }, 'dsh-plugin-file-and-terminal: shared better-sidebar tabs')
      } catch (error) {
        warnRegistration('better-sidebar lifecycle', error)
      }
    })
  } catch (error) {
    warnRegistration('better-sidebar injection', error)
  }
}
