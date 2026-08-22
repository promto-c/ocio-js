import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACES_CG_V4_CONFIG, createOCIO } from '@bb-studio/ocio';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmJsPath = join(root, 'dist', 'ocio-wasm.node.js');
const wasmPath = join(root, 'dist', 'ocio-wasm.wasm');

test('OpenColorIO 2.5.2 wasm loads the ACES v4 built-in CG config', async (t) => {
  if (!existsSync(wasmJsPath) || !existsSync(wasmPath)) {
    t.skip('dist/ocio-wasm.node.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
    return;
  }

  const ocio = await createOCIO();

  assert.equal(ocio.version, '2.5.2');

  const builtins = ocio.listBuiltinConfigs();
  assert.ok(
    builtins.some((config) => config.name === 'cg-config-v4.0.0_aces-v2.0_ocio-v2.5'),
    'ACES v4 / ACES 2.0 CG built-in config should be registered'
  );

  const config = ocio.createBuiltinConfig(ACES_CG_V4_CONFIG);
  assert.equal(config.validate(), true);
  assert.deepEqual(config.version, { major: 2, minor: 5 });

  const colorSpaces = config.listColorSpaces();
  const colorSpaceNames = colorSpaces.map((colorSpace) => colorSpace.name);
  assert.ok(colorSpaceNames.includes('ACEScg'), 'ACEScg color space should be present');
  assert.ok(colorSpaceNames.includes('ACES2065-1'), 'ACES2065-1 color space should be present');
  assert.ok(colorSpaces.length > 10, 'ACES CG config should expose a non-trivial color-space list');

  const displays = config.listDisplays();
  assert.ok(displays.length > 0, 'ACES CG config should expose displays');

  const display = config.getDefaultDisplay() || displays[0];
  const view = config.getDefaultView(display, 'ACEScg') || config.listViews(display)[0].name;
  assert.ok(display);
  assert.ok(view);

  const processor = config.createDisplayViewProcessor({
    source: 'ACEScg',
    display,
    view,
    optimization: 'lossless'
  });

  const pixels = new Float32Array([
    0.18, 0.18, 0.18, 1.0,
    1.0, 0.0, 0.0, 1.0,
    4.0, 4.0, 4.0, 1.0
  ]);
  processor.applyRGBAF32(pixels);

  for (const value of pixels) {
    assert.equal(Number.isFinite(value), true);
  }
  assert.equal(pixels[3], 1.0);
  assert.equal(pixels[7], 1.0);
  assert.equal(pixels[11], 1.0);

  const shaderInfo = processor.getGpuShaderInfo({
    language: 'glsl_es_3.0',
    functionName: 'OCIODisplay',
    allowTexture1D: false
  });
  assert.equal(shaderInfo.language, 'glsl_es_3.0');
  assert.equal(shaderInfo.functionName, 'OCIODisplay');
  assert.match(shaderInfo.shaderText, /OCIODisplay/);
  assert.equal(Array.isArray(shaderInfo.textures), true);
  assert.equal(Array.isArray(shaderInfo.uniforms), true);
  for (const texture of shaderInfo.textures) {
    assert.ok(texture.width > 0);
    assert.ok(texture.height > 0);
    assert.ok(texture.depth > 0);
    assert.ok(texture.values instanceof Float32Array);
    assert.equal(texture.values.length, texture.width * texture.height * texture.depth * texture.channels);
  }

  const webGpuShaderInfo = await processor.getWebGpuShaderInfo({
    functionName: 'OCIODisplay',
    resourcePrefix: 'ocio_webgpu'
  });
  assert.equal(webGpuShaderInfo.language, 'wgsl');
  assert.equal(webGpuShaderInfo.sourceLanguage, 'glsl_vk_4.6');
  assert.match(webGpuShaderInfo.shaderText, /fn OCIODisplay/);
  assert.match(webGpuShaderInfo.shaderText, /@fragment/);
  for (const texture of webGpuShaderInfo.textures) {
    assert.ok(texture.texture);
    assert.ok(texture.sampler);
  }

  const gamutProcessor = config.createColorSpaceProcessor('ACEScg', 'ACES2065-1');
  const red = gamutProcessor.applyRGBF32(new Float32Array([1, 0, 0]), { copy: true });
  assert.equal(red.length, 3);
  assert.notDeepEqual(Array.from(red), [1, 0, 0], 'ACEScg -> ACES2065-1 should be a real transform');

  processor.dispose();
  gamutProcessor.dispose();
  config.dispose();
});
