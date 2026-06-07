import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACES_CG_V4_CONFIG, createOCIO } from '../src/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmJsPath = join(root, 'dist', 'ocio-wasm.js');
const wasmPath = join(root, 'dist', 'ocio-wasm.wasm');

test('OpenColorIO 2.5 wasm loads the ACES v4 built-in CG config', async (t) => {
  if (!existsSync(wasmJsPath) || !existsSync(wasmPath)) {
    t.skip('dist/ocio-wasm.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
    return;
  }

  const ocio = await createOCIO({
    modulePath: pathToFileURL(wasmJsPath).href,
    locateFile(path) {
      return path.endsWith('.wasm') ? pathToFileURL(wasmPath).href : path;
    }
  });

  assert.match(ocio.version, /^2\.5\./);

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

  const gamutProcessor = config.createColorSpaceProcessor('ACEScg', 'ACES2065-1');
  const red = gamutProcessor.applyRGBF32(new Float32Array([1, 0, 0]), { copy: true });
  assert.equal(red.length, 3);
  assert.notDeepEqual(Array.from(red), [1, 0, 0], 'ACEScg -> ACES2065-1 should be a real transform');

  processor.dispose();
  gamutProcessor.dispose();
  config.dispose();
});
