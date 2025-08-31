import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import {
  initDrive, seedDrive, joinDrive,
  putFile, getFile, listDir, serveWebDAV
} from './lib/commands.js'

const program = new Command()
program
  .name('p2pdrive')
  .description('P2P Hyperdrive over WebDAV (no-daemon, PoC)')
  .version('1.2.2')

program.command('init')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .option('--verbose', 'Verbose output', false)
  .action(async (opts) => {
    const out = await initDrive(opts.storage, { verbose: !!opts.verbose })
    console.log(chalk.green('✓'), 'Key:', chalk.bold(out.keyHex))
  })

program.command('seed')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .option('--verbose', 'Verbose output', false)
  .action(async (opts) => { await seedDrive(opts.storage, { verbose: !!opts.verbose }) })

program.command('join <keyHex>')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .option('--verbose', 'Verbose output', false)
  .action(async (keyHex, opts) => { await joinDrive(keyHex, opts.storage, { verbose: !!opts.verbose }) })

program.command('put <keyHex> <src> <dst>')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .description('Upload local file <src> into drive at <dst>')
  .action(async (keyHex, src, dst, opts) => {
    const spin = ora('Uploading…').start()
    try { await putFile(keyHex, src, dst, opts.storage); spin.succeed('✓ Uploaded') }
    catch (e) { spin.fail('✗ Upload failed'); console.error('Error:', e.message); process.exit(1) }
  })

program.command('get <keyHex> <src> <dst>')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .description('Download file <src> from drive into local <dst>')
  .action(async (keyHex, src, dst, opts) => {
    const spin = ora('Downloading…').start()
    try { await getFile(keyHex, src, dst, opts.storage); spin.succeed('✓ Downloaded') }
    catch (e) { spin.fail('✗ Download failed'); console.error('Error:', e.message); process.exit(1) }
  })

program.command('ls <keyHex> [dir]')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .description('List directory contents in drive')
  .action(async (keyHex, dir='/', opts) => {
    try { const files = await listDir(keyHex, dir, opts.storage); files.forEach(f => console.log(f)) }
    catch (e) { console.error('Error:', e.message); process.exit(1) }
  })

program.command('serve <keyHex>')
  .option('-s, --storage <dir>', 'Storage directory (default: ./p2pdrive-storage)')
  .option('-H, --host <host>', 'Host/interface to bind', '127.0.0.1')
  .option('-p, --port <n>', 'Port', '4919')
  .option('--read-only', 'Reject all write operations', false)
  .option('--verbose', 'Verbose output (request logs, swarm details)', false)
  .description('Join+replicate and serve via WebDAV')
  .action(async (keyHex, opts) => {
    const spin = ora('Starting server…').start()
    try {
      const { url } = await serveWebDAV(keyHex, Number(opts.port), opts.storage, opts.host, !!opts['readOnly'], { verbose: !!opts.verbose })
      spin.succeed('✓ Running')
      console.log('  URL   :', chalk.cyan(url))
      console.log('  Finder:', chalk.gray('Go → Connect to Server →'), chalk.cyan(url))
    } catch (e) {
      spin.fail('✗ Failed to start'); console.error('Error:', e)
      process.exit(1)
    }
  })

program.parseAsync()
