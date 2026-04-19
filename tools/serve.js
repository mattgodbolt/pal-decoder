#!/usr/bin/env node
// Tiny static file server for local development. No npm deps.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const port = Number(process.argv[2] ?? 8080)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
}

// Resolve a request URL to a path inside `root`, or null if it escapes.
function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const joined = normalize(join(root, decoded))
  if (joined !== root && !joined.startsWith(root + sep)) return null
  return joined
}

const server = createServer(async (req, res) => {
  try {
    let path = safeJoin(req.url === '/' ? '/index.html' : req.url)
    if (!path) { res.writeHead(403); res.end('forbidden'); return }

    let s
    try { s = await stat(path) } catch { res.writeHead(404); res.end('not found'); return }
    if (s.isDirectory()) path = join(path, 'index.html')

    const body = await readFile(path)
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500)
    res.end(String(err))
  }
})

server.listen(port, () => {
  console.log(`pal-decoder dev server: http://localhost:${port}/`)
})
