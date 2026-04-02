#!/usr/bin/env node
'use strict';

const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const url          = require('url');
const { spawn }    = require('child_process');

const PORT      = process.env.PORT || 4000;
const ROOT      = __dirname;
const TOOLS_DIR = path.join(ROOT, 'tools');

// ── MIME types ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map':  'application/json',
};

// ── Allowed scripts & playlist directories ───────────────────────
const ALLOWED_SCRIPTS = new Set([
  'fetch-fairyanime.js',
  'fetch-indy-anime.js',
  'fetch-kurokamii.js',
]);

const PLAYLIST_DIRS = {
  'anime-series': 'playlist/anime/series',
  'anime-movie':  'playlist/anime/movies',
  'movie':        'playlist/movies',
  'series':       'playlist/series',
};

// ── Helpers ──────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data',  chunk => body += chunk);
    req.on('end',   ()    => resolve(body));
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(parsed.pathname);

  // ── POST /api/run-fetch ────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/run-fetch') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad JSON');
      return;
    }

    const { script, args = [] } = body;

    if (!ALLOWED_SCRIPTS.has(script)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Script not allowed');
      return;
    }

    res.writeHead(200, {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache',
      'X-Accel-Buffering': 'no',
    });

    const send = obj => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    const proc = spawn('node', [script, ...args], {
      cwd: TOOLS_DIR,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', chunk => send({ t: 'out', v: chunk.toString() }));
    proc.stderr.on('data', chunk => send({ t: 'err', v: chunk.toString() }));
    proc.on('close',  code => { send({ t: 'done', code }); res.end(); });
    proc.on('error',  err  => {
      send({ t: 'err',  v: `\nProcess error: ${err.message}\n` });
      send({ t: 'done', code: 1 });
      res.end();
    });
    req.on('close', () => { try { proc.kill(); } catch {} });
    return;
  }

  // ── POST /api/save-file ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/save-file') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad JSON');
      return;
    }

    const { filePath, data } = body;

    // Only allow writes inside playlist/
    if (typeof filePath !== 'string' || !/^playlist\//.test(filePath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const fullPath = path.join(ROOT, filePath);
    if (!fullPath.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.writeFile(fullPath, JSON.stringify(data, null, 4), err => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // ── GET /api/playlist-files?tab=... ───────────────────────────
  if (req.method === 'GET' && pathname === '/api/playlist-files') {
    const tabKey = parsed.searchParams.get('tab') || '';
    const dir    = PLAYLIST_DIRS[tabKey];
    if (!dir) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const dirPath   = path.join(ROOT, dir);
    const indexPath = path.join(dirPath, 'index.txt');

    // Build slug → title map from index.txt
    let nameMap = {};
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      (indexData.groups || []).forEach(g => {
        if (g.url && g.name) {
          const fname = g.url.split('/').pop().replace(/\.txt$/i, '');
          const m     = fname.match(/^(\d+)-(.+)$/);
          const slug  = m ? m[2] : fname;
          nameMap[slug] = g.name;
        }
      });
    } catch {}

    fs.readdir(dirPath, (err, files) => {
      const list = (err ? [] : files)
        .filter(f => f.endsWith('.txt') && f !== 'index.txt')
        .map(f => {
          const base = f.replace(/\.txt$/, '');
          const m    = base.match(/^(\d+)-(.+)$/);
          const slug   = m ? m[2] : base;
          const tmdbId = m ? m[1] : '';
          return { full: base, slug, tmdbId, name: nameMap[slug] || '' };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────
  if (pathname === '/') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  let filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // If directory → try index.html
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {}

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const line = '─'.repeat(42);
  console.log(`\n  ${line}`);
  console.log(`  IPTV Player  —  Local Dev Server`);
  console.log(`  ${line}`);
  console.log(`  Player :  http://localhost:${PORT}/web/`);
  console.log(`  CMS    :  http://localhost:${PORT}/web/cms/`);
  console.log(`  ${line}\n`);
});
