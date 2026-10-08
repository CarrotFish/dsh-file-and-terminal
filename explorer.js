import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, relative, resolve, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes) {
  let value = 0xFFFFFFFF
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8)
  return (value ^ 0xFFFFFFFF) >>> 0
}

function zip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.bytes)
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function expandHome(path) {
  return path.replace(/^~(?=\/|$)/u, homedir())
}

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

export async function createExplorer(config) {
  const root = await realpath(resolve(expandHome(config.root)))
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error(`Explorer root is not a directory: ${root}`)

  async function resolveTarget(requested) {
    const candidate = resolve(root, requested || '.')
    if (!inside(root, candidate)) throw Object.assign(new Error('Path is outside the configured Explorer root'), { status: 403 })
    let target
    try { target = await realpath(candidate) } catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error('Path does not exist'), { status: 404 })
      throw error
    }
    if (!inside(root, target)) throw Object.assign(new Error('Symlink target is outside the configured Explorer root'), { status: 403 })
    return target
  }

  return {
    root,
    async list(path) {
      const directory = await resolveTarget(path)
      const info = await stat(directory)
      if (!info.isDirectory()) throw Object.assign(new Error('Path is not a directory'), { status: 400 })
      const names = await readdir(directory)
      names.sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.'))
        || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      const items = []
      for (const name of names.slice(0, config.maxEntries)) {
        const absolutePath = resolve(directory, name)
        let entry
        try {
          const linkInfo = await lstat(absolutePath)
          const target = await realpath(absolutePath).catch(() => undefined)
          if (target !== undefined && !inside(root, target)) continue
          const targetInfo = target === undefined ? linkInfo : await stat(target)
          entry = {
            name,
            path: relative(root, absolutePath).split(sep).join('/'),
            hidden: name.startsWith('.'),
            type: targetInfo.isDirectory() ? 'directory' : targetInfo.isFile() ? 'file' : 'other',
            size: targetInfo.isFile() ? targetInfo.size : undefined,
            modifiedAt: targetInfo.mtime.toISOString(),
          }
        } catch {
          continue
        }
        items.push(entry)
      }
      items.sort((a, b) => Number(a.hidden) - Number(b.hidden)
        || Number(b.type === 'directory') - Number(a.type === 'directory')
        || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      return { root, path: directory, parent: directory === root ? null : relative(root, resolve(directory, '..')).split(sep).join('/'), items, truncated: names.length > config.maxEntries }
    },
    async download(path) {
      const file = await resolveTarget(path)
      const info = await stat(file)
      if (info.isFile()) {
        if (info.size > config.maxDownloadBytes) throw Object.assign(new Error(`File exceeds the ${config.maxDownloadBytes} byte download limit`), { status: 413 })
        return { name: basename(file), bytes: await readFile(file), type: 'file' }
      }
      if (!info.isDirectory()) throw Object.assign(new Error('Path is not a file or directory'), { status: 400 })

      const entries = []
      let totalBytes = 0
      const archiveRoot = basename(file) || 'archive'
      entries.push({ name: `${archiveRoot}/`, bytes: Buffer.alloc(0) })
      async function addDirectory(directory, archivePath, ancestors) {
        const target = await realpath(directory)
        if (!inside(root, target)) return
        if (ancestors.has(target)) return
        const nextAncestors = new Set(ancestors).add(target)
        const names = await readdir(directory)
        for (const name of names) {
          const absolutePath = resolve(directory, name)
          let resolved
          try { resolved = await realpath(absolutePath) } catch (error) {
            if (error?.code === 'ENOENT') continue
            throw error
          }
          if (!inside(root, resolved)) continue
          const itemInfo = await stat(resolved)
          const entryName = `${archivePath}/${name}`
          if (itemInfo.isDirectory()) {
            entries.push({ name: `${entryName}/`, bytes: Buffer.alloc(0) })
            if (entries.length > 10000) throw Object.assign(new Error('Directory contains too many entries to archive'), { status: 413 })
            await addDirectory(resolved, entryName, nextAncestors)
          } else if (itemInfo.isFile()) {
            totalBytes += itemInfo.size
            if (totalBytes > config.maxDownloadBytes) {
              throw Object.assign(new Error(`Directory exceeds the ${config.maxDownloadBytes} byte download limit`), { status: 413 })
            }
            entries.push({ name: entryName, bytes: await readFile(resolved) })
            if (entries.length > 10000) throw Object.assign(new Error('Directory contains too many entries to archive'), { status: 413 })
          }
        }
      }
      await addDirectory(file, archiveRoot, new Set())
      return { name: `${archiveRoot}.zip`, bytes: zip(entries), type: 'directory' }
    },
    async upload(path, files) {
      const directory = await resolveTarget(path)
      if (!(await stat(directory)).isDirectory()) throw Object.assign(new Error('Upload target is not a directory'), { status: 400 })
      if (files.length > 10000) throw Object.assign(new Error('Upload contains too many files'), { status: 413 })

      let totalBytes = 0
      const prepared = files.map(file => {
        const parts = String(file.path).split('/')
        if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
          throw Object.assign(new Error('Invalid upload path'), { status: 400 })
        }
        totalBytes += file.bytes.byteLength
        if (totalBytes > config.maxUploadBytes) {
          throw Object.assign(new Error(`Upload exceeds the ${config.maxUploadBytes} byte upload limit`), { status: 413 })
        }
        return { parts, bytes: file.bytes }
      })

      for (const file of prepared) {
        let parent = directory
        for (const part of file.parts.slice(0, -1)) {
          const next = resolve(parent, part)
          try { await mkdir(next) } catch (error) {
            if (error?.code !== 'EEXIST') throw error
          }
          const info = await lstat(next)
          if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error(`Upload path conflicts with an existing entry: ${part}`), { status: 409 })
          parent = await realpath(next)
          if (!inside(root, parent)) throw Object.assign(new Error('Upload path is outside the configured Explorer root'), { status: 403 })
        }
        const target = resolve(parent, file.parts.at(-1))
        try {
          await writeFile(target, file.bytes, { flag: 'wx' })
        } catch (error) {
          if (error?.code === 'EEXIST' || error?.code === 'EISDIR') {
            throw Object.assign(new Error(`An entry already exists at upload path: ${file.parts.join('/')}`), { status: 409 })
          }
          throw error
        }
      }
      return prepared.length
    },
  }
}

export { inside }
