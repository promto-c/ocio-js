import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = normalize(join(fileURLToPath(new URL('..', import.meta.url))));
const serveStaticBuild = process.argv.includes('--static');
const root = serveStaticBuild ? join(repoRoot, 'demo-dist') : repoRoot;
const defaultDocument = serveStaticBuild ? '/index.html' : '/examples/browser/index.html';
const defaultPort = 4173;
const requestedPort = parsePort(process.env.PORT, defaultPort);
const shouldTryNextPort = process.env.PORT === undefined;
const host = process.env.HOST || '127.0.0.1';
const maxPortAttempts = 100;

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm']
]);

function parsePort(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT "${value}". Expected a number from 1 to 65535.`);
    process.exit(1);
  }

  return port;
}

function formatHostForUrl(value) {
  if (value === '0.0.0.0' || value === '::') {
    return 'localhost';
  }

  return value.includes(':') ? `[${value}]` : value;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function createDemoServer() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const requestedPath = url.pathname === '/' ? defaultDocument : url.pathname;
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
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function listenOnAvailablePort(startPort) {
  const lastPort = shouldTryNextPort
    ? Math.min(65535, startPort + maxPortAttempts - 1)
    : startPort;

  for (let port = startPort; port <= lastPort; port += 1) {
    try {
      const server = await listen(createDemoServer(), port);
      return { port, server };
    } catch (error) {
      if (shouldTryNextPort && error.code === 'EADDRINUSE' && port === lastPort) {
        throw new Error(`No available port found from ${startPort} to ${lastPort}.`);
      }

      if (error.code !== 'EADDRINUSE' || port === lastPort) {
        throw error;
      }
    }
  }

  throw new Error(`No available port found from ${startPort} to ${lastPort}.`);
}

try {
  const { port } = await listenOnAvailablePort(requestedPort);
  if (port !== requestedPort) {
    console.warn(`Port ${requestedPort} is already in use; using ${port} instead.`);
  }

  const demoPath = serveStaticBuild ? '/' : '/examples/browser/';
  console.log(`OCIO browser demo: http://${formatHostForUrl(host)}:${port}${demoPath}`);
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${requestedPort} is already in use. Set PORT to another port and try again.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
