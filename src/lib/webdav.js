// src/lib/webdav.js
import http from 'node:http'
import { URL } from 'node:url'
import path from 'node:path'

// ---------- config ----------
const ALLOW = 'OPTIONS,PROPFIND,GET,HEAD,PUT,DELETE,MKCOL,MOVE,LOCK,UNLOCK,PROPPATCH'
const MAX_INLINE_PUT = 16 * 1024 * 1024 // 16 MiB inline PUT limit

// ---------- helpers ----------
const esc = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const httpDate = (ms) => new Date(ms).toUTCString()
const isDirStat = (st) => st?.isDirectory || st?.mode === 0o040000 || st?.isDirectory?.()

function urlPathToKey (hrefPath) {
  if (!hrefPath.startsWith('/dav')) return null
  let sub = hrefPath.slice('/dav'.length) || '/'
  if (!sub.startsWith('/')) sub = '/' + sub
  if (sub === '/' || sub === '') return '' // root
  return sub.slice(1)
}
function keyToHref (key, baseHref, isDir) {
  const ensureSlash = s => (s.endsWith('/') ? s : s + '/')
  if (!key) return ensureSlash(baseHref)
  const name = encodeURIComponent(key.split('/').pop() || '')
  return (ensureSlash(baseHref) + name + (isDir ? '/' : '')).replace(/\/{2,}/g, '/')
}
function mimeFromPath (k) {
  const ext = path.posix.extname(k).toLowerCase()
  switch (ext) {
    case '.txt': return 'text/plain; charset=utf-8'
    case '.md': return 'text/markdown; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.html': case '.htm': return 'text/html; charset=utf-8'
    case '.csv': return 'text/csv; charset=utf-8'
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.pdf': return 'application/pdf'
    case '.mp4': return 'video/mp4'
    case '.mp3': return 'audio/mpeg'
    default: return 'application/octet-stream'
  }
}
// Parse Range: "bytes=start-end"
function parseRange (rangeHeader, size) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null
  const [startStr, endStr] = rangeHeader.slice(6).split('-', 2)
  let start = startStr ? parseInt(startStr, 10) : NaN
  let end = endStr ? parseInt(endStr, 10) : NaN
  if (Number.isNaN(start)) { // suffix bytes
    const n = end
    if (Number.isNaN(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start < 0) return null
  }
  return { start, end }
}

// ---------- drive compatibility ----------
async function statCompat (drive, key) {
  try { return await drive.stat(key) } catch {}
  try { return await drive.stat('/' + key) } catch {}
  return null
}
async function delCompat (drive, key) {
  try { await drive.del(key); return true } catch {}
  try { await drive.del('/' + key); return true } catch {}
  return false
}
async function pickKeyVariant (drive, key) {
  try { await drive.get(key, { wait: true }); return key } catch {}
  try { await drive.get('/' + key, { wait: true }); return '/' + key } catch {}
  return null
}

// ---------- size cache & helpers ----------
const SIZE_CACHE = new Map() // 'key' or '/key' -> number
async function streamCountSize (drive, key) {
  return new Promise((resolve, reject) => {
    let total = 0
    const rs = drive.createReadStream(key, { wait: true })
    rs.on('data', c => { total += c.length })
    rs.on('error', reject)
    rs.on('end', () => resolve(total))
  })
}
async function resolveKeyAndSize (drive, key0) {
  if (SIZE_CACHE.has(key0)) return { keyVariant: key0, size: SIZE_CACHE.get(key0) }
  if (SIZE_CACHE.has('/' + key0)) return { keyVariant: '/' + key0, size: SIZE_CACHE.get('/' + key0) }

  const stA = await statCompat(drive, key0)
  if (stA && typeof stA.size === 'number') { SIZE_CACHE.set(key0, stA.size); return { keyVariant: key0, size: stA.size } }
  const stB = await statCompat(drive, '/' + key0)
  if (stB && typeof stB.size === 'number') { SIZE_CACHE.set('/' + key0, stB.size); return { keyVariant: '/' + key0, size: stB.size } }

  // Fallback: stream count
  try { const sz = await streamCountSize(drive, key0); SIZE_CACHE.set(key0, sz); return { keyVariant: key0, size: sz } } catch {}
  try { const sz = await streamCountSize(drive, '/' + key0); SIZE_CACHE.set('/' + key0, sz); return { keyVariant: '/' + key0, size: sz } } catch {}
  return null
}

