import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createExplorer } from './explorer.js'

export const name = 'file-and-terminal'
export const inject = ['connection', 'subprocess']

export const Config = Schema.object({
  root: Schema.string().default('~'),
  maxEntries: Schema.number().min(1).max(10000).default(1000),
  maxDownloadBytes: Schema.number().min(1).max(1073741824).default(67108864),
  maxUploadBytes: Schema.number().min(1).max(1073741824).default(67108864),
  terminalBufferBytes: Schema.number().min(4096).max(1048576).default(262144),
  terminalGraceMs: Schema.number().min(100).max(30000).default(2000),
  maxTerminals: Schema.number().min(1).max(16).default(4),
})

const API_PATH = '/api/file-and-terminal'

export async function apply(ctx, config) {
  const explorer = await createExplorer(config)
  const terminals = new Map()
  const closeTerminal = async id => {
    const terminal = terminals.get(id)
    if (!terminal) return
    terminals.delete(id)
    terminal.closed = true
    for (const close of [...terminal.streams]) close()
    await terminal.handle.terminate()
  }
  const closeAll = async () => {
    await Promise.allSettled([...terminals.keys()].map(id => closeTerminal(id)))
  }
  const createTerminal = async (cols, rows, signal) => {
    if (terminals.size >= config.maxTerminals) throw Object.assign(new Error('Too many open host terminals'), { status: 429 })
    const shell = await ctx.subprocess.resolveExecutable('bash')
    const handle = await ctx.subprocess.spawnTerminal({
      argv: [shell, '--login', '-i'],
      cwd: explorer.root,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      cols,
      rows,
      terminalType: 'xterm-256color',
      shellActivity: true,
      graceMs: config.terminalGraceMs,
      signal,
    })
    const terminal = { handle, streams: new Set(), output: '', outputBytes: 0, closed: false }
    const id = randomUUID()
    terminals.set(id, terminal)
    handle.output.setEncoding('utf8')
    handle.output.on('data', chunk => {
      terminal.output += chunk
      terminal.outputBytes += Buffer.byteLength(chunk)
      while (terminal.outputBytes > config.terminalBufferBytes && terminal.output.length > 0) {
        const first = terminal.output.charCodeAt(0)
        const count = first >= 0xD800 && first <= 0xDBFF && terminal.output.charCodeAt(1) >= 0xDC00 && terminal.output.charCodeAt(1) <= 0xDFFF ? 2 : 1
        terminal.outputBytes -= Buffer.byteLength(terminal.output.slice(0, count))
        terminal.output = terminal.output.slice(count)
      }
      for (const send of [...terminal.streams]) send({ type: 'output', data: chunk })
    })
    void handle.done.then(
      outcome => {
        terminal.outcome = { type: 'exit', ...outcome }
        for (const send of [...terminal.streams]) send(terminal.outcome)
      },
      error => {
        terminal.outcome = { type: 'error', message: error?.message ?? String(error) }
        for (const send of [...terminal.streams]) send(terminal.outcome)
      },
    )
    return { id, cwd: explorer.root }
  }

  const unregister = ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const url = new URL(request.url)
        const multipart = request.method === 'POST' && request.headers.get('content-type')?.startsWith('multipart/form-data')
        const body = request.method === 'POST' ? multipart ? await request.formData() : await request.json() : undefined
        const action = body?.action ?? url.searchParams.get('action')
        if (request.method === 'GET') {
          if (action === 'root') return Response.json({ root: explorer.root })
          if (action === 'list') return Response.json(await explorer.list(url.searchParams.get('path') ?? ''))
          if (action === 'download') {
            const file = await explorer.download(url.searchParams.get('path') ?? '')
            const safeName = encodeURIComponent(file.name).replaceAll("'", '%27')
            return new Response(file.bytes, { headers: {
              'Content-Type': file.type === 'directory' ? 'application/zip' : 'application/octet-stream',
              'Content-Length': String(file.bytes.byteLength),
              'Content-Disposition': `attachment; filename*=UTF-8''${safeName}`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            } })
          }
          if (action === 'stream') {
            const terminal = terminals.get(url.searchParams.get('id'))
            if (!terminal || terminal.closed) return Response.json({ error: 'Terminal not found' }, { status: 404 })
            let controller
            let closed = false
            let heartbeat
            const send = message => {
              if (closed) return
              try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`)) } catch { finish() }
            }
            const finish = () => {
              if (closed) return
              closed = true
              terminal.streams.delete(send)
              clearInterval(heartbeat)
              request.signal.removeEventListener('abort', finish)
              try { controller.close() } catch {}
            }
            const stream = new ReadableStream({
              start(value) {
                controller = value
                terminal.streams.add(send)
                request.signal.addEventListener('abort', finish, { once: true })
                if (terminal.output) send({ type: 'output', data: terminal.output })
                if (terminal.outcome) send(terminal.outcome)
                heartbeat = setInterval(() => {
                  if (!closed) controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'))
                }, 15000)
                heartbeat.unref?.()
              },
              cancel() { finish() },
            })
            return new Response(stream, { headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-store',
              'X-Accel-Buffering': 'no',
            } })
          }
          return Response.json({ error: 'Unknown action' }, { status: 400 })
        }

        if (action === 'create') {
          const cols = Number.isInteger(body.cols) ? Math.min(300, Math.max(20, body.cols)) : 80
          const rows = Number.isInteger(body.rows) ? Math.min(120, Math.max(5, body.rows)) : 24
          const created = await createTerminal(cols, rows, request.signal)
          if (request.signal.aborted) {
            await closeTerminal(created.id)
            request.signal.throwIfAborted()
          }
          return Response.json(created)
        }
        if (action === 'upload') {
          const files = typeof body?.getAll === 'function' ? body.getAll('files') : []
          const paths = typeof body?.getAll === 'function' ? body.getAll('paths') : []
          if (files.length === 0 || files.length !== paths.length || files.some(file => typeof file.arrayBuffer !== 'function')) {
            return Response.json({ error: 'Invalid upload request' }, { status: 400 })
          }
          const uploaded = await explorer.upload(url.searchParams.get('path') ?? '', await Promise.all(files.map(async (file, index) => ({
            path: String(paths[index]),
            bytes: Buffer.from(await file.arrayBuffer()),
          }))))
          return Response.json({ uploaded })
        }
        const id = typeof body.id === 'string' ? body.id : ''
        const terminal = terminals.get(id)
        if (!terminal || terminal.closed) return Response.json({ error: 'Terminal not found' }, { status: 404 })
        if (action === 'input') {
          if (typeof body.data !== 'string' || body.data.length > 65536) return Response.json({ error: 'Invalid terminal input' }, { status: 400 })
          await terminal.handle.write(body.data)
          return new Response(null, { status: 204 })
        }
        if (action === 'resize') {
          const cols = Number(body.cols)
          const rows = Number(body.rows)
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 300 || rows < 1 || rows > 120) {
            return Response.json({ error: 'Invalid terminal dimensions' }, { status: 400 })
          }
          await terminal.handle.resize(cols, rows)
          return new Response(null, { status: 204 })
        }
        if (action === 'close') {
          await closeTerminal(id)
          return new Response(null, { status: 204 })
        }
        return Response.json({ error: 'Unknown action' }, { status: 400 })
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        ctx.logger.warn('file-and-terminal Explorer request failed:', error)
        return Response.json({ error: error?.message ?? 'Explorer request failed' }, { status })
      }
    },
  })
  ctx.effect(() => {
    return async () => {
      unregister()
      await closeAll()
    }
  }, 'file-and-terminal Explorer and PTY lifecycle')
}

export { API_PATH }
