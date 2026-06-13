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
    './wasm',
    './wasm.wasm',
    './package.json',
  ]);
  assert.deepEqual(packageJson.exports['.'], {
    types: './src/ocio-js.d.ts',
    default: './src/index.js',
  });
  assert.equal(Object.hasOwn(packageJson, 'main'), false);

  assertConditionalTarget(
    packageJson.imports['#ocio-wasm'],
    './dist/ocio-wasm.node.js',
    './dist/ocio-wasm.js',
  );

  assertConditionalTarget(
    packageJson.exports['./wasm'],
    './dist/ocio-wasm.node.js',
    './dist/ocio-wasm.js',
  );

  assert.equal(
    packageJson.exports['./wasm.wasm'],
    './dist/ocio-wasm.wasm',
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
  const types = readFileSync(typesPath, 'utf8');

  assert.match(source, /import OcioWasmModule from '#ocio-wasm'/);
  assert.match(source, /new URL\('\.\.\/dist\/ocio-wasm\.wasm', import\.meta\.url\)/);
  assert.doesNotMatch(source, /import\('#ocio-wasm'\)/);
  assert.doesNotMatch(source, /modulePath/);
  assert.doesNotMatch(types, /modulePath/);
});

test('browser demo uses the default createOCIO path', () => {
  const html = readFileSync(demoHtmlPath, 'utf8');
  const source = readFileSync(demoMainPath, 'utf8');

  assert.match(html, /"imports"\s*:\s*\{/);
  assert.match(html, /"#ocio-wasm"\s*:\s*"\.\.\/\.\.\/dist\/ocio-wasm\.js"/);
  assert.match(source, /await createOCIO\(\)/);
  assert.doesNotMatch(source, /modulePath/);
  assert.doesNotMatch(source, /locateFile/);
});
