# p2pdrive

> **Disclaimer:** p2pdrive is partially “vibe‑coded” (most of webDAV, console logs and this readme). Code is reviewed and tested (Mac).

Decentralized (p2p) drives to share files.

The owner of a drive can add, remove, edit files.

Peers may read/download. If you just want to download and support sharing, follow the Peers instructions below.

Provides a simple CLI that shares a Hyperdrive key over the Hyperswarm DHT and bridges it to a local **WebDAV** endpoint so you can browse it in Finder (macOS), Windows Explorer, or any WebDAV client.

- No daemon; single command per role.
- Owner (writer) and peers (read-only) both use the same CLI: `serve` does **replication + WebDAV**.
- Minimal built-in WebDAV handler (no external WebDAV server dependency).

---

## Install

```bash
# Clone the repo
git clone git@github.com:Trac-Systems/p2pdrive.git
cd p2pdrive

# Install dependencies
npm install

# Link the CLI globally (so you can run `p2pdrive` from anywhere)
npm link
```

---

## Quickstart

Make sure curl is available. Windows users download curl from here: https://curl.se/windows/

### Owner (has writer key)

```bash
# 1) Create drive (writes secrets into ./store/drive-local/)
# reveals/generates the (public) key to be used for serve below
p2pdrive init -s ./store

# 2) Share + WebDAV on port 4918 (this both "seeds" and "serves")
# use the key from init above and replace it with <keyHex>
p2pdrive serve <keyHex> -s ./store --host 0.0.0.0 --port 4918
# expected banner should imply: (writable: true)
```

Mounting see below (Mounting WebDAV).

Add file in mounted "dav" folder or upload a test file (owner side):
```bash
# Using the CLI (does not require the WebDAV server to be running)
p2pdrive put <keyHex> ./hello.txt /hello.txt -s ./store
```

### Peer (read-only replica + local WebDAV)

```bash
# Different storage dir than the owner to avoid Corestore lock
# use the key from init above and replace it with <keyHex>
p2pdrive serve <keyHex> -s ./mirror --host 127.0.0.1 --port 4919 --read-only
```

Mounting see below (Mounting WebDAV).

> Tip: add `--verbose` for request logs and swarm details.

---

## CLI

```
p2pdrive init [-s DIR]
p2pdrive seed [-s DIR] [--verbose]
p2pdrive serve <keyHex> [-s DIR] [-H HOST] [-p PORT] [--read-only] [--verbose]
p2pdrive put <keyHex> <src> <dst> [-s DIR]
p2pdrive get <keyHex> <src> <dst> [-s DIR]
p2pdrive ls  <keyHex> [dir]       [-s DIR]
```

- All commands use the **same subfolder**: `DIR/drive-local`.
- **Single process per store**: Don’t run `seed` and `serve` at the same time against the same `-s DIR` (Corestore lock).
- `serve` already joins the DHT (so you generally don’t need to run `seed`).

---

## Mounting WebDAV

Ports may vary by your choice or setup as of above. E.g. 4918 or 4919.

### macOS (Finder)

1. Open Finder → Go → Connect to Server
2. Enter: `http://127.0.0.1:4918/dav/`
3. Authenticate if prompted (this POC usually accepts anonymous)
4. Your drive appears as a network folder.

### Windows

#### Option 1: Explorer (built-in)

1. Open File Explorer
2. Right-click **This PC** → **Map Network Drive…**
3. Choose a drive letter
4. In folder, enter: `http://127.0.0.1:4918/dav/`
5. If asked for credentials, leave blank or use anything (POC doesn’t check)

> ⚠️ Windows native client can be unreliable. If it fails, use Cyberduck or RaiDrive.

#### Option 2: Cyberduck

- Download Cyberduck, choose **Open Connection → WebDAV (HTTP)**
- Enter: `http://127.0.0.1:4918/dav/`

#### Option 3: RaiDrive

- Download RaiDrive, **Add → WebDAV**
- Enter `http://127.0.0.1:4918/dav/` and assign a drive letter.

### Linux

#### Nautilus (GNOME)

1. Open Files app
2. Press `Ctrl+L`, type:
   ```
   dav://127.0.0.1:4918/dav/
   ```
3. Press Enter

#### Dolphin (KDE)

1. Open Dolphin
2. In location bar, type:
   ```
   webdav://127.0.0.1:4918/dav/
   ```
3. Press Enter

#### CLI (davfs2)

```bash
sudo apt install davfs2
sudo mkdir /mnt/p2pdrive
sudo mount -t davfs http://127.0.0.1:4918/dav/ /mnt/p2pdrive
```

---

## Debugging with curl

Talk directly to the WebDAV endpoint (owner: `4918`, peer: `4919`). Make sure you include `/dav/` in the path.

- **List root folder**:
  ```bash
  curl -v -X PROPFIND http://127.0.0.1:4918/dav/ -H "Depth: 1"
  ```

- **Download a file**:
  ```bash
  curl -O http://127.0.0.1:4918/dav/hello.txt
  ```

- **Upload a file (owner only, writable)**:
  ```bash
  curl -H 'Expect:' -T ./hello.txt http://127.0.0.1:4918/dav/hello.txt
  ```

- **Delete a file (owner only, writable)**:
  ```bash
  curl -X DELETE http://127.0.0.1:4918/dav/hello.txt
  ```

- **Rename/move a file**:
  ```bash
  curl -X MOVE http://127.0.0.1:4918/dav/hello.txt -H "Destination: http://127.0.0.1:4918/dav/hello-renamed.txt"
  ```

If you see `403 Forbidden`, you’re using a **read-only** drive.  
If you see `404 Not Found`, verify the path and that you’re hitting `/dav/`.

---

## Notes on writability & roles

- **Owner**: created the drive with `init`. Has writer key → can PUT/DELETE/MOVE.
- **Peer**: joined via public key only. Read-only, cannot modify.

---

## Troubleshooting

- **ELOCKED**: Two processes opened the same store dir. Stop one, or use different `-s` dirs. If a process crashed, remove lock after ensuring nothing runs:
  ```bash
  rm -f ./store/drive-local/primary-key.lock
  ```

- **Finder “problem connecting”**: Ensure the URL ends with `/dav/`. Try `--verbose` to confirm requests.

- **`curl -T` hangs**: Add `-H 'Expect:'` to disable 100-continue wait.

- **Can’t upload from peer**: Only owner (writer) can upload.

- **Nothing shows up on peer**: Ensure both `serve` processes use the **same key** and owner is running.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
