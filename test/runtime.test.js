import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACES_CG_V2_CONFIG,
  ACES_CG_V4_CONFIG,
  createOcioRuntime,
  normalizeOcioConfigPackage
} from '@bb-studio/ocio';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmJsPath = join(root, 'dist', 'ocio-wasm.node.js');
const wasmPath = join(root, 'dist', 'ocio-wasm.wasm');

const CONFIG = `
ocio_profile_version: 2.0
strictparsing: true
search_path: luts
environment:
  LUT: identity.spi1d
  SHOT: "010"

roles:
  default: Input
  scene_linear: Input

displays:
  Test:
    - !<View> {name: Output, colorspace: Output}

active_displays: [Test]
active_views: [Output]

file_rules:
  - !<Rule> {name: Linear EXR, colorspace: Input, pattern: "*", extension: exr}
  - !<Rule> {name: Default, colorspace: default}

colorspaces:
  - !<ColorSpace>
    name: Input
    family: Working
    encoding: scene-linear
    bitdepth: 32f
    isdata: false
    allocation: uniform

  - !<ColorSpace>
    name: Output
    family: Test
    bitdepth: 32f
    isdata: false
    allocation: uniform
    from_scene_reference: !<FileTransform> {src: $LUT, interpolation: linear}
`;

const spi1d = (maximum) => `Version 1
From 0 1
Length 2
Components 1
{
  0
  ${maximum}
}
`;

const textBytes = (value) => new TextEncoder().encode(value);

const createPackage = () => ({
  configRelativePath: 'config.ocio',
  files: [
    { relativePath: 'config.ocio', data: textBytes(CONFIG) },
    { relativePath: 'luts/identity.spi1d', data: textBytes(spi1d(1)) },
    { relativePath: 'luts/half.spi1d', data: textBytes(spi1d(0.5)) }
  ]
});

const requireWasm = (t) => {
  if (existsSync(wasmJsPath) && existsSync(wasmPath)) return true;
  t.skip('dist/ocio-wasm.node.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
  return false;
};

test('config package normalization validates paths, membership, and byte ownership', () => {
  const source = createPackage();
  const normalized = normalizeOcioConfigPackage(source);
  assert.equal(normalized.configRelativePath, 'config.ocio');
  assert.equal(normalized.files.length, 3);
  assert.notEqual(normalized.files[0].data, source.files[0].data);

  assert.throws(
    () => normalizeOcioConfigPackage({
      configRelativePath: 'config.ocio',
      files: [{ relativePath: '../config.ocio', data: textBytes(CONFIG) }]
    }),
    /Invalid OCIO config package file 0 path/
  );
  assert.throws(
    () => normalizeOcioConfigPackage({
      configRelativePath: 'config.ocio',
      files: [
        { relativePath: 'config.ocio', data: textBytes(CONFIG) },
        { relativePath: 'config.ocio', data: textBytes(CONFIG) }
      ]
    }),
    /Duplicate OCIO config package path/
  );
  assert.throws(
    () => normalizeOcioConfigPackage({
      configRelativePath: 'config.ocio',
      files: [{ relativePath: 'other.ocio', data: textBytes(CONFIG) }]
    }),
    /is missing "config.ocio"/
  );
});


test('runtime loads and inspects built-in configs without changing active state', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime();
  try {
    const active = runtime.loadBuiltinConfig(ACES_CG_V4_CONFIG);
    assert.equal(active.id, ACES_CG_V4_CONFIG);
    assert.equal(runtime.activeConfigId, ACES_CG_V4_CONFIG);

    const inspected = runtime.inspectBuiltinConfig(ACES_CG_V2_CONFIG);
    assert.equal(inspected.id, ACES_CG_V2_CONFIG);
    assert.equal(runtime.activeConfigId, ACES_CG_V4_CONFIG);
    assert.equal(runtime.getConfigInfo(), active);
  } finally {
    runtime.dispose();
  }
});

test('runtime loads byte config packages and inspects without replacing the active config', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime();
  try {
    const active = runtime.loadConfigPackage(createPackage(), { id: 'show-config' });
    assert.equal(active.id, 'show-config');
    assert.equal(active.defaultDisplay, 'Test');
    assert.equal(active.defaultViewsByDisplay.Test, 'Output');
    assert.ok(active.colorSpaces.some((colorSpace) => colorSpace.name === 'Input'));
    assert.equal(runtime.activeConfigId, 'show-config');
    assert.equal(runtime.matchFileRule('/show/shot.exr')?.ruleName, 'Linear EXR');
    assert.equal(runtime.getDefaultView('Test'), 'Output');
    assert.equal(runtime.getDefaultView('Test', 'Input'), 'Output');
    assert.deepEqual(runtime.getViews('Test').map((view) => view.name), ['Output']);

    const inspected = runtime.inspectConfigPackage(createPackage(), { id: 'inspection' });
    assert.equal(inspected.id, 'inspection');
    assert.equal(runtime.activeConfigId, 'show-config');
    assert.equal(runtime.getConfigInfo(), active);
  } finally {
    runtime.dispose();
  }
});

