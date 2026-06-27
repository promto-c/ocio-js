import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOCIO } from '@bb-studio/ocio';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmJsPath = join(root, 'dist', 'ocio-wasm.node.js');
const wasmPath = join(root, 'dist', 'ocio-wasm.wasm');

const CONFIG = `
ocio_profile_version: 2.0
strictparsing: true
search_path: luts
environment:
  LUT: identity.spi1d

roles:
  default: Input

displays:
  Test:
    - !<View> {name: Output, colorspace: Output}

active_displays: [Test]
active_views: [Output]

colorspaces:
  - !<ColorSpace>
    name: Input
    bitdepth: 32f
    isdata: false
    allocation: uniform

  - !<ColorSpace>
    name: Output
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

test('processor context variables resolve file transforms', async (t) => {
  if (!existsSync(wasmJsPath) || !existsSync(wasmPath)) {
    t.skip('dist/ocio-wasm.node.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
    return;
  }

  const ocio = await createOCIO();
  ocio.writeFile('/context/luts/identity.spi1d', spi1d(1));
  ocio.writeFile('/context/luts/half.spi1d', spi1d(0.5));
  const config = ocio.createConfigFromString(CONFIG, { workingDir: '/context' });

  try {
    assert.equal(config.validate(), true);
    const identity = config.createColorSpaceProcessor('Input', 'Output', {
      context: { LUT: 'identity.spi1d' }
    });
    const half = config.createColorSpaceProcessor('Input', 'Output', {
      context: { LUT: 'half.spi1d' }
    });
    try {
      assert.deepEqual(Array.from(identity.applyRGBF32(new Float32Array([1, 1, 1]))), [1, 1, 1]);
      assert.deepEqual(Array.from(half.applyRGBF32(new Float32Array([1, 1, 1]))), [0.5, 0.5, 0.5]);
      assert.notEqual(identity.cacheId, half.cacheId);
    } finally {
      identity.dispose();
      half.dispose();
    }
  } finally {
    config.dispose();
  }
});
