import path from 'node:path'
import fs from 'node:fs/promises'
import chalk from 'chalk'
import ora from 'ora'
import { openDrive, replicate } from './hyper.js'
import { startDav } from './webdav.js'

const sym = {
  ok: chalk.green('✓'), info: chalk.cyan('ℹ︎'), warn: chalk.yellow('⚠︎'), x: chalk.red('✗')
}
const toHex = b => Buffer.from(b).toString('hex')

export async function initDrive (storage, { verbose = false } = {}) {
  const spinner = ora('Opening writer store…').start()
  const { drive, dirPath } = await openDrive(storage)
  await drive.put('/.init', Buffer.from('ok')); await drive.del('/.init')
  spinner.succeed(`${sym.ok} Drive created`)
  console.log(`${sym.info} Key: ${chalk.bold(toHex(drive.key))}`)
  console.log(`${sym.info} Store: ${chalk.gray(dirPath)}`)
  return { keyHex: toHex(drive.key), discoveryKeyHex: toHex(drive.discoveryKey), storageDir: dirPath }
}

export async function seedDrive (storage, { verbose = false } = {}) {
  const { drive } = await openDrive(storage)
  const spinner = ora('Joining swarm…').start()
  await replicate(drive, { verbose })
  spinner.succeed(`${sym.ok} Seeding ${chalk.bold(toHex(drive.key))}`)
}

export async function joinDrive (keyHex, storage, { verbose = false } = {}) {
  const spinner = ora('Joining swarm…').start()
  const { drive, dirPath } = await openDrive(storage, keyHex)
  await replicate(drive, { verbose })
  spinner.succeed(`${sym.ok} Joined`)
  console.log(`${sym.info} Key     : ${chalk.bold(keyHex)}`)
  console.log(`${sym.info} Writable: ${chalk.bold(drive.writable ? 'yes' : 'no')}`)
  console.log(`${sym.info} Store   : ${chalk.gray(dirPath)}`)
  return { drive, storageDir: dirPath, keyHex }
}

export async function putFile (keyHex, src, dst, storage) {
  const { drive } = await openDrive(storage, keyHex)
  const data = await fs.readFile(path.resolve(src))
  await drive.put(dst, data)
}

export async function getFile (keyHex, src, dst, storage) {
  const { drive } = await openDrive(storage, keyHex)
  const data = await drive.get(src, { wait: true })
  if (!data) throw new Error('File not found in drive: ' + src)
  await fs.mkdir(path.dirname(path.resolve(dst)), { recursive: true })
  await fs.writeFile(path.resolve(dst), data)
}

export async function listDir (keyHex, dir = '/', storage) {
  const { drive } = await openDrive(storage, keyHex)
  const out = []
  for await (const entry of drive.list(dir)) out.push(entry.key)
  return out
}

export async function serveWebDAV (keyHex, { storage, host, port, readOnly, verbose }) {
  // open drive/session
  const { drive, swarm, store, close: closeHyper } = await openDrive(storage, keyHex)
  await replicate(drive)

  // start WebDAV
  const { close: closeDav } = await startDav(drive, { host, port, readOnly, verbose })

  // return a single cleanup fn
  return async function cleanup () {
    try { await closeDav?.() } catch {}
    try { await swarm?.destroy?.() } catch {}
    try { await closeHyper?.() } catch {}
    try { await store?.close?.() } catch {}
    try { await drive?.close?.() } catch {}
  }
}
