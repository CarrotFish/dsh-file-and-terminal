import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const API = new URL('api/file-and-terminal', document.baseURI)
const TERMINAL_FONT_SIZE_KEY = 'dsh-file-and-terminal:terminal-font-size'
const DEFAULT_TERMINAL_FONT_SIZE = 13
const MIN_TERMINAL_FONT_SIZE = 8
const MAX_TERMINAL_FONT_SIZE = 28
const INDEPENDENT_SIDEBAR_SIZE_KEY = 'dsh-file-and-terminal:sidebar-size'
const INDEPENDENT_SIDEBAR_STATE_KEY = 'dsh-file-and-terminal:sidebar-tabs'
const DEFAULT_INDEPENDENT_SIDEBAR_SIZE = { right: 380, bottom: 320 }
let explorerCache
let explorerRequest = 0
const explorerListeners = new Set()
let fileManagerState = { downloadError: '' }
const fileManagerListeners = new Set()
let terminalRuntime
let independentSidebarState
let independentTerminalRuntime
const independentSidebarListeners = new Set()

function readIndependentSidebarSize() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INDEPENDENT_SIDEBAR_SIZE_KEY) || 'null')
    return {
      right: Number.isFinite(value?.right) ? Math.max(260, value.right) : DEFAULT_INDEPENDENT_SIDEBAR_SIZE.right,
      bottom: Number.isFinite(value?.bottom) ? Math.max(180, value.bottom) : DEFAULT_INDEPENDENT_SIDEBAR_SIZE.bottom,
    }
  } catch {
    return { ...DEFAULT_INDEPENDENT_SIDEBAR_SIZE }
  }
}

function storeIndependentSidebarSize(size) {
  try { window.localStorage.setItem(INDEPENDENT_SIDEBAR_SIZE_KEY, JSON.stringify(size)) } catch {}
}

function updateIndependentSidebar(state) {
  independentSidebarState = state
  for (const listener of independentSidebarListeners) listener(state)
}

function readIndependentSidebarState() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INDEPENDENT_SIDEBAR_STATE_KEY) || 'null')
    if (!Array.isArray(value?.tabs)) return { tabs: [], activeTab: null, target: 'right' }
    const tabs = value.tabs.filter(tab => tab && typeof tab.id === 'string' && typeof tab.title === 'string'
      && ['files', 'terminal', 'preview'].includes(tab.kind)
      && (tab.kind !== 'preview' || typeof tab.path === 'string'))
    return {
      tabs,
      activeTab: tabs.some(tab => tab.id === value.activeTab) ? value.activeTab : tabs[0]?.id ?? null,
      target: value.target === 'bottom' ? 'bottom' : 'right',
    }
  } catch {
    return { tabs: [], activeTab: null, target: 'right' }
  }
}

function saveIndependentSidebarState(state) {
  try {
    window.localStorage.setItem(INDEPENDENT_SIDEBAR_STATE_KEY, JSON.stringify({
      tabs: state.tabs,
      activeTab: state.activeTab,
      target: state.target,
    }))
  } catch {}
}

