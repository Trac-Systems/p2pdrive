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

program
    .command('serve <keyHex>')
    .option('-s, --storage <dir>')
    .option('-H, --host <host>', '0.0.0.0', '0.0.0.0')
    .option('-p, --port <port>', '4918')
    .option('--read-only', false)
    .option('--verbose', false)
    .action(async (keyHex, opts) => {
        let cleanup = null
        try {
            cleanup = await serveWebDAV(keyHex, {
                storage: opts.storage,
                host: opts.host || '0.0.0.0',
                port: parseInt(opts.port, 10) || 4918,
                readOnly: !!opts.readOnly,
                verbose: !!opts.verbose
            })
            console.log('✔ Running')
            console.log('  URL   : http://' + (opts.host || '0.0.0.0') + ':' + (opts.port || 4918) + '/dav/')
            console.log('  Connect to Server → http://' + (opts.host || '0.0.0.0') + ':' + (opts.port || 4918) + '/dav/')
        } catch (err) {
            console.error('Failed to serve:', err?.stack || err)
            process.exit(1)
        }

        const onSignal = async (sig) => {
            console.log(`\nShutting down (${sig})...`)
            try { await cleanup?.() } catch {}
            process.exit(0)
        }
        process.once('SIGINT',  () => { onSignal('SIGINT') })
        process.once('SIGTERM', () => { onSignal('SIGTERM') })
    })

program.parseAsync()
