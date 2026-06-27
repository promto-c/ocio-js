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
  default: sRGB

displays:
  sRGB:
    - !<View> {name: Raw, colorspace: sRGB}

active_displays: [sRGB]
active_views: [Raw]

file_rules:
  - !<Rule> {name: Linear EXR, colorspace: Linear, pattern: "*", extension: exr, custom: {source: camera}}
  - !<Rule> {name: Plates, colorspace: sRGB, regex: ".*plate.*"}
  - !<Rule> {name: Default, colorspace: default}

colorspaces:
  - !<ColorSpace>
    name: Linear
    family: Utility
    bitdepth: 32f
    isdata: false
    allocation: uniform

  - !<ColorSpace>
    name: sRGB
    family: Utility
    bitdepth: 32f
    isdata: false
    allocation: uniform
`;

test('file rules expose ordered definitions and native filepath matches', async (t) => {
  if (!existsSync(wasmJsPath) || !existsSync(wasmPath)) {
    t.skip('dist/ocio-wasm.node.js and dist/ocio-wasm.wasm are missing. Run npm run build:wasm first.');
    return;
  }

  const ocio = await createOCIO();
  const config = ocio.createConfigFromString(CONFIG);

  try {
    assert.equal(config.validate(), true);
    assert.deepEqual(config.listFileRules(), [
      {
        index: 0,
        name: 'Linear EXR',
        colorSpace: 'Linear',
        pattern: '*',
        extension: 'exr',
        regex: '',
        custom: { source: 'camera' }
      },
      {
        index: 1,
        name: 'Plates',
        colorSpace: 'sRGB',
        pattern: '',
        extension: '',
        regex: '.*plate.*',
        custom: {}
      },
      {
        index: 2,
        name: 'Default',
        colorSpace: 'default',
        pattern: '',
        extension: '',
        regex: '',
        custom: {}
      }
    ]);

    assert.deepEqual(config.matchFileRule('/show/shot010.exr'), {
      colorSpace: 'Linear',
      ruleIndex: 0,
      ruleName: 'Linear EXR',
      isDefaultRule: false,
      custom: { source: 'camera' }
    });
    assert.deepEqual(config.matchFileRule('/show/plate_v001.png'), {
      colorSpace: 'sRGB',
      ruleIndex: 1,
      ruleName: 'Plates',
      isDefaultRule: false,
      custom: {}
    });
    assert.deepEqual(config.matchFileRule('/show/unknown.png'), {
      colorSpace: 'default',
      ruleIndex: 2,
      ruleName: 'Default',
      isDefaultRule: true,
      custom: {}
    });
  } finally {
    config.dispose();
  }
});