// ---------- PROPFIND ----------
async function propfindXML (drive, href, depth) {
  const baseHref = href.endsWith('/') ? href : href + '/'
  const selfKey = urlPathToKey(href)
  async function isDirKey (k) {
    if (k === '' || k === null) return true
    const st = await statCompat(drive, k)
    return !!isDirStat(st)
  }
  async function sizeForKey (k) {
    if (k == null) return 0
    const r = await resolveKeyAndSize(drive, k)
    return r ? r.size : 0
  }

  const responses = []
  // self
  {
    const isDir = await isDirKey(selfKey)
    const sz = isDir ? 0 : await sizeForKey(selfKey)
    responses.push({
      href: keyToHref(selfKey || '', baseHref, isDir),
      isDir, contentLength: sz,
      lastmod: httpDate(Date.now()),
      display: decodeURIComponent((selfKey || 'dav').split('/').pop() || 'dav')
    })
  }
  // children
  if (depth > 0 && await isDirKey(selfKey)) {
    const seen = new Set()
    const add = async (raw) => {
      const k = raw.startsWith('/') ? raw.slice(1) : raw
      if (seen.has(k)) return
      seen.add(k)
      const dir = await isDirKey(k)
      const len = dir ? 0 : await sizeForKey(k)
      responses.push({
        href: keyToHref(k, baseHref, dir),
        isDir: dir, contentLength: len,
        lastmod: httpDate(Date.now()),
        display: k.split('/').pop() || ''
      })
    }
    try { for await (const e of drive.list(selfKey || '')) await add(e.key) } catch {}
    try { const pref = selfKey ? '/' + selfKey : '/'; for await (const e of drive.list(pref)) await add(e.key) } catch {}
  }

  const items = responses.map(r => `
      <d:response>
        <d:href>${esc(r.href)}</d:href>
        <d:propstat>
          <d:prop>
            <d:resourcetype>${r.isDir ? '<d:collection/>' : ''}</d:resourcetype>
            <d:getcontentlength>${r.contentLength}</d:getcontentlength>
            <d:getlastmodified>${r.lastmod}</d:getlastmodified>
            <d:displayname>${esc(r.display)}</d:displayname>
          </d:prop>
          <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
      </d:response>
  `).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n${items}\n</d:multistatus>`
}

// ---------- request handler ----------
function makeHandler (drive, allowWrites, { verbose = false } = {}) {
  const bootTs = Date.now() // first 3s → Connection: close (avoid stale keep-alives)

  return async function handle (req, res) {
    const method = req.method || 'GET'
    const url = new URL(req.url, `http://${req.headers.host}`)
    res.setHeader('DAV', '1,2')
    res.setHeader('MS-Author-Via', 'DAV')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Expose-Headers', 'DAV, content-length, Allow')
    if (Date.now() - bootTs < 3000) res.setHeader('Connection', 'close')

    if (verbose) console.log(`[${new Date().toISOString()}] ${method} ${url.pathname}`)
    res.on('finish', () => {
      if (!verbose) return
      const len = res.getHeader('Content-Length')
      console.log(`  -> status ${res.statusCode}${len ? `, length ${len}` : ''}`)
    })

    if (!url.pathname.startsWith('/dav')) {
      if (method === 'OPTIONS') { res.statusCode = 200; res.setHeader('Allow', ALLOW); return res.end() }
      res.statusCode = 404; return res.end()
    }

    if (method === 'OPTIONS') { res.statusCode = 200; res.setHeader('Allow', ALLOW); return res.end() }

    // PROPFIND
    if (method === 'PROPFIND') {
      const depthHeader = (req.headers['depth'] || '0').toString()
      const depth = depthHeader === '0' ? 0 : 1
      const xml = await propfindXML(drive, url.pathname.endsWith('/') ? url.pathname : url.pathname + '/', depth)
      res.statusCode = 207
      res.setHeader('Content-Type', 'application/xml; charset="utf-8"')
      res.setHeader('Content-Length', Buffer.byteLength(xml))
      return res.end(xml)
    }

    // GET/HEAD — streaming + single/multi-range
    if (method === 'GET' || method === 'HEAD') {
      const key0 = urlPathToKey(url.pathname)
      if (key0 === null) { res.statusCode = 404; return res.end() }
      if (key0.startsWith('._')) { res.statusCode = 404; return res.end() }

      const resolved = await resolveKeyAndSize(drive, key0)
      let keyVariant = resolved?.keyVariant
      let knownSize = resolved?.size
      if (!keyVariant) keyVariant = (await pickKeyVariant(drive, key0)) || key0

      // existence probe (also OK for empty files)
      try {
        const test = drive.createReadStream(keyVariant, { start: 0, end: 0, wait: true })
        await new Promise((resolve, reject) => {
          let settled = false
          test.once('data', () => { if (!settled) { settled = true; resolve() } })
          test.once('end', () => { if (!settled) { settled = true; resolve() } })
          test.once('error', (e) => { if (!settled) { settled = true; reject(e) } })
        })
        test.destroy()
      } catch { res.statusCode = 404; return res.end() }

      const ctype = mimeFromPath(key0)
      res.setHeader('Content-Type', ctype)
      res.setHeader('Accept-Ranges', 'bytes')

      const rangeHeader = (req.headers['range'] || '').toString()
      const wantsRange = rangeHeader.startsWith('bytes=')

      if (!wantsRange || typeof knownSize !== 'number') {
        if (typeof knownSize === 'number') res.setHeader('Content-Length', String(knownSize))
        res.statusCode = 200
        if (method === 'HEAD') return res.end()
        const rs = drive.createReadStream(keyVariant, { wait: true })
        rs.on('error', () => { if (!res.headersSent) res.statusCode = 404; res.end() })
        return rs.pipe(res)
      }

      // parse ranges
      const rawSpecs = rangeHeader.slice(6).split(',').map(s => s.trim()).filter(Boolean)
      const ranges = []
      for (const spec of rawSpecs) {
        const r = parseRange('bytes=' + spec, knownSize)
        if (r) ranges.push(r)
      }
      if (!ranges.length) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${knownSize}`); return res.end() }

      if (ranges.length === 1) {
        const { start, end } = ranges[0]
        const len = end - start + 1
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${knownSize}`)
        res.setHeader('Content-Length', String(len))
        if (method === 'HEAD') return res.end()
        const rs = drive.createReadStream(keyVariant, { start, end, wait: true })
        rs.on('error', () => { if (!res.headersSent) res.statusCode = 404; res.end() })
        return rs.pipe(res)
      }

      // multi-range (multipart/byteranges)
      const boundary = 'p2pdrive-' + Math.random().toString(16).slice(2)
      res.statusCode = 206
      res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`)
      if (method === 'HEAD') return res.end()

      const write = (chunk) => new Promise((resolve, reject) => {
        const ok = res.write(chunk)
        if (ok) return resolve()
        res.once('drain', resolve)
        res.once('error', reject)
      })

      for (const { start, end } of ranges) {
        await write(Buffer.from(`\r\n--${boundary}\r\n` +
            `Content-Type: ${ctype}\r\n` +
            `Content-Range: bytes ${start}-${end}/${knownSize}\r\n\r\n`))
        await new Promise((resolve, reject) => {
          const rs = drive.createReadStream(keyVariant, { start, end, wait: true })
          rs.on('error', reject)
          rs.on('end', resolve)
          rs.pipe(res, { end: false })
        })
      }
      await write(Buffer.from(`\r\n--${boundary}--\r\n`))
      return res.end()
    }

    // write-protection
    if (!allowWrites && ['PUT','DELETE','MKCOL','MOVE','LOCK','UNLOCK','PROPPATCH'].includes(method)) {
      res.statusCode = 403; return res.end()
    }

    // LOCK/UNLOCK/PROPPATCH (no-op)
    if (method === 'LOCK') {
      const token = 'urn:uuid:' + Math.random().toString(16).slice(2) + Date.now().toString(16)
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken>
</D:activelock></D:lockdiscovery></D:prop>`
      res.statusCode = 200
      res.setHeader('Lock-Token', `<${token}>`)
      res.setHeader('Content-Type', 'application/xml; charset="utf-8"')
      res.setHeader('Content-Length', Buffer.byteLength(xml))
      return res.end(xml)
    }
    if (method === 'UNLOCK') { res.statusCode = 204; return res.end() }
    if (method === 'PROPPATCH') {
      const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`
      res.statusCode = 207
      res.setHeader('Content-Type', 'application/xml; charset="utf-8"')
      res.setHeader('Content-Length', Buffer.byteLength(xml))
      return res.end(xml)
    }

    // PUT — small files inline; big => 413 advise CLI
    if (method === 'PUT') {
      const key0 = urlPathToKey(url.pathname)
      if (key0 === null) { res.statusCode = 404; return res.end() }
      if (!allowWrites || !drive.writable) { res.statusCode = 403; return res.end() }

      const lenHdr = req.headers['content-length']
      const contentLength = lenHdr ? parseInt(String(lenHdr), 10) : NaN
      if (!Number.isNaN(contentLength) && contentLength > MAX_INLINE_PUT) {
        res.statusCode = 413
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        return res.end(`File too large for inline WebDAV upload.\nUse CLI:\n  p2pdrive put <key> <src> /${key0}\n`)
      }

      const body = await new Promise((resolve, reject) => {
        const chunks = []
        let total = 0
        req.on('data', c => { total += c.length; if (total > MAX_INLINE_PUT) { reject(new Error('too big')) } else chunks.push(c) })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      }).catch(err => { res.statusCode = err?.message === 'too big' ? 413 : 500; return null })
      if (!body) return res.end()

      let wrote = false
      for (const k of [key0, '/' + key0]) {
        try {
          if (typeof drive.put === 'function')       { await drive.put(k, body); wrote = true; break }
          else if (typeof drive.writeFile === 'function') { await drive.writeFile(k, body); wrote = true; break }
          else if (typeof drive.set === 'function')  { await drive.set(k, body); wrote = true; break }
          else if (typeof drive.createWriteStream === 'function') {
            await new Promise((resolve, reject) => {
              const ws = drive.createWriteStream(k)
              ws.on('error', reject); ws.on('finish', resolve); ws.end(body)
            })
            wrote = true; break
          }
        } catch (e) { if (verbose) console.error('[PUT try]', k, e?.stack || e) }
      }
      if (!wrote) { res.statusCode = 500; return res.end('No supported write API on drive') }

      SIZE_CACHE.set(key0, body.length); SIZE_CACHE.set('/' + key0, body.length)
      res.statusCode = 201
      return res.end()
    }

    // DELETE/MKCOL/MOVE
    if (method === 'DELETE') {
      const key0 = urlPathToKey(url.pathname)
      if (key0 === null) { res.statusCode = 404; return res.end() }
      await delCompat(drive, key0)
      SIZE_CACHE.delete(key0); SIZE_CACHE.delete('/' + key0)
      res.statusCode = 204; return res.end()
    }
    if (method === 'MKCOL') { res.statusCode = 201; return res.end() }
    if (method === 'MOVE') {
      const srcKey0 = urlPathToKey(url.pathname)
      const destHeader = req.headers['destination']
      let dstKey0 = null
      if (destHeader) { try { dstKey0 = urlPathToKey(new URL(destHeader).pathname) } catch { dstKey0 = urlPathToKey(destHeader) } }
      if (srcKey0 === null || dstKey0 === null) { res.statusCode = 400; return res.end() }

      const srcVariant = (await pickKeyVariant(drive, srcKey0)) || srcKey0
      const chunks = []
      await new Promise((resolve, reject) => {
        const rs = drive.createReadStream(srcVariant, { wait: true })
        rs.on('data', c => chunks.push(c))
        rs.on('error', reject)
        rs.on('end', resolve)
      }).catch(() => {})
      const buf = Buffer.concat(chunks)
      let moved = false
      for (const k of [dstKey0, '/' + dstKey0]) {
        try {
          if (typeof drive.put === 'function')       { await drive.put(k, buf); moved = true; break }
          else if (typeof drive.writeFile === 'function') { await drive.writeFile(k, buf); moved = true; break }
          else if (typeof drive.set === 'function')  { await drive.set(k, buf); moved = true; break }
          else if (typeof drive.createWriteStream === 'function') {
            await new Promise((resolve, reject) => {
              const ws = drive.createWriteStream(k)
              ws.on('error', reject); ws.on('finish', resolve); ws.end(buf)
            })
            moved = true; break
          }
        } catch {}
      }
      if (moved) {
        await delCompat(drive, srcKey0)
        SIZE_CACHE.set(dstKey0, buf.length); SIZE_CACHE.set('/' + dstKey0, buf.length)
        SIZE_CACHE.delete(srcKey0); SIZE_CACHE.delete('/' + srcKey0)
        res.statusCode = 201; return res.end()
      } else { res.statusCode = 500; return res.end() }
    }

    // Fallback
    res.statusCode = 405
    res.setHeader('Allow', ALLOW)
    res.end()
  }
}

// ---------- bootstrap (no signal handlers here) ----------
export async function startDav (drive, { host = '127.0.0.1', port = 4919, readOnly = false, verbose = false } = {}) {
  const allowWrites = drive.writable && !readOnly
  const handler = makeHandler(drive, allowWrites, { verbose })

  const server = http.createServer()
  server.keepAliveTimeout = 2000
  server.headersTimeout = 5000
  server.on('request', handler)
  server.on('checkContinue', (req, res) => { res.writeContinue(); handler(req, res) })

  const sockets = new Set()
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

  await new Promise(res => server.listen(port, host, res))
  if (verbose) console.log(`WebDAV listening on http://${host}:${port}/dav/ (writable: ${allowWrites})`)
  else console.log(`WebDAV ready at http://${host}:${port}/dav/`)

  async function close () {
    // close HTTP server and destroy sockets
    await new Promise(resolve => server.close(resolve))
    for (const s of sockets) { try { s.destroy() } catch {} }
  }

  return { server, close }
}