function openIndependentSidebar(target) {
  const state = independentSidebarState ?? readIndependentSidebarState()
  const next = { ...state, target, activeTab: null }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function openIndependentSidebarTab(target, tab) {
  const state = independentSidebarState ?? readIndependentSidebarState()
  const existing = state.tabs.find(candidate => candidate.kind === tab.kind
    && (tab.kind !== 'preview' || candidate.path === tab.path))
  const nextTab = existing ?? { ...tab, id: tab.kind === 'preview' ? `preview:${tab.path}` : tab.kind }
  const tabs = existing ? state.tabs : [...state.tabs, nextTab]
  const next = { ...state, target, tabs, activeTab: nextTab.id }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function moveIndependentSidebar(target) {
  if (!independentSidebarState) return
  const next = { ...independentSidebarState, target }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function activateIndependentSidebarTab(tabId) {
  if (!independentSidebarState) return
  const next = { ...independentSidebarState, activeTab: tabId }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function reorderIndependentSidebarTab(tabId, beforeTabId) {
  if (!independentSidebarState || tabId === beforeTabId) return
  const tabs = [...independentSidebarState.tabs]
  const from = tabs.findIndex(tab => tab.id === tabId)
  const to = tabs.findIndex(tab => tab.id === beforeTabId)
  if (from < 0 || to < 0) return
  const [tab] = tabs.splice(from, 1)
  tabs.splice(from < to ? to - 1 : to, 0, tab)
  const next = { ...independentSidebarState, tabs }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function closeIndependentSidebarTab(tabId) {
  if (!independentSidebarState) return
  const index = independentSidebarState.tabs.findIndex(tab => tab.id === tabId)
  if (index < 0) return
  const closed = independentSidebarState.tabs[index]
  if (closed.kind === 'terminal') independentTerminalRuntime?.close()
  const tabs = independentSidebarState.tabs.filter(tab => tab.id !== tabId)
  const activeTab = independentSidebarState.activeTab === tabId
    ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null
    : independentSidebarState.activeTab
  const next = { ...independentSidebarState, tabs, activeTab }
  saveIndependentSidebarState(next)
  updateIndependentSidebar(next)
}

function useIndependentSidebar() {
  const [state, setState] = useState(independentSidebarState)
  useEffect(() => {
    independentSidebarListeners.add(setState)
    setState(independentSidebarState)
    return () => independentSidebarListeners.delete(setState)
  }, [])
  return state
}

function readTerminalFontSize() {
  try {
    const value = Number(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY))
    return Number.isInteger(value) && value >= MIN_TERMINAL_FONT_SIZE && value <= MAX_TERMINAL_FONT_SIZE
      ? value
      : DEFAULT_TERMINAL_FONT_SIZE
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE
  }
}

function storeTerminalFontSize(value) {
  try {
    window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(value))
  } catch {}
}

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

function FileManager({ onOpenRightSidebar = () => {}, onOpenBottomSidebar = () => {}, onPreviewFile = () => {} }) {
  const { state, load, reload } = useExplorer()
  const { downloadError } = useFileManagerState()
  const fileInput = useRef(null)
  const directoryInput = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const download = async item => {
    updateFileManagerState(current => ({
      ...current,
      downloadError: '',
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
        <button className="fat-toolbar-button" type="button" onClick={() => onOpenRightSidebar(state.root)} aria-label="在右侧边栏打开文件管理" title="在右侧边栏打开文件管理"><ExplorerGlyph kind="sidebar-right" />右侧栏</button>
        <button className="fat-toolbar-button" type="button" onClick={() => onOpenBottomSidebar(state.root)} aria-label="在底部面板打开文件管理" title="在底部面板打开文件管理"><ExplorerGlyph kind="sidebar-bottom" />底部栏</button>
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
          ? <><button className="fat-entry" type="button" onClick={() => load(item.path)}><ExplorerGlyph kind="folder" /><span>{item.name}</span></button><button className="fat-download" type="button" onClick={() => void download(item)} aria-label={`打包下载 ${item.name}`}>打包下载</button></>
          : item.type === 'file'
            ? <><button className="fat-entry" type="button" onClick={() => onPreviewFile(item)}><ExplorerGlyph kind="file" /><span>{item.name}</span><small>{formatSize(item.size)}</small></button><button className="fat-download" type="button" onClick={() => void download(item)} aria-label={`下载 ${item.name}`}>下载</button></>
            : <span className="fat-entry fat-muted"><span aria-hidden="true">◇</span><span>{item.name}</span></span>}
      </li>)}</ul>
      {state.truncated && <p className="fat-muted">目录过大，仅显示前 {state.items.length} 项。</p>}
    </>}
    <footer>浏览范围限制在配置的主机目录内。</footer>
  </section>
}

function previewFormat(name) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(extension)) {
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[extension] ?? `image/${extension}`
    return { kind: 'image', mime }
  }
  if (extension === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (['mp4', 'webm', 'mov'].includes(extension)) return { kind: 'video', mime: extension === 'mov' ? 'video/quicktime' : `video/${extension}` }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(extension)) return { kind: 'audio', mime: `audio/${extension}` }
  if (['txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bash', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'sql', 'csv', 'log', 'ini', 'conf', 'env', 'diff', 'patch'].includes(extension)) {
    return { kind: 'text', mime: 'text/plain' }
  }
  return { kind: 'unsupported', mime: 'application/octet-stream' }
}

function FilePreviewTab({ file }) {
  const format = previewFormat(file.name)
  const [content, setContent] = useState({ phase: format.kind === 'unsupported' ? 'unsupported' : 'loading', text: '', url: '', error: '' })
  useEffect(() => {
    if (format.kind === 'unsupported') return
    let live = true
    let objectUrl = ''
    setContent({ phase: 'loading', text: '', url: '', error: '' })
    void fetch(endpoint('download', file.path), { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) {
          const body = await response.json().catch(() => undefined)
          throw new Error(body?.error || `${response.status} ${response.statusText}`)
        }
        const blob = await response.blob()
        if (format.kind === 'text') return { text: await blob.text() }
        objectUrl = URL.createObjectURL(new Blob([blob], { type: format.mime }))
        return { url: objectUrl }
      })
      .then(result => { if (live) setContent({ phase: 'ready', text: result.text ?? '', url: result.url ?? '', error: '' }) })
      .catch(error => { if (live) setContent({ phase: 'failed', text: '', url: '', error: error?.message ?? String(error) }) })
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.path, file.name, format.kind, format.mime])

  if (content.phase === 'loading') return <div className="fat-preview-state" role="status">正在预览 {file.name}…</div>
  if (content.phase === 'failed') return <div className="fat-preview-state fat-error" role="alert">预览失败：{content.error}</div>
  if (content.phase === 'unsupported') return <div className="fat-preview-state">此文件类型不支持预览。<a href={endpoint('download', file.path).href} download={file.name}>下载文件</a></div>
  if (format.kind === 'text') return <pre className="fat-preview-text" tabIndex={0}>{content.text}</pre>
  if (format.kind === 'image') return <div className="fat-preview-media"><img src={content.url} alt={file.name} /></div>
  if (format.kind === 'pdf') return <iframe className="fat-preview-frame" src={content.url} title={file.name} />
  if (format.kind === 'video') return <div className="fat-preview-media"><video src={content.url} controls /></div>
  return <div className="fat-preview-media"><audio src={content.url} controls /></div>
}

