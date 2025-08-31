import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import path from 'node:path'
import fs from 'node:fs/promises'

export async function openDrive (storageDir, keyHex) {
  const root = storageDir || './p2pdrive-storage'
  await fs.mkdir(root, { recursive: true })
  // Unified folder for writer/reader
  const dirName = 'drive-local'
  const store = new Corestore(path.join(root, dirName))
  const drive = new Hyperdrive(store, keyHex ? Buffer.from(keyHex, 'hex') : undefined)
  await drive.ready()
  return { drive, store, root, dirPath: path.join(root, dirName) }
}

export async function replicate (drive, { verbose = false } = {}) {
  const swarm = new Hyperswarm()
  const done = drive.findingPeers()
  swarm.on('connection', (socket) => {
    if (verbose) console.log('↔︎ Replicating over new peer connection')
    drive.replicate(socket)
  })
  await swarm.join(drive.discoveryKey)
  await swarm.flush()
  done()
  if (verbose) {
    console.log('📡 Joined swarm (discovery key):', Buffer.from(drive.discoveryKey).toString('hex'))
  }
  return swarm
}