test('runtime replacement is atomic when a candidate config fails', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime();
  try {
    runtime.loadConfigPackage(createPackage(), { id: 'good' });
    assert.throws(
      () => runtime.loadConfigPackage({
        configRelativePath: 'config.ocio',
        files: [{ relativePath: 'config.ocio', data: textBytes('not an ocio config') }]
      }, { id: 'broken' })
    );
    assert.equal(runtime.activeConfigId, 'good');
    assert.equal(runtime.getConfigInfo()?.id, 'good');
    assert.ok(runtime.getDiagnostics().latestFailure);
  } finally {
    runtime.dispose();
  }
});

test('runtime canonicalizes context and shares processor, GLSL, WGSL, and RGB caches', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime();
  try {
    runtime.loadConfigPackage(createPackage(), { id: 'cache-test' });
    const firstContext = { SHOT: '010', LUT: 'half.spi1d' };
    const reorderedContext = { LUT: 'half.spi1d', SHOT: '010' };
    const request = (context) => ({
      transforms: { type: 'colorSpace', source: 'Input', destination: 'Output' },
      optimization: 'lossless',
      context
    });

    const glsl = runtime.getGpuShaderInfo(request(firstContext), { language: 'glsl_es_3.0' });
    const sameGlsl = runtime.getGpuShaderInfo(request(reorderedContext), { language: 'glsl_es_3.0' });
    assert.ok(glsl);
    assert.equal(sameGlsl, glsl);

    const wgsl = await runtime.getWebGpuShaderInfo(request(firstContext));
    const sameWgsl = await runtime.getWebGpuShaderInfo(request(reorderedContext));
    assert.ok(wgsl);
    assert.equal(sameWgsl, wgsl);
    assert.equal(wgsl.language, 'wgsl');

    assert.deepEqual(
      runtime.transformRgb('Input', 'Output', [1, 1, 1], { context: firstContext }),
      [0.5, 0.5, 0.5]
    );
    assert.deepEqual(
      runtime.transformRgb('Input', 'Output', [1, 1, 1], { context: reorderedContext }),
      [0.5, 0.5, 0.5]
    );
    assert.deepEqual(runtime.getDiagnostics(), {
      activeConfigId: 'cache-test',
      processorCacheEntries: 1,
      gpuShaderCacheEntries: 1,
      webGpuShaderCacheEntries: 1,
      rgbTransformCacheEntries: 1,
      latestFailure: null
    });
  } finally {
    runtime.dispose();
  }
});


test('runtime records failed processor requests without poisoning caches', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime();
  try {
    runtime.loadConfigPackage(createPackage(), { id: 'processor-failure' });
    assert.throws(
      () => runtime.getGpuShaderInfo({
        transforms: { type: 'colorSpace', source: 'Missing', destination: 'Output' }
      }),
      /Could not create OCIO GroupTransform processor/
    );
    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.processorCacheEntries, 0);
    assert.equal(diagnostics.gpuShaderCacheEntries, 0);
    assert.match(diagnostics.latestFailure ?? '', /Missing/);
  } finally {
    runtime.dispose();
  }
});

test('runtime invalidates one canonical context and disposes explicitly', async (t) => {
  if (!requireWasm(t)) return;
  const runtime = await createOcioRuntime({ maxRgbCacheEntries: 2 });
  runtime.loadConfigPackage(createPackage(), { id: 'invalidate-test' });

  const half = { LUT: 'half.spi1d', SHOT: '010' };
  const identity = { LUT: 'identity.spi1d', SHOT: '010' };
  runtime.transformRgb('Input', 'Output', [1, 1, 1], { context: half });
  runtime.transformRgb('Input', 'Output', [1, 1, 1], { context: identity });
  assert.equal(runtime.getDiagnostics().processorCacheEntries, 2);
  assert.equal(runtime.getDiagnostics().rgbTransformCacheEntries, 2);

  runtime.invalidateContext({ SHOT: '010', LUT: 'half.spi1d' });
  assert.equal(runtime.getDiagnostics().processorCacheEntries, 1);
  assert.equal(runtime.getDiagnostics().rgbTransformCacheEntries, 1);

  const remainingProcessor = runtime.processorCache.values().next().value.processor;
  assert.notEqual(remainingProcessor.handle, 0);
  runtime.clearCaches();
  assert.equal(remainingProcessor.handle, 0);
  assert.equal(runtime.getDiagnostics().processorCacheEntries, 0);
  runtime.dispose();
  runtime.dispose();
  assert.equal(runtime.activeConfigId, null);
  assert.throws(() => runtime.loadConfigPackage(createPackage()), /has been disposed/);
});
