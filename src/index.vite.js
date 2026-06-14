import { createOCIO as createDefaultOCIO } from './index.js';
import wasmUrl from './wasm-url.vite.js';

export * from './index.js';

export function createOCIO(options = {}) {
  if (options.locateFile || options.wasmUrl != null) {
    return createDefaultOCIO(options);
  }
  return createDefaultOCIO({ ...options, wasmUrl });
}
