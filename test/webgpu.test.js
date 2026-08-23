import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOcioWebGpuResources,
  getOcioWebGpuNextBindGroupIndex,
  getOcioWebGpuRequiredFeatures,
  packOcioWebGpuUniforms,
} from '@bb-studio/ocio/webgpu';
import {
  buildWebGpuShaderInfo,
  normalizeOcioVulkanGlsl,
} from '../src/webgpu-shader.js';

function createShaderInfo(overrides = {}) {
  return {
    shaderText: '',
    sourceShaderText: '',
    functionName: 'OCIODisplay',
    language: 'wgsl',
    sourceLanguage: 'glsl_vk_4.6',
    cacheId: 'test',
    uniformBufferSize: 0,
    uniformBinding: null,
    textures: [],
    uniforms: [],
    ...overrides,
  };
}

test('WebGPU normalization allocates sampler bindings after every occupied binding', () => {
  const normalized = normalizeOcioVulkanGlsl({
    shaderText: `#version 460
layout(set=0, binding=5) uniform OcioUniforms { float exposure; };
layout(set=0, binding=1) uniform sampler2D ocio_lutSampler;
vec4 OCIODisplay(vec4 color) {
  return texture(ocio_lutSampler, color.xy);
}`,
    functionName: 'OCIODisplay',
    uniformBufferSize: 16,
    textures: [{
      name: 'ocio_lut',
      samplerName: 'ocio_lutSampler',
      dimensions: 2,
    }],
  });

  assert.deepEqual(normalized.uniformBinding, { group: 0, binding: 5 });
  assert.deepEqual(normalized.textureBindings.get('ocio_lutSampler'), {
    texture: { group: 0, binding: 1 },
    sampler: { group: 0, binding: 6 },
  });
  assert.match(normalized.source, /layout\(set=0, binding=6\) uniform sampler ocio_lutSampler;/);
});


test('WebGPU shader metadata follows Naga-renamed callable functions', async () => {
  const functionName = 'OCIODisplay9';
  const shaderInfo = await buildWebGpuShaderInfo({
    shaderText: `#version 460
vec4 ${functionName}(vec4 color) { return color; }`,
    functionName,
    language: 'glsl_vk_4.6',
    cacheId: 'digit-ending-function',
    uniformBufferSize: 0,
    textures: [],
    uniforms: [],
  });

  assert.equal(shaderInfo.functionName, 'OCIODisplay9_');
  assert.match(shaderInfo.shaderText, /fn OCIODisplay9_\(/);
});

test('WebGPU helpers expose required features and the next free bind group', () => {
  const shaderInfo = createShaderInfo({
    uniformBinding: { group: 1, binding: 0 },
    textures: [{
      interpolation: 'linear',
      texture: { group: 2, binding: 0 },
      sampler: { group: 2, binding: 1 },
    }],
  });

  assert.deepEqual(getOcioWebGpuRequiredFeatures(shaderInfo), ['float32-filterable']);
  assert.deepEqual(
    getOcioWebGpuRequiredFeatures(shaderInfo, { texturePrecision: 'float16' }),
    [],
  );
  assert.equal(getOcioWebGpuNextBindGroupIndex(shaderInfo), 3);

  const nearest = createShaderInfo({
    textures: [{
      interpolation: 'nearest',
      texture: { group: 0, binding: 0 },
      sampler: { group: 0, binding: 1 },
    }],
  });
  assert.deepEqual(getOcioWebGpuRequiredFeatures(nearest), []);
});

test('WebGPU uniform packing honors OCIO byte offsets and rejects invalid layouts', () => {
  const packed = packOcioWebGpuUniforms(createShaderInfo({
    uniformBufferSize: 32,
    uniforms: [
      { name: 'enabled', type: 'bool', bufferOffset: 0, value: true },
      { name: 'indices', type: 'vector_int', bufferOffset: 4, value: [2, 3] },
      { name: 'color', type: 'float3', bufferOffset: 12, value: [1.5, 2.5, 3.5] },
    ],
  }));
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);

  assert.equal(view.getInt32(0, true), 1);
  assert.equal(view.getInt32(4, true), 2);
  assert.equal(view.getInt32(8, true), 3);
  assert.equal(view.getFloat32(12, true), 1.5);
  assert.equal(view.getFloat32(16, true), 2.5);
  assert.equal(view.getFloat32(20, true), 3.5);

  assert.throws(
    () => packOcioWebGpuUniforms(createShaderInfo({
      uniformBufferSize: 4,
      uniforms: [{ name: 'tooLarge', type: 'float3', bufferOffset: 0, value: [1, 2, 3] }],
    })),
    /exceeds the declared 4-byte uniform buffer/,
  );
  assert.throws(
    () => packOcioWebGpuUniforms(createShaderInfo({
      uniformBufferSize: 4,
      uniforms: [{ name: 'mystery', type: 'unknown', bufferOffset: 0, value: 0 }],
    })),
    /unsupported OCIO GPU uniform type/,
  );
});


