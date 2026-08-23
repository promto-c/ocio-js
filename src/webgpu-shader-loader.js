let loadWebGpuShaderBuilderImpl = () => import('./webgpu-shader.js');

export function configureWebGpuShaderBuilderLoader(loader) {
  loadWebGpuShaderBuilderImpl = loader;
}

export function loadWebGpuShaderBuilder() {
  return loadWebGpuShaderBuilderImpl();
}