function ExplorerGlyph({ kind, size = 18 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'sidebar-right' && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>}
    {kind === 'sidebar-bottom' && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18" /></>}
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
  const fontSize = readTerminalFontSize()
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize,
    scrollback: 10000,
    theme: { background: '#111318', foreground: '#e6e8ed', cursor: '#e6e8ed', selectionBackground: '#414b5b' },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host)
  fit.fit()
  terminal.buffer.onBufferChange(buffer => {
    if (buffer.type !== 'normal') return
    terminal.scrollToBottom()
    terminal.refresh(0, terminal.rows - 1)
  })
  const runtime = {
    terminal,
    fit,
    id: undefined,
    cwd: '',
    stream: undefined,
    listeners: new Set(),
    views: new Set(),
    owner: undefined,
    state: { status: '正在启动宿主 Bash…', error: '', fontSize },
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
    if (independentTerminalRuntime === runtime) independentTerminalRuntime = undefined
  }
  runtime.close = close
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

function TerminalPanel({ visible = true, source = 'main', onOpenRightSidebar = () => {}, onOpenBottomSidebar = () => {} }) {
  const host = useRef(null)
  const page = useRef(null)
  const terminalRef = useRef(null)
  const runtimeRef = useRef(null)
  const resizeRef = useRef(() => {})
  const [fontSize, setFontSize] = useState(readTerminalFontSize)
  const [fullscreen, setFullscreen] = useState(false)
  const [status, setStatus] = useState('正在启动宿主 Bash…')
  const [error, setError] = useState('')
  const adjustFontSize = delta => {
    const next = Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + delta))
    if (next === fontSize) return
    setFontSize(next)
    storeTerminalFontSize(next)
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
    const independent = source === 'independent-sidebar'
    let runtime = independent ? independentTerminalRuntime : terminalRuntime
    if (!active && !runtime) {
      setStatus('切换到终端标签以启动')
      return () => { mounted = false }
    }
    if (active && (!runtime || runtime.closed)) {
      runtime = createTerminalRuntime(host.current)
      if (independent) independentTerminalRuntime = runtime
      else terminalRuntime = runtime
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
        <button type="button" title="在右侧边栏打开终端" aria-label="在右侧边栏打开终端" onClick={() => onOpenRightSidebar(runtimeRef.current?.cwd ?? explorerCache?.root)}><ExplorerGlyph kind="sidebar-right" size={16} /></button>
        <button type="button" title="在底部面板打开终端" aria-label="在底部面板打开终端" onClick={() => onOpenBottomSidebar(runtimeRef.current?.cwd ?? explorerCache?.root)}><ExplorerGlyph kind="sidebar-bottom" size={16} /></button>
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

function AddSidebarTabPage({ onAdd }) {
  return <div className="fat-sidebar-add-page">
    <div className="fat-sidebar-add-content">
      <ExplorerGlyph kind="sidebar-right" size={24} />
      <h2>添加选项卡</h2>
      <p>选择要在侧栏中打开的工具。</p>
      <div>
        <button type="button" onClick={() => onAdd('files')}><ExplorerGlyph kind="folder" />文件管理</button>
        <button type="button" onClick={() => onAdd('terminal')}><span aria-hidden="true">$_</span>终端</button>
      </div>
    </div>
  </div>
}

function IndependentSidebarPanel() {
  const panel = useIndependentSidebar()
  const panelRef = useRef(null)
  const centerRef = useRef(null)
  const dragRef = useRef(null)
  const tabDragRef = useRef(null)
  const [size, setSize] = useState(readIndependentSidebarSize)
  const [showAddMenu, setShowAddMenu] = useState(false)

  useLayoutEffect(() => {
    const element = panelRef.current
    const overlay = element?.closest('[data-shell-overlay]')
    const frame = overlay?.parentElement
    const center = frame?.children[1]
    if (!panel || !element || !frame || !(center instanceof HTMLElement)) return
    centerRef.current = center
    const original = { marginRight: center.style.marginRight, marginBottom: center.style.marginBottom }
    center.setAttribute('data-fat-independent-push', '')
    const updateGeometry = () => {
      const frameRect = frame.getBoundingClientRect()
      const centerRect = center.getBoundingClientRect()
      if (panel.target === 'bottom') {
        element.style.left = `${centerRect.left - frameRect.left}px`
        element.style.right = `${frameRect.right - centerRect.right}px`
        center.style.marginRight = original.marginRight
        center.style.marginBottom = `${element.getBoundingClientRect().height}px`
      } else {
        element.style.left = ''
        element.style.right = '0'
        center.style.marginRight = `${element.getBoundingClientRect().width}px`
        center.style.marginBottom = original.marginBottom
      }
    }
    updateGeometry()
    const observer = new ResizeObserver(updateGeometry)
    observer.observe(frame)
    observer.observe(center)
    observer.observe(element)
    window.addEventListener('resize', updateGeometry)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateGeometry)
      center.style.marginRight = original.marginRight
      center.style.marginBottom = original.marginBottom
      center.removeAttribute('data-fat-independent-push')
      centerRef.current = null
      element.style.left = ''
      element.style.right = ''
    }
  }, [panel?.target])

  if (!panel) return null
  const open = target => moveIndependentSidebar(target)
  const close = () => updateIndependentSidebar(undefined)
  const activeTab = panel.tabs.find(tab => tab.id === panel.activeTab)
  const title = activeTab?.title ?? '侧栏'
  const addTab = kind => {
    openIndependentSidebarTab(panel.target, { kind, title: kind === 'files' ? '文件管理' : '终端' })
    setShowAddMenu(false)
  }
  const currentSize = panel.target === 'right' ? size.right : size.bottom
  const resizeStart = event => {
    event.preventDefault()
    const element = panelRef.current
    if (!element) return
    event.currentTarget.setPointerCapture(event.pointerId)
    element.setAttribute('data-fat-independent-dragging', '')
    centerRef.current?.setAttribute('data-fat-independent-dragging', '')
    dragRef.current = {
      pointerId: event.pointerId,
      target: panel.target,
      origin: panel.target === 'right' ? event.clientX : event.clientY,
      size: panel.target === 'right' ? element.getBoundingClientRect().width : element.getBoundingClientRect().height,
      value: currentSize,
    }
  }
  const resizeMove = event => {
    const drag = dragRef.current
    const element = panelRef.current
    if (!drag || drag.pointerId !== event.pointerId || !element) return
    const delta = drag.target === 'right' ? drag.origin - event.clientX : drag.origin - event.clientY
    const maximum = drag.target === 'right' ? window.innerWidth * 0.72 : window.innerHeight * 0.78
    const minimum = Math.min(drag.target === 'right' ? 260 : 180, maximum)
    const value = Math.max(minimum, Math.min(maximum, drag.size + delta))
    drag.value = value
    if (drag.target === 'right') {
      element.style.width = `${value}px`
      if (centerRef.current) centerRef.current.style.marginRight = `${value}px`
    } else {
      element.style.height = `${value}px`
      if (centerRef.current) centerRef.current.style.marginBottom = `${value}px`
    }
  }
  const resizeEnd = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    panelRef.current?.removeAttribute('data-fat-independent-dragging')
    centerRef.current?.removeAttribute('data-fat-independent-dragging')
    const next = { ...size, [drag.target]: Math.round(drag.value) }
    setSize(next)
    storeIndependentSidebarSize(next)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const adjustSize = delta => {
    const target = panel.target
    const maximum = target === 'right' ? window.innerWidth * 0.72 : window.innerHeight * 0.78
    const minimum = Math.min(target === 'right' ? 260 : 180, maximum)
    const next = { ...size, [target]: Math.max(minimum, Math.min(maximum, size[target] + delta)) }
    setSize(next)
    storeIndependentSidebarSize(next)
  }
  return <aside
    ref={panelRef}
    className={`fat-independent-sidebar fat-independent-sidebar-${panel.target}`}
    aria-label={`${title}侧栏`}
    style={panel.target === 'right' ? { width: `${size.right}px` } : { height: `${size.bottom}px` }}
  >
    <div
      className={`fat-independent-sidebar-splitter fat-independent-sidebar-splitter-${panel.target}`}
      role="separator"
      aria-orientation={panel.target === 'right' ? 'vertical' : 'horizontal'}
      aria-label={panel.target === 'right' ? '调整侧栏宽度' : '调整侧栏高度'}
      aria-valuenow={Math.round(currentSize)}
      tabIndex={0}
      onPointerDown={resizeStart}
      onPointerMove={resizeMove}
      onPointerUp={resizeEnd}
      onPointerCancel={resizeEnd}
      onLostPointerCapture={resizeEnd}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); adjustSize(16) }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); adjustSize(-16) }
      }}
    />
    <header className="fat-independent-sidebar-header">
      <div className="fat-independent-sidebar-tabbar">
        <div className="fat-independent-sidebar-tabs" role="tablist" aria-label="侧栏页面">
          {panel.tabs.map(tab => <div
            className="fat-independent-sidebar-tab"
            key={tab.id}
            draggable
            onDragStart={event => {
              tabDragRef.current = tab.id
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', tab.id)
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              const moving = tabDragRef.current
              if (moving) reorderIndependentSidebarTab(moving, tab.id)
              tabDragRef.current = null
            }}
            onDragEnd={() => { tabDragRef.current = null }}
          >
            <button type="button" role="tab" aria-selected={panel.activeTab === tab.id} onClick={() => activateIndependentSidebarTab(tab.id)} title={tab.title}>{tab.title}</button>
            <button type="button" className="fat-independent-sidebar-tab-close" aria-label={`关闭 ${tab.title}`} title={`关闭 ${tab.title}`} onClick={() => closeIndependentSidebarTab(tab.id)}>×</button>
          </div>)}
        </div>
        <button type="button" className="fat-independent-sidebar-add" aria-label="添加侧栏标签" title="添加侧栏标签" aria-expanded={showAddMenu} onClick={() => setShowAddMenu(value => !value)}>+</button>
        {showAddMenu && <div className="fat-independent-sidebar-add-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => addTab('files')}>文件管理</button>
          <button type="button" role="menuitem" onClick={() => addTab('terminal')}>终端</button>
        </div>}
      </div>
      <div className="fat-independent-sidebar-actions">
        <button type="button" aria-label="打开右侧栏" title="打开右侧栏" aria-pressed={panel.target === 'right'} onClick={() => open('right')}><ExplorerGlyph kind="sidebar-right" size={16} /></button>
        <button type="button" aria-label="打开底部栏" title="打开底部栏" aria-pressed={panel.target === 'bottom'} onClick={() => open('bottom')}><ExplorerGlyph kind="sidebar-bottom" size={16} /></button>
        <button type="button" aria-label="关闭侧栏" title="关闭侧栏" onClick={close}>×</button>
      </div>
    </header>
    <div className="fat-independent-sidebar-content">
      {!activeTab && <AddSidebarTabPage onAdd={kind => openIndependentSidebarTab(panel.target, { kind, title: kind === 'files' ? '文件管理' : '终端' })} />}
      {activeTab?.kind === 'files' && <FileManager
        onOpenRightSidebar={() => open('right')}
        onOpenBottomSidebar={() => open('bottom')}
        onPreviewFile={file => openIndependentSidebarTab(panel.target, { kind: 'preview', title: file.name, path: file.path })}
      />}
      {activeTab?.kind === 'terminal' && <TerminalPanel
        visible
        source="independent-sidebar"
        onOpenRightSidebar={() => open('right')}
        onOpenBottomSidebar={() => open('bottom')}
      />}
      {activeTab?.kind === 'preview' && <FilePreviewTab file={{ name: activeTab.title, path: activeTab.path }} />}
    </div>
  </aside>
}

