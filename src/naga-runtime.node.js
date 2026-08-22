import { readFile } from 'node:fs/promises';

import initNaga, { glsl_fragment_to_wgsl as glslFragmentToWgsl } from '../dist/naga-wasm.js';

let initPromise;

async function ensureNaga() {
  if (!initPromise) {
    initPromise = readFile(new URL('../dist/naga-wasm_bg.wasm', import.meta.url))
      .then((bytes) => initNaga({ module_or_path: bytes }));
  }
  await initPromise;
}

export async function translateGlslFragmentToWgsl(source) {
  await ensureNaga();
  return glslFragmentToWgsl(source);
}
