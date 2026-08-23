import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'demo-dist');

const runtimeFiles = [
  'src/index.js',
  'src/wasm-url.js',
  'src/webgpu.js',
  'src/webgpu-shader.js',
  'src/naga-runtime.js',
  'dist/ocio-wasm.js',
  'dist/ocio-wasm.wasm',
  'dist/naga-wasm.js',
  'dist/naga-wasm_bg.wasm',
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'examples/browser'), output, { recursive: true });

for (const relativePath of runtimeFiles) {
  const destination = join(output, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, relativePath), destination);
}
const indexPath = join(output, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
const staticIndexHtml = indexHtml
  .replaceAll('../../src/', './src/')
  .replaceAll('../../dist/', './dist/');

if (staticIndexHtml === indexHtml) {
  throw new Error('Demo import map was not rewritten for static deployment.');
}

await writeFile(indexPath, staticIndexHtml);

console.log(`Built static demo: ${output}`);