const styleText = `
.fat-explorer{height:100%;min-height:0;overflow:auto;padding:28px clamp(18px,4vw,48px);color:var(--dsw-alias-label-primary);font:inherit}
.fat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l2)}.fat-toolbar h1{margin:0;font-size:22px;font-weight:650}.fat-toolbar p{max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.fat-toolbar-actions{display:flex;align-items:center;gap:8px;flex:none}.fat-toolbar-button,.fat-parent{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s}.fat-toolbar-button:hover:not(:disabled),.fat-parent:hover{border-color:var(--dsw-alias-brand-primary)}.fat-toolbar-button:disabled{opacity:.55;cursor:wait}.fat-file-input{display:none}
 @media(max-width:600px){.fat-toolbar{align-items:flex-start;flex-wrap:wrap}.fat-toolbar>div:first-child{min-width:0;flex:1}.fat-toolbar-actions{width:100%;flex-wrap:wrap}.fat-toolbar-button{flex:1;padding:0 10px}}
 .fat-explorer .fat-toolbar-actions .fat-toolbar-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;flex:none;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:color .15s}.fat-explorer .fat-toolbar-actions .fat-toolbar-button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.fat-explorer button.fat-parent{flex:none;margin:12px 0 8px;border:0;background:transparent;color:inherit}
 .fat-independent-sidebar{position:absolute;z-index:1;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 8px 32px rgb(0 0 0 / .28);border:1px solid var(--dsw-alias-border-l2);transition:width .18s ease,height .18s ease}.fat-independent-sidebar-right{inset:0 0 0 auto;width:380px;max-width:min(90vw,72vw)}.fat-independent-sidebar-bottom{inset:auto 0 0;height:320px;max-height:78vh}.fat-independent-sidebar-header{height:42px;flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:13px}.fat-independent-sidebar-tabs{display:flex;align-items:center;gap:4px;min-width:0}.fat-independent-sidebar-tabs button{height:30px;padding:0 11px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}.fat-independent-sidebar-tabs button[aria-selected=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}.fat-independent-sidebar-actions{display:flex;align-items:center;gap:4px}.fat-independent-sidebar-actions button{width:30px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;cursor:pointer}.fat-independent-sidebar-actions button:hover,.fat-independent-sidebar-actions button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.fat-independent-sidebar-content{flex:1;min-height:0;overflow:hidden}.fat-independent-sidebar-content>.fat-explorer,.fat-independent-sidebar-content>.fat-terminal-page{height:100%;padding-top:14px}.fat-independent-sidebar-splitter{position:absolute;z-index:2;touch-action:none;outline:none}.fat-independent-sidebar-splitter:focus-visible{background:var(--dsw-alias-brand-primary)}.fat-independent-sidebar-splitter-right{left:-4px;top:0;bottom:0;width:8px;cursor:col-resize}.fat-independent-sidebar-splitter-bottom{left:0;right:0;top:-4px;height:8px;cursor:row-resize}.fat-independent-sidebar[data-fat-independent-dragging], [data-fat-independent-push][data-fat-independent-dragging]{transition:none!important}[data-fat-independent-push]{transition:margin-right .18s ease,margin-bottom .18s ease}
 .fat-independent-sidebar-tabbar{position:relative;display:flex;align-items:center;flex:1;min-width:0}.fat-independent-sidebar-tab{display:flex;align-items:center;min-width:0;max-width:200px;height:30px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}.fat-independent-sidebar-tab>[role=tab]{height:30px;min-width:0;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.fat-independent-sidebar-tab>[role=tab][aria-selected=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}.fat-independent-sidebar-tabs .fat-independent-sidebar-tab-close{width:22px;height:26px;flex:none;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}.fat-independent-sidebar-tab-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
 .fat-independent-sidebar-tabs{position:relative;flex:1}.fat-independent-sidebar-tabs .fat-independent-sidebar-tab-close{width:22px;height:26px;flex:none;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}.fat-independent-sidebar-tabs .fat-independent-sidebar-tab-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.fat-independent-sidebar-add{width:28px;height:28px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;cursor:pointer}.fat-independent-sidebar-add:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.fat-independent-sidebar-add-menu{position:absolute;z-index:4;top:34px;left:0;display:grid;min-width:140px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgb(0 0 0 / .2)}.fat-independent-sidebar-add-menu button{height:32px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:12px;cursor:pointer}.fat-independent-sidebar-add-menu button:hover{background:var(--dsw-alias-bg-layer-2)}
 .fat-preview-state{height:100%;display:grid;place-content:center;gap:12px;padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}.fat-preview-state a{color:var(--dsw-alias-brand-primary)}.fat-preview-text{height:100%;overflow:auto;margin:0;padding:18px 20px;color:var(--dsw-alias-label-primary);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;tab-size:2}.fat-preview-media{height:100%;display:grid;place-items:center;overflow:auto;padding:12px}.fat-preview-media img,.fat-preview-media video{max-width:100%;max-height:100%;object-fit:contain}.fat-preview-media audio{width:min(100%,480px)}.fat-preview-frame{width:100%;height:100%;border:0;background:white}
 .fat-sidebar-add-page{height:100%;min-height:0;display:grid;place-items:center;overflow:auto;padding:24px;color:var(--dsw-alias-label-primary)}.fat-sidebar-add-content{max-width:420px;text-align:center}.fat-sidebar-add-content>svg{color:var(--dsw-alias-label-tertiary)}.fat-sidebar-add-content h2{margin:14px 0 6px;font-size:16px;font-weight:600}.fat-sidebar-add-content p{margin:0 0 18px;color:var(--dsw-alias-label-tertiary);font-size:12px}.fat-sidebar-add-content>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fat-sidebar-add-content button{min-height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.fat-sidebar-add-content button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
  @media(prefers-reduced-motion:reduce){.fat-independent-sidebar,[data-fat-independent-push]{transition:none}}
.fat-parent{margin:16px 0 8px}.fat-list{list-style:none;margin:0;padding:0}.fat-list li{display:flex;align-items:center;min-height:42px;border-bottom:1px solid var(--dsw-alias-border-l1)}.fat-list li.fat-hidden{opacity:.46}.fat-entry{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:8px 6px;color:inherit;text-decoration:none}.fat-list button.fat-entry{border:0;background:none;text-align:left;font:inherit;cursor:pointer}.fat-list button.fat-entry:hover{background:var(--dsw-alias-bg-layer-2)}.fat-entry>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fat-entry small{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}.fat-download{margin:0 8px;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.fat-download:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.fat-download:disabled{opacity:.55;cursor:wait}.fat-empty,.fat-muted,.fat-explorer footer{color:var(--dsw-alias-label-tertiary);font-size:13px}.fat-explorer footer{margin-top:24px}.fat-error{color:#ff7d7d}.fat-terminal-page{height:100%;min-height:0;display:flex;flex-direction:column;background:#111318;color:#e6e8ed;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.fat-terminal-page:fullscreen{width:100vw;height:100vh}.fat-terminal-bar{height:42px;flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid #292d36;color:#aeb4c0}.fat-terminal-mark{font-weight:700;color:#74a7ff}.fat-terminal-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fat-terminal-screen{flex:1;min-height:0;padding:8px}.fat-terminal-screen .xterm{height:100%}.fat-terminal-controls{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}.fat-terminal-controls button{min-width:30px;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 7px;border:1px solid #343a46;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.fat-terminal-controls button:hover:not(:disabled){background:#292d36;color:#fff}.fat-terminal-controls button:disabled{opacity:.4;cursor:default}.fat-terminal-controls>span{min-width:28px;text-align:center;font-size:11px}.fat-terminal-bar .fat-error{font-size:12px}.fat-terminal-page:fullscreen .fat-terminal-controls{margin-left:0}
.fat-terminal-screen .xterm{ text-spacing-trim:space-all }
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
  inject('main', () => ctx.slots.register({
    name: 'main', key: descriptor.id,
    inject: () => {
      return {
        onOpenRightSidebar: () => openIndependentSidebar('right'),
        onOpenBottomSidebar: () => openIndependentSidebar('bottom'),
        onPreviewFile: file => openIndependentSidebarTab('right', { kind: 'preview', title: file.name, path: file.path }),
      }
    },
  }, descriptor.component))
}

function registerIndependentSidebar(ctx) {
  try {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'file-and-terminal.independent-sidebar',
    }, IndependentSidebarPanel))
  } catch (error) {
    warnRegistration('independent sidebar overlay', error)
  }
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
  registerIndependentSidebar(ctx)

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
