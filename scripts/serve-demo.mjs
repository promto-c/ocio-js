import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(join(fileURLToPath(new URL('..', import.meta.url))));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm']
]);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const requestedPath = url.pathname === '/' ? '/examples/browser/index.html' : url.pathname;
  let normalizedPath = normalize(join(root, decodeURIComponent(requestedPath)));

  if (!normalizedPath.startsWith(root)) {
    send(res, 403, 'Forbidden');
    return;
  }

  if (existsSync(normalizedPath) && statSync(normalizedPath).isDirectory()) {
    normalizedPath = join(normalizedPath, 'index.html');
  }

  if (!existsSync(normalizedPath) || !statSync(normalizedPath).isFile()) {
    send(res, 404, 'Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': mime.get(extname(normalizedPath)) || 'application/octet-stream',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp'
  });
  createReadStream(normalizedPath).pipe(res);
}).listen(port, host, () => {
  console.log(`OCIO browser demo: http://${host}:${port}/examples/browser/`);
});
