import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(root, 'package.json');
const browserJsPath = join(root, 'dist', 'ocio-wasm.js');
const browserWasmPath = join(root, 'dist', 'ocio-wasm.wasm');
const nodeJsPath = join(root, 'dist', 'ocio-wasm.node.js');
const srcIndexPath = join(root, 'src', 'index.js');
const viteIndexPath = join(root, 'src', 'index.vite.js');
const defaultWasmUrlPath = join(root, 'src', 'wasm-url.js');
const viteWasmUrlPath = join(root, 'src', 'wasm-url.vite.js');
const typesPath = join(root, 'src', 'ocio-js.d.ts');
const demoHtmlPath = join(root, 'examples', 'browser', 'index.html');
const demoMainPath = join(root, 'examples', 'browser', 'main.js');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

function assertConditionalTarget(target, nodePath, defaultPath) {
  assert.deepEqual(Object.keys(target), ['node', 'default']);
  assert.equal(target.node, nodePath);
  assert.equal(target.default, defaultPath);
}

test('package exports select the correct WASM loader', () => {
  assert.deepEqual(Object.keys(packageJson.exports), [
    '.',
    './package.json',
  ]);
  assert.deepEqual(packageJson.exports['.'], {
    types: './src/ocio-js.d.ts',
    vite: './src/index.vite.js',
    default: './src/index.js',
  });
  assert.equal(Object.hasOwn(packageJson, 'main'), false);
  assert.ok(packageJson.files.includes('src/index.vite.js'));
  assert.ok(packageJson.files.includes('src/wasm-url.js'));
  assert.ok(packageJson.files.includes('src/wasm-url.vite.js'));
  assert.equal(packageJson.files.includes('src/wasm-url.d.ts'), false);
  assert.equal(packageJson.files.includes('src/wasm-url.browser.js'), false);

  assert.deepEqual(Object.keys(packageJson.imports), ['#ocio-wasm']);
  assertConditionalTarget(
    packageJson.imports['#ocio-wasm'],
    './dist/ocio-wasm.node.js',
    './dist/ocio-wasm.js',
  );

  assert.equal(
    Object.hasOwn(packageJson.exports, './dist/ocio-wasm.js'),
    false,
  );
  assert.equal(
    Object.hasOwn(packageJson.exports, './dist/ocio-wasm.node.js'),
    false,
  );
  assert.equal(
    Object.hasOwn(packageJson.exports, './dist/ocio-wasm.wasm'),
    false,
  );
  assert.equal(Object.hasOwn(packageJson.exports, './wasm'), false);
  assert.equal(Object.hasOwn(packageJson.exports, './wasm.wasm'), false);
  assert.equal(Object.hasOwn(packageJson.exports, './wasm-url'), false);
  assert.equal(Object.hasOwn(packageJson.exports, './wasm-url/vite'), false);
});

test('WASM build artifacts exist', () => {
  assert.equal(
    existsSync(browserJsPath),
    true,
    'Missing dist/ocio-wasm.js. Run npm run build:wasm.',
  );
  assert.equal(
    existsSync(nodeJsPath),
    true,
    'Missing dist/ocio-wasm.node.js. Run npm run build:wasm.',
  );
  assert.equal(
    existsSync(browserWasmPath),
    true,
    'Missing dist/ocio-wasm.wasm. Run npm run build:wasm.',
  );
});

test('browser loader contains no Node.js built-in imports', () => {
  const browserWrapper = readFileSync(browserJsPath, 'utf8');

  assert.doesNotMatch(browserWrapper, /['"]node:[^'"]+['"]/);
  assert.match(browserWrapper, /ocio-wasm\.wasm/);
  assert.doesNotMatch(browserWrapper, /ocio-wasm\.node\.wasm/);
});

