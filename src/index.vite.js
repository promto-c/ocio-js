import { OcioRuntime, createOCIO as createDefaultOCIO } from './index.js';
import wasmUrl from './wasm-url.vite.js';
import { configureWebGpuShaderBuilderLoader } from './webgpu-shader-loader.js';

configureWebGpuShaderBuilderLoader(() => import('./webgpu-shader.vite.js'));

export * from './index.js';

export function createOCIO(options = {}) {
  if (options.locateFile || options.wasmUrl != null) {
    return createDefaultOCIO(options);
  }
  return createDefaultOCIO({ ...options, wasmUrl });
}

export async function createOcioRuntime(options = {}) {
  const { maxRgbCacheEntries, ...ocioOptions } = options;
  const ocio = await createOCIO(ocioOptions);
  return new OcioRuntime(ocio, { maxRgbCacheEntries });
}
