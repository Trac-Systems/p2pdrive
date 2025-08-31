# p2pdrive

> **Disclaimer:** p2pdrive is partially “vibe-coded” (most WebDAV code, logs and this readme).

A tiny CLI for p2p file sharing that shares a Hyperdrive key over the Hyperswarm DHT and bridges it to a local **WebDAV** endpoint so you can browse it in Finder (macOS) or any WebDAV client.

- No daemon; single command per role.
- Owner (writer) and peers (read-only) both use the same CLI: `serve` does **replication + WebDAV**.
- Uses a minimal, built-in WebDAV handler (no external WebDAV server dependency).

## Install

```bash
npm install
npm i -g .
```

## Quickstart

### Owner (has writer key)
```bash
# 1) Create drive
p2pdrive init -s ./store

# 2) Share + WebDAV on port 4918 (this both "seeds" and "serves")
p2pdrive serve <keyHex> -s ./store --host 0.0.0.0 --port 4918
# expected banner: (writable: true)
```

Upload a test file (on owner):
```bash
curl -H 'Expect:' -T ./hello.txt http://127.0.0.1:4918/dav/hello.txt
```

### Peer (read-only replica + local WebDAV)
```bash
p2pdrive serve <keyHex> -s ./mirror --host 127.0.0.1 --port 4919 --read-only
```

Mount in Finder:
```
http://127.0.0.1:4919/dav/
```

> Tip: use the `--verbose` flag to show request logs and more details.

## CLI

```
p2pdrive init [-s DIR]
p2pdrive seed [-s DIR] [--verbose]
p2pdrive serve <keyHex> [-s DIR] [-H HOST] [-p PORT] [--read-only] [--verbose]
p2pdrive put <keyHex> <src> <dst> [-s DIR]
p2pdrive get <keyHex> <src> <dst> [-s DIR]
p2pdrive ls  <keyHex> [dir]       [-s DIR]
```

- All commands use the **same subfolder**: `DIR/drive-local` (no more folder-name surprises).
- **Single process per store**: Don’t run `seed` and `serve` simultaneously against the same `-s` path (Corestore lock).
- `serve` already joins the DHT (so you generally don’t need to run `seed`).

## Windows

Windows Explorer’s built-in WebDAV client can be picky (auth & registry). For best results use a WebDAV client like **Cyberduck** or **RaiDrive** and point it at `http://127.0.0.1:PORT/dav/`.

## Troubleshooting

- `ELOCKED`: You’re running two processes on the same store dir. Stop the other one or use a different `-s` path.
- Finder says “problem connecting”: make sure the URL ends with `/dav/`. Try `--verbose` to view request logs.
- `curl -T` hangs: add `-H 'Expect:'` or use this build (it handles `Expect: 100-continue`).
- Peers can’t upload: expected. Only the owner (writable drive) can PUT. Run peer with `--read-only`.

---

MIT-ish for demo purposes.
