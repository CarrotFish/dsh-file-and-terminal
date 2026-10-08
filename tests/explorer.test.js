import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createExplorer } from '../explorer.js'

test('lists directories and downloads files within configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-explorer-'))
  try {
    await mkdir(join(root, 'folder'))
    await mkdir(join(root, '.hidden-folder'))
    await writeFile(join(root, '.secret'), 'hidden')
    await writeFile(join(root, 'visible.txt'), 'visible')
    await writeFile(join(root, 'folder', 'hello.txt'), 'hello')
    const explorer = await createExplorer({ root, maxEntries: 20, maxDownloadBytes: 100 })
    const listing = await explorer.list('')
    assert.equal(listing.items[0].name, 'folder')
    assert.equal(listing.items[0].type, 'directory')
    assert.deepEqual(listing.items.map(item => item.name), ['folder', 'visible.txt', '.hidden-folder', '.secret'])
    assert.equal(listing.items[0].hidden, false)
    assert.equal(listing.items[2].hidden, true)
    const bounded = await createExplorer({ root, maxEntries: 2, maxDownloadBytes: 100 })
    const boundedListing = await bounded.list('')
    assert.deepEqual(boundedListing.items.map(item => item.name), ['folder', 'visible.txt'])
    assert.equal(boundedListing.truncated, true)
    const child = await explorer.list('folder')
    assert.equal(child.items[0].path, 'folder/hello.txt')
    assert.equal((await explorer.download('folder/hello.txt')).bytes.toString(), 'hello')
    const archive = await explorer.download('folder')
    assert.equal(archive.name, 'folder.zip')
    assert.equal(archive.type, 'directory')
    assert.equal(archive.bytes.readUInt32LE(0), 0x04034B50)
    assert.ok(archive.bytes.includes(Buffer.from('folder/hello.txt')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects traversal, external symlinks, and oversized downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-explorer-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-explorer-outside-'))
  try {
    await writeFile(join(root, 'large.bin'), '0123456789')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    const explorer = await createExplorer({ root, maxEntries: 20, maxDownloadBytes: 4 })
    await assert.rejects(explorer.list('../'), { status: 403 })
    await assert.rejects(explorer.download('escape.txt'), { status: 403 })
    await assert.rejects(explorer.download('large.bin'), { status: 413 })
    await assert.rejects(explorer.download(''), { status: 413 })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('uploads files and nested directory contents without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-explorer-upload-'))
  try {
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'target', 'existing.txt'), 'keep')
    const explorer = await createExplorer({ root, maxEntries: 20, maxDownloadBytes: 100, maxUploadBytes: 20 })
    const uploaded = await explorer.upload('target', [
      { path: 'hello.txt', bytes: Buffer.from('hello') },
      { path: 'new/nested.txt', bytes: Buffer.from('nested') },
    ])
    assert.equal(uploaded, 2)
    assert.equal(await readFile(join(root, 'target', 'hello.txt'), 'utf8'), 'hello')
    assert.equal(await readFile(join(root, 'target', 'new', 'nested.txt'), 'utf8'), 'nested')
    await assert.rejects(explorer.upload('target', [{ path: 'existing.txt', bytes: Buffer.from('replace') }]), { status: 409 })
    await assert.rejects(explorer.upload('target', [{ path: '../escape.txt', bytes: Buffer.from('no') }]), { status: 400 })
    await assert.rejects(explorer.upload('target', [{ path: 'large.txt', bytes: Buffer.alloc(21) }]), { status: 413 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
