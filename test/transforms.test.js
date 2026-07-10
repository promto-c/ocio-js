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

roles:
  default: Linear
  scene_linear: Linear

displays:
  Test:
    - !<View> {name: Raw, colorspace: Linear}

active_displays: [Test]
active_views: [Raw]

looks:
  - !<Look>
    name: Warm
    process_space: Linear
    description: Test warm look
    transform: !<MatrixTransform> {offset: [0.05, 0.05, 0.05, 0]}

colorspaces:
  - !<ColorSpace>
    name: Linear
    family: Working
    encoding: scene-linear
    bitdepth: 32f
    isdata: false
    allocation: uniform

  - !<ColorSpace>
    name: Doubled
    family: Test
    encoding: scene-linear
    bitdepth: 32f
    isdata: false
    allocation: uniform
    from_scene_reference: !<MatrixTransform> {matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]}

named_transforms:
  - !<NamedTransform>
    name: Lift
    aliases: [lift_alias]
    family: Utility/Test
    categories: [utility, test]
    encoding: scene-linear
    description: Adds a channel-specific lift
    transform: !<MatrixTransform> {offset: [0.1, 0.2, 0.3, 0]}
`;

const HALF_CUBE = `
TITLE "Half"
LUT_1D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
0.5 0.5 0.5
`;

const closeTo = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `Expected channel ${index} to be ${expected[index]}, received ${value}`
    );
  });
};

test('file, look, named, and group transforms expose CPU and GPU processors', async (t) => {
  if (!existsSync(wasmJsPath) || !existsSync(wasmPath)) {
    t.skip('dist/ocio-wasm.node.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
    return;
  }

  const ocio = await createOCIO();
  ocio.writeFile('/transforms/half.cube', HALF_CUBE);
  const config = ocio.createConfigFromString(CONFIG, { workingDir: '/transforms' });

  try {
    assert.equal(config.validate(), true);

    const formats = ocio.listFileTransformFormats();
    assert.ok(formats.some((format) => format.extension.toLowerCase() === 'cube'));
    assert.equal(ocio.isFileTransformFormatSupported('.cube'), true);
    assert.equal(ocio.isFileTransformFormatSupported('definitely-not-a-lut'), false);

    assert.deepEqual(config.getLook('Warm'), {
      name: 'Warm',
      processSpace: 'Linear',
      description: 'Test warm look',
      hasForwardTransform: true,
      hasInverseTransform: false
    });
    assert.equal(config.getLooksResultColorSpace('Warm'), 'Linear');

    assert.deepEqual(config.getNamedTransform('lift_alias'), {
      name: 'Lift',
      family: 'Utility/Test',
      description: 'Adds a channel-specific lift',
      encoding: 'scene-linear',
      aliases: ['lift_alias'],
      categories: ['utility', 'test'],
      hasForwardTransform: true,
      hasInverseTransform: false
    });

    const fileProcessor = config.createFileTransformProcessor({
      src: '$LUT',
      interpolation: 'linear',
      optimization: 'lossless',
      context: { LUT: '/transforms/half.cube' }
    });
    const lookProcessor = config.createLookTransformProcessor({
      source: 'Linear',
      destination: 'Linear',
      looks: 'Warm'
    });
    const namedProcessor = config.createNamedTransformProcessor('Lift');
    const namedInverseProcessor = config.createNamedTransformProcessor('Lift', {
      direction: 'inverse'
    });
    const groupProcessor = config.createGroupTransformProcessor([
      { type: 'file', src: '/transforms/half.cube', interpolation: 'best' },
      { type: 'named', name: 'Lift' }
    ]);
    const colorSpaceGroupProcessor = config.createGroupTransformProcessor([
      { type: 'colorSpace', source: 'Linear', destination: 'Doubled' }
    ]);
    const displayProcessor = config.createDisplayViewProcessor({
      source: 'Linear',
      display: 'Test',
      view: 'Raw',
      looksBypass: true,
      dataBypass: true
    });

    try {
      closeTo(fileProcessor.applyRGBF32(new Float32Array([1, 1, 1])), [0.5, 0.5, 0.5]);
      closeTo(lookProcessor.applyRGBF32(new Float32Array([0, 0, 0])), [0.05, 0.05, 0.05]);

      const lifted = namedProcessor.applyRGBF32(new Float32Array([0, 0, 0]));
      closeTo(lifted, [0.1, 0.2, 0.3]);
      closeTo(namedInverseProcessor.applyRGBF32(lifted), [0, 0, 0]);

      closeTo(groupProcessor.applyRGBF32(new Float32Array([1, 1, 1])), [0.6, 0.7, 0.8]);
      closeTo(
        colorSpaceGroupProcessor.applyRGBF32(new Float32Array([0.25, 0.5, 1])),
        [0.5, 1, 2]
      );
      closeTo(displayProcessor.applyRGBF32(new Float32Array([0.2, 0.4, 0.6])), [0.2, 0.4, 0.6]);

      const shaderInfo = fileProcessor.getGpuShaderInfo({
        language: 'glsl_es_3.0',
        functionName: 'OCIOFileTransform',
        resourcePrefix: 'ocio_file',
        allowTexture1D: false
      });
      assert.match(shaderInfo.shaderText, /OCIOFileTransform/);
      assert.ok(shaderInfo.textures.length > 0);
      assert.ok(shaderInfo.textures.every((texture) => texture.values instanceof Float32Array));
    } finally {
      fileProcessor.dispose();
      lookProcessor.dispose();
      namedProcessor.dispose();
      namedInverseProcessor.dispose();
      groupProcessor.dispose();
      colorSpaceGroupProcessor.dispose();
      displayProcessor.dispose();
    }

    assert.throws(
      () => config.createGroupTransformProcessor([{ type: 'missing' }]),
      /Unknown OCIO group transform type/
    );
    assert.throws(
      () => config.createFileTransformProcessor({ src: '', interpolation: 'linear' }),
      /FileTransform src must be a non-empty string/
    );
    assert.throws(() => config.getLook('Missing'), /Look not found/);
    assert.throws(() => config.getNamedTransform('Missing'), /Named transform not found/);
  } finally {
    config.dispose();
  }
});
