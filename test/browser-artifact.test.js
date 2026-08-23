import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const browserJsPath = join(root, 'dist', 'ocio-wasm.js');
const browserWasmPath = join(root, 'dist', 'ocio-wasm.wasm');
const nodeJsPath = join(root, 'dist', 'ocio-wasm.node.js');
const nagaJsPath = join(root, 'dist', 'naga-wasm.js');
const nagaWasmPath = join(root, 'dist', 'naga-wasm_bg.wasm');
const nagaBrowserRuntimePath = join(root, 'src', 'naga-runtime.js');
const webGpuRuntimePath = join(root, 'src', 'webgpu.js');
const webGpuShaderPath = join(root, 'src', 'webgpu-shader.js');
const webGpuShaderVitePath = join(root, 'src', 'webgpu-shader.vite.js');
const webGpuShaderLoaderPath = join(root, 'src', 'webgpu-shader-loader.js');
const srcIndexPath = join(root, 'src', 'index.js');
const demoHtmlPath = join(root, 'examples', 'browser', 'index.html');
const demoMainPath = join(root, 'examples', 'browser', 'main.js');

function assertConditionalTarget(target, nodePath, defaultPath) {
  assert.equal(target?.node, nodePath);
  assert.equal(target?.default, defaultPath);
}

function assertPackageFile(path) {
  assert.ok(packageJson.files.includes(path), `Package must include ${path}`);
}

test('package routes and ships required runtime files', () => {
  const rootExport = packageJson.exports['.'];
  assert.equal(rootExport.types, './src/ocio-js.d.ts');
  assert.equal(rootExport.vite, './src/index.vite.js');
  assert.equal(rootExport.default, './src/index.js');

  const webGpuExport = packageJson.exports['./webgpu'];
  assert.equal(webGpuExport.types, './src/webgpu.d.ts');
  assert.equal(webGpuExport.default, './src/webgpu.js');

  assertConditionalTarget(
    packageJson.imports['#ocio-wasm'],
    './dist/ocio-wasm.node.js',
    './dist/ocio-wasm.js',
  );
  assertConditionalTarget(
    packageJson.imports['#naga-runtime'],
    './src/naga-runtime.node.js',
    './src/naga-runtime.js',
  );
  assert.equal(
    packageJson.imports['#naga-runtime'].vite,
    './src/naga-runtime.vite.js',
  );

  for (const path of [
    'dist/ocio-wasm.js',
    'dist/ocio-wasm.node.js',
    'dist/ocio-wasm.wasm',
    'dist/naga-wasm.js',
    'dist/naga-wasm_bg.wasm',
    'src/index.js',
    'src/index.vite.js',
    'src/wasm-url.js',
    'src/wasm-url.vite.js',
    'src/naga-runtime.js',
    'src/naga-runtime.node.js',
    'src/naga-runtime.vite.js',
    'src/webgpu.js',
    'src/webgpu-shader-core.js',
    'src/webgpu-shader-loader.js',
    'src/webgpu-shader.vite.js',
    'src/webgpu-shader.js',
    'src/webgpu.d.ts',
    'src/ocio-js.d.ts',
  ]) {
    assertPackageFile(path);
  }
});

test('built browser runtimes exist and avoid Node.js built-ins', () => {
  for (const path of [
    browserJsPath,
    browserWasmPath,
    nodeJsPath,
    nagaJsPath,
    nagaWasmPath,
  ]) {
    assert.equal(existsSync(path), true, `Missing build artifact: ${path}`);
  }

  for (const path of [
    browserJsPath,
    nagaJsPath,
    nagaBrowserRuntimePath,
    webGpuRuntimePath,
    webGpuShaderPath,
    webGpuShaderVitePath,
    webGpuShaderLoaderPath,
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /['"]node:[^'"]+['"]/);
  }
});

test('base entry lazily loads the WebGPU translator', () => {
  const source = readFileSync(srcIndexPath, 'utf8');
  const loader = readFileSync(webGpuShaderLoaderPath, 'utf8');

  assert.doesNotMatch(source, /^import .*webgpu\.js/m);
  assert.match(source, /await loadWebGpuShaderBuilder\(\)/);
  assert.match(loader, /import\('\.\/webgpu-shader\.js'\)/);
});

test('Vite entry selects the Vite-safe Naga shader builder', () => {
  const source = readFileSync(join(root, 'src', 'index.vite.js'), 'utf8');
  const shaderSource = readFileSync(webGpuShaderVitePath, 'utf8');

  assert.match(source, /configureWebGpuShaderBuilderLoader/);
  assert.match(source, /import\('\.\/webgpu-shader\.vite\.js'\)/);
  assert.match(shaderSource, /from '\.\/naga-runtime\.vite\.js'/);
});

test('Node OCIO and Naga runtime loaders are usable', async () => {
  const ocioModule = await import('../dist/ocio-wasm.node.js');
  assert.equal(typeof ocioModule.default, 'function');

  const { translateGlslFragmentToWgsl } = await import('../src/naga-runtime.node.js');
  const wgsl = await translateGlslFragmentToWgsl(`#version 460
layout(set=0, binding=0) uniform texture2D lut;
layout(set=0, binding=1) uniform sampler lutSampler;
layout(location=0) out vec4 outputColor;
void main() {
  outputColor = texture(sampler2D(lut, lutSampler), vec2(0.5));
}`);

  assert.match(wgsl, /texture_2d<f32>/);
  assert.match(wgsl, /var lutSampler: sampler/);
  assert.match(wgsl, /@fragment/);
});

test('createOCIO honors wasmUrl and locateFile overrides', async () => {
  const { createOCIO } = await import('../src/index.js');
  const located = [];
  await createOCIO({
    wasmUrl: '/assets/ocio-wasm.wasm',
    moduleFactory(options) {
      located.push(options.locateFile('ocio-wasm.wasm', '/prefix/'));
      located.push(options.locateFile('other.data', '/prefix/'));
      return Promise.resolve({});
    },
  });
  assert.deepEqual(located, ['/assets/ocio-wasm.wasm', '/prefix/other.data']);

  located.length = 0;
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

test('browser demo maps the local development runtimes', () => {
  const html = readFileSync(demoHtmlPath, 'utf8');
  const source = readFileSync(demoMainPath, 'utf8');

  assert.match(html, /"@bb-studio\/ocio"\s*:\s*"\.\.\/\.\.\/src\/index\.js"/);
  assert.match(html, /"@bb-studio\/ocio\/webgpu"\s*:\s*"\.\.\/\.\.\/src\/webgpu\.js"/);
  assert.match(html, /"#ocio-wasm"\s*:\s*"\.\.\/\.\.\/dist\/ocio-wasm\.js"/);
  assert.match(html, /"#naga-runtime"\s*:\s*"\.\.\/\.\.\/src\/naga-runtime\.js"/);
  assert.match(source, /from '@bb-studio\/ocio'/);
  assert.match(source, /from '@bb-studio\/ocio\/webgpu'/);
  assert.match(source, /createOcioWebGpuResources/);
  assert.match(source, /await createOCIO\(\)/);
});
