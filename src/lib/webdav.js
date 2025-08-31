// Minimal WebDAV server tailored for Finder (no external webdav lib).
// Serves Hyperdrive at /dav and supports OPTIONS, PROPFIND, GET, HEAD,
// PUT, DELETE, MKCOL, MOVE. Directories are virtual in Hyperdrive.

import http from 'node:http'
import { URL } from 'node:url'

// -------- helpers --------
function esc (s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
}
function httpDate (ms) {
  return new Date(ms).toUTCString()
}
function isCollection (st) {
  return st?.isDirectory || st?.mode === 0o040000 || st?.isDirectory?.()
}
async function statOrNull (drive, p) {
  try { return await drive.stat(p) } catch { return null }
}
function hrefToDrivePath (hrefPath) {
  try {
    if (!hrefPath.startsWith('/dav')) return null
    const sub = hrefPath.slice('/dav'.length) || '/'
    return sub.startsWith('/') ? sub : `/${sub}`
  } catch { return null }
}
async function propfindXML (drive, href, depth) {
  const baseHref = href.endsWith('/') ? href : href + '/'
  const selfPath = hrefToDrivePath(href)
  const responses = []

  // self
  {
    const st = await statOrNull(drive, selfPath)
    const isDir = selfPath === '/' ? true : isCollection(st)
    responses.push({
      href: baseHref,
      isDir,
      contentLength: st?.size || 0,
      lastmod: st?.mtime ? new Date(st.mtime).toUTCString() : httpDate(Date.now()),
      display: decodeURIComponent(baseHref.split('/').filter(Boolean).pop() || 'dav')
    })
  }
  // children
  const selfStat = selfPath === '/' ? { isDirectory: true } : await statOrNull(drive, selfPath)
  if (depth > 0 && isCollection(selfStat)) {
    for await (const e of drive.list(selfPath)) {
      const name = e.key.split('/').pop() || ''
      const st = await statOrNull(drive, e.key)
      const isDir = isCollection(st)
      responses.push({
        href: (baseHref + encodeURIComponent(name) + (isDir ? '/' : '')).replace(/\/{2,}/g, '/'),
        isDir,
        contentLength: st?.size || 0,
        lastmod: st?.mtime ? new Date(st.mtime).toUTCString() : httpDate(Date.now()),
        display: name
      })
    }
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

  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<d:multistatus xmlns:d="DAV:">`,
    items,
    `</d:multistatus>`
  ].join('\n')
  return xml
}

// main handler
function makeHandler (drive, allowWrites, { verbose = false } = {}) {
  return async function handle (req, res) {
    const method = req.method || 'GET'
    const url = new URL(req.url, `http://${req.headers.host}`)

    // Common DAV/CORS headers
    res.setHeader('DAV', '1,2')
    res.setHeader('MS-Author-Via', 'DAV')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Expose-Headers', 'DAV, content-length, Allow')

    if (verbose) console.log(`[${new Date().toISOString()}] ${method} ${url.pathname}`)

    // Non-/dav requests: answer OPTIONS or 404
    if (!url.pathname.startsWith('/dav')) {
      if (method === 'OPTIONS') {
        res.statusCode = 200
        res.setHeader('Allow', 'OPTIONS,PROPFIND,GET,HEAD,PUT,DELETE,MKCOL,MOVE')
        return res.end()
      }
      res.statusCode = 404
      return res.end()
    }

    // Body reader
    const readBody = () => new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

    // OPTIONS
    if (method === 'OPTIONS') {
      res.statusCode = 200
      res.setHeader('Allow', 'OPTIONS,PROPFIND,GET,HEAD,PUT,DELETE,MKCOL,MOVE')
      return res.end()
    }

    // PROPFIND
    if (method === 'PROPFIND') {
      const depthHeader = (req.headers['depth'] || '0').toString()
      const depth = depthHeader === '1' ? 1 : 0
      const xml = await propfindXML(drive, url.pathname.endsWith('/') ? url.pathname : url.pathname + '/', depth)
      res.statusCode = 207
      res.setHeader('Content-Type', 'application/xml; charset="utf-8"')
      res.setHeader('Content-Length', Buffer.byteLength(xml))
      return res.end(xml)
    }

    // GET / HEAD
    if (method === 'GET' || method === 'HEAD') {
      const p = hrefToDrivePath(url.pathname)
      if (!p) { res.statusCode = 404; return res.end() }
      const data = await drive.get(p, { wait: true }).catch(() => null)
      if (!data) { res.statusCode = 404; return res.end() }
      res.statusCode = 200
      res.setHeader('Content-Length', data.length)
      if (method === 'HEAD') return res.end()
      return res.end(data)
    }

    // Reject writes if not allowed (peer or --read-only)
    if (!allowWrites && ['PUT','DELETE','MKCOL','MOVE'].includes(method)) {
      res.statusCode = 403
      return res.end()
    }

    // PUT
    if (method === 'PUT') {
      const p = hrefToDrivePath(url.pathname)
      if (!p) { res.statusCode = 404; return res.end() }
      const body = await readBody()
      await drive.put(p, body)
      res.statusCode = 201
      return res.end()
    }

    // DELETE
    if (method === 'DELETE') {
      const p = hrefToDrivePath(url.pathname)
      if (!p) { res.statusCode = 404; return res.end() }
      await drive.del(p).catch(() => {})
      res.statusCode = 204
      return res.end()
    }

    // MKCOL (ack only; dirs are virtual)
    if (method === 'MKCOL') {
      const p = hrefToDrivePath(url.pathname)
      if (!p) { res.statusCode = 404; return res.end() }
      res.statusCode = 201
      return res.end()
    }

    // MOVE (rename)
    if (method === 'MOVE') {
      const src = hrefToDrivePath(url.pathname)
      const destHeader = req.headers['destination']
      let dst = null
      if (destHeader) {
        try { dst = hrefToDrivePath(new URL(destHeader).pathname) } catch { dst = hrefToDrivePath(destHeader) }
      }
      if (!src || !dst) { res.statusCode = 400; return res.end() }
      const data = await drive.get(src, { wait: true }).catch(() => null)
      if (!data) { res.statusCode = 404; return res.end() }
      await drive.put(dst, data)
      await drive.del(src).catch(() => {})
      res.statusCode = 201
      return res.end()
    }

    // Fallback
    res.statusCode = 405
    res.setHeader('Allow', 'OPTIONS,PROPFIND,GET,HEAD,PUT,DELETE,MKCOL,MOVE')
    res.end()
  }
}

export async function startDav (drive, { host = '127.0.0.1', port = 4919, readOnly = false, verbose = false } = {}) {
  // allow writes only if this Hyperdrive session is writable and --read-only is not set
  const allowWrites = drive.writable && !readOnly
  const handler = makeHandler(drive, allowWrites, { verbose })

  // Create HTTP server to attach 'request' and 'checkContinue'
  const server = http.createServer()
  server.on('request', handler)

  // Handle Expect: 100-continue for PUT (curl -T sends this often)
  server.on('checkContinue', (req, res) => {
    res.writeContinue()
    handler(req, res)
  })

  await new Promise(res => server.listen(port, host, res))
  if (verbose) console.log(`WebDAV listening on http://${host}:${port}/dav/ (writable: ${allowWrites})`)
  else console.log(`WebDAV ready at http://${host}:${port}/dav/`)
  return server
}
