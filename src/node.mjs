import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createApp } from './api.mjs';
import { createStore } from './store.mjs';

const origin = new URL(process.env.PLANNER_ORIGIN || 'http://localhost:8787').origin;
const db = new DatabaseSync(process.env.PLANNER_DB || 'planner.sqlite');
db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
const store = createStore({
  all: (sql, ...values) => db.prepare(sql).all(...values),
  run: (sql, ...values) => db.prepare(sql).run(...values).changes
});
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']]
]);
const app = createApp({
  store, secret: process.env.PLANNER_PASSWORD,
  assets(request) {
    const file = files.get(new URL(request.url).pathname);
    if (!file) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : readFileSync(new URL('../public/' + file[0], import.meta.url)), {
      headers: { 'Content-Type': file[1] }
    });
  }
});

createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(origin + req.url, {
      method: req.method, headers: req.headers,
      ...(hasBody && { body: Readable.toWeb(req), duplex: 'half' })
    });
    const response = await app(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch {
    res.writeHead(500).end();
  }
}).listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('Ежедневник: ' + origin));
