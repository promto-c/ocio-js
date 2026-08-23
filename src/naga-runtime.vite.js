import initNaga, {
  glsl_fragment_to_wgsl as glslFragmentToWgsl,
} from '../dist/naga-wasm.js';
import nagaWasmUrl from '../dist/naga-wasm_bg.wasm?url';

let initPromise;

async function ensureNaga() {
  if (!initPromise) {
    initPromise = initNaga({ module_or_path: nagaWasmUrl });
  }
  await initPromise;
}

export async function translateGlslFragmentToWgsl(source) {
  await ensureNaga();
  return glslFragmentToWgsl(source);
}
