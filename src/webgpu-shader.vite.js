import { translateGlslFragmentToWgsl } from './naga-runtime.vite.js';
import { buildWebGpuShaderInfoWithTranslator } from './webgpu-shader-core.js';

export {
  normalizeOcioVulkanGlsl,
  resolveTranslatedWgslFunctionName,
} from './webgpu-shader-core.js';

export function buildWebGpuShaderInfo(shaderInfo) {
  return buildWebGpuShaderInfoWithTranslator(shaderInfo, translateGlslFragmentToWgsl);
}
