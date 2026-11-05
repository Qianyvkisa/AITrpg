// ---------------------------------------------------------------------------
// 极简静态文件服务（开发用）
// 用途：浏览器在 file:// 下会拦截 ES module 的跨文件加载，
// 起一个本地服务才能在真实浏览器里跑 tools/ui 的布局验证页。
//
// 用法：node tools/dev-server.mjs [端口]
// ---------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8931);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // 只允许访问仓库内文件，挡掉 ../ 穿越
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const abs = path.join(ROOT, rel);

  if (!abs.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}/tools/ui/index.html`);
});