test('WebGPU resource helper uses explicit precision, creates bind groups, and disposes safely', () => {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousTextureUsage = globalThis.GPUTextureUsage;
  globalThis.GPUBufferUsage = { COPY_DST: 1, UNIFORM: 2 };
  globalThis.GPUTextureUsage = { COPY_DST: 4, TEXTURE_BINDING: 8 };

  const destroyed = [];
  const textureDescriptors = [];
  const bindGroupDescriptors = [];
  const device = {
    features: new Set(['float32-filterable']),
    queue: {
      writeBuffer() {},
      writeTexture() {},
    },
    createBuffer() {
      return { destroy: () => destroyed.push('buffer') };
    },
    createTexture(descriptor) {
      textureDescriptors.push(descriptor);
      return {
        createView: () => ({ textureView: true }),
        destroy: () => destroyed.push('texture'),
      };
    },
    createSampler: () => ({ sampler: true }),
    createBindGroup(descriptor) {
      bindGroupDescriptors.push(descriptor);
      return { bindGroup: true };
    },
  };
  const pipeline = { getBindGroupLayout: (group) => ({ group }) };
  const shaderInfo = createShaderInfo({
    uniformBufferSize: 16,
    uniformBinding: { group: 0, binding: 0 },
    uniforms: [{ name: 'value', type: 'double', bufferOffset: 0, value: 1 }],
    textures: [{
      name: 'lut',
      samplerName: 'lutSampler',
      width: 2,
      height: 1,
      depth: 1,
      dimensions: 2,
      channels: 1,
      interpolation: 'linear',
      values: new Float32Array([0, 1]),
      texture: { group: 0, binding: 1 },
      sampler: { group: 0, binding: 2 },
    }],
  });

  try {
    const resources = createOcioWebGpuResources(device, pipeline, shaderInfo);
    assert.equal(resources.texturePrecision, 'float32');
    assert.equal(resources.bindGroups.size, 1);
    assert.equal(textureDescriptors[0].format, 'r32float');
    assert.equal(bindGroupDescriptors.length, 1);

    resources.dispose();
    resources.dispose();
    assert.deepEqual(destroyed.sort(), ['buffer', 'texture']);

    const lowPrecision = createOcioWebGpuResources(
      { ...device, features: new Set() },
      pipeline,
      shaderInfo,
      { texturePrecision: 'float16' },
    );
    assert.equal(lowPrecision.texturePrecision, 'float16');
    assert.equal(textureDescriptors.at(-1).format, 'r16float');
    lowPrecision.dispose();
  } finally {
    if (previousBufferUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = previousBufferUsage;
    if (previousTextureUsage === undefined) delete globalThis.GPUTextureUsage;
    else globalThis.GPUTextureUsage = previousTextureUsage;
  }
});

test('WebGPU resource helper cleans up partial allocations on failure', () => {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousTextureUsage = globalThis.GPUTextureUsage;
  globalThis.GPUBufferUsage = { COPY_DST: 1, UNIFORM: 2 };
  globalThis.GPUTextureUsage = { COPY_DST: 4, TEXTURE_BINDING: 8 };

  let destroyed = 0;
  const device = {
    features: new Set(),
    queue: { writeBuffer() {}, writeTexture() {} },
    createBuffer: () => ({ destroy: () => { destroyed += 1; } }),
    createTexture: () => ({ createView: () => ({}), destroy: () => { destroyed += 1; } }),
    createSampler: () => ({}),
    createBindGroup: () => { throw new Error('bind group failed'); },
  };
  const shaderInfo = createShaderInfo({
    uniformBufferSize: 16,
    uniformBinding: { group: 0, binding: 0 },
    uniforms: [{ name: 'value', type: 'double', bufferOffset: 0, value: 1 }],
  });

  try {
    assert.throws(
      () => createOcioWebGpuResources(device, { getBindGroupLayout: () => ({}) }, shaderInfo),
      /bind group failed/,
    );
    assert.equal(destroyed, 1);
  } finally {
    if (previousBufferUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = previousBufferUsage;
    if (previousTextureUsage === undefined) delete globalThis.GPUTextureUsage;
    else globalThis.GPUTextureUsage = previousTextureUsage;
  }
});
