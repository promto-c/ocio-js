import initNaga, { glsl_fragment_to_wgsl as glslFragmentToWgsl } from '../dist/naga-wasm.js';

let initPromise;

async function ensureNaga() {
  if (!initPromise) {
    const wasmUrl = new URL('../dist/naga-wasm_bg.wasm', import.meta.url);
    initPromise = initNaga({ module_or_path: wasmUrl });
  }
  await initPromise;
}

export async function translateGlslFragmentToWgsl(source) {
  await ensureNaga();
  return glslFragmentToWgsl(source);
}