test('Node loader uses the shared WASM binary', async () => {
  const nodeWrapper = readFileSync(nodeJsPath, 'utf8');

  assert.match(nodeWrapper, /ocio-wasm\.wasm/);
  assert.doesNotMatch(nodeWrapper, /ocio-wasm\.node\.wasm/);

  const moduleNamespace = await import('../dist/ocio-wasm.node.js');
  assert.equal(typeof moduleNamespace.default, 'function');
});

test('default createOCIO path is bundler-friendly', () => {
  const source = readFileSync(srcIndexPath, 'utf8');
  const viteSource = readFileSync(viteIndexPath, 'utf8');
  const defaultWasmUrl = readFileSync(defaultWasmUrlPath, 'utf8');
  const viteWasmUrl = readFileSync(viteWasmUrlPath, 'utf8');
  const types = readFileSync(typesPath, 'utf8');

  assert.match(source, /import OcioWasmModule from '#ocio-wasm'/);
  assert.match(source, /import DEFAULT_WASM_URL from '\.\/wasm-url\.js'/);
  assert.doesNotMatch(source, /#ocio-wasm-url/);
  assert.doesNotMatch(source, /\.\.\/dist\/ocio-wasm\.wasm/);
  assert.match(source, /options\.wasmUrl/);
  assert.match(viteSource, /import wasmUrl from '\.\/wasm-url\.vite\.js'/);
  assert.match(viteSource, /createDefaultOCIO\(\{ \.\.\.options, wasmUrl \}\)/);
  assert.match(defaultWasmUrl, /new URL\('\.\.\/dist\/ocio-wasm\.wasm', import\.meta\.url\)/);
  assert.match(viteWasmUrl, /import wasmUrl from '\.\.\/dist\/ocio-wasm\.wasm\?url'/);
  assert.doesNotMatch(source, /import\('#ocio-wasm'\)/);
  assert.doesNotMatch(source, /modulePath/);
  assert.match(types, /wasmUrl\?: string/);
  assert.doesNotMatch(types, /modulePath/);
});

test('createOCIO supports a simple wasmUrl override', async () => {
  const { createOCIO } = await import('../src/index.js');
  const fakeModule = { fake: true };
  const located = [];

  const ocio = await createOCIO({
    wasmUrl: '/assets/ocio-wasm.wasm',
    moduleFactory(options) {
      located.push(options.locateFile('ocio-wasm.wasm', '/prefix/'));
      located.push(options.locateFile('other.data', '/prefix/'));
      return Promise.resolve(fakeModule);
    },
  });

  assert.equal(ocio.module, fakeModule);
  assert.deepEqual(located, [
    '/assets/ocio-wasm.wasm',
    '/prefix/other.data',
  ]);
});

test('createOCIO keeps locateFile as the advanced override', async () => {
  const { createOCIO } = await import('../src/index.js');
  const located = [];

  await createOCIO({
    wasmUrl: '/ignored.wasm',
    locateFile(path, prefix) {
      return `${prefix}${path}.custom`;
    },
    moduleFactory(options) {
      located.push(options.locateFile('ocio-wasm.wasm', '/prefix/'));
      return Promise.resolve({});
    },
  });

  assert.deepEqual(located, ['/prefix/ocio-wasm.wasm.custom']);
});

test('browser demo uses the default createOCIO path', () => {
  const html = readFileSync(demoHtmlPath, 'utf8');
  const source = readFileSync(demoMainPath, 'utf8');

  assert.match(html, /"imports"\s*:\s*\{/);
  assert.match(html, /"@bb-studio\/ocio"\s*:\s*"\.\.\/\.\.\/src\/index\.js"/);
  assert.match(html, /"#ocio-wasm"\s*:\s*"\.\.\/\.\.\/dist\/ocio-wasm\.js"/);
  assert.doesNotMatch(html, /#ocio-wasm-url/);
  assert.match(source, /from '@bb-studio\/ocio'/);
  assert.match(source, /await createOCIO\(\)/);
  assert.doesNotMatch(source, /modulePath/);
  assert.doesNotMatch(source, /locateFile/);
});
