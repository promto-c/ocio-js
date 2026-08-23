const TEXTURE_PRECISIONS = new Set(['float32', 'float16']);

function resolveTexturePrecision(options) {
  const precision = options.texturePrecision ?? 'float32';
  if (!TEXTURE_PRECISIONS.has(precision)) {
    throw new TypeError(`texturePrecision must be "float32" or "float16", received ${precision}`);
  }
  return precision;
}

function assertWebGpuShaderInfo(shaderInfo) {
  if (!shaderInfo || shaderInfo.language !== 'wgsl') {
    throw new TypeError('shaderInfo must be WebGpuShaderInfo returned by processor.getWebGpuShaderInfo()');
  }
}

export function getOcioWebGpuRequiredFeatures(shaderInfo, options = {}) {
  assertWebGpuShaderInfo(shaderInfo);
  const precision = resolveTexturePrecision(options);
  const needsFilterableFloat32 = precision === 'float32'
    && shaderInfo.textures.some((texture) => texture.interpolation !== 'nearest');
  return needsFilterableFloat32 ? ['float32-filterable'] : [];
}

export function getOcioWebGpuNextBindGroupIndex(shaderInfo) {
  assertWebGpuShaderInfo(shaderInfo);
  const groups = [];
  if (shaderInfo.uniformBinding) groups.push(shaderInfo.uniformBinding.group);
  for (const texture of shaderInfo.textures) {
    groups.push(texture.texture.group, texture.sampler.group);
  }
  return (groups.length ? Math.max(...groups) : -1) + 1;
}

export function packOcioWebGpuUniforms(shaderInfo) {
  assertWebGpuShaderInfo(shaderInfo);
  const buffer = new ArrayBuffer(Math.max(0, shaderInfo.uniformBufferSize));
  const view = new DataView(buffer);

  const writeValues = (uniform, values, integer = false) => {
    values.forEach((value, index) => {
      const position = uniform.bufferOffset + index * 4;
      if (position + 4 > buffer.byteLength) {
        throw new RangeError(`OCIO uniform ${uniform.name} exceeds the declared ${buffer.byteLength}-byte uniform buffer`);
      }
      if (integer) view.setInt32(position, Number(value), true);
      else view.setFloat32(position, Number(value), true);
    });
  };

  for (const uniform of shaderInfo.uniforms) {
    const values = Array.isArray(uniform.value) ? uniform.value : [uniform.value];
    if (uniform.type === 'bool') {
      writeValues(uniform, [uniform.value ? 1 : 0], true);
    } else if (uniform.type === 'vector_int') {
      writeValues(uniform, values, true);
    } else if (uniform.type === 'unknown') {
      throw new TypeError(`Cannot pack unsupported OCIO GPU uniform type for ${uniform.name}`);
    } else {
      writeValues(uniform, values);
    }
  }
  return new Uint8Array(buffer);
}

export function createOcioWebGpuResources(device, pipeline, shaderInfo, options = {}) {
  assertWebGpuShaderInfo(shaderInfo);
  const bufferUsage = globalThis.GPUBufferUsage;
  const textureUsage = globalThis.GPUTextureUsage;
  if (!bufferUsage || !textureUsage) {
    throw new Error('WebGPU GPUBufferUsage/GPUTextureUsage globals are unavailable in this runtime');
  }
  const texturePrecision = resolveTexturePrecision(options);
  const requiredFeatures = getOcioWebGpuRequiredFeatures(shaderInfo, { texturePrecision });
  for (const feature of requiredFeatures) {
    if (!device.features?.has(feature)) {
      throw new Error(
        `OCIO WebGPU ${texturePrecision} LUT sampling requires GPU feature "${feature}". `
        + 'Request it when creating the device, or explicitly choose texturePrecision: "float16".'
      );
    }
  }

  const entriesByGroup = new Map();
  const destroyables = [];
  const addEntry = (group, entry) => {
    if (!entriesByGroup.has(group)) entriesByGroup.set(group, []);
    entriesByGroup.get(group).push(entry);
  };
  const destroyAll = () => {
    for (const resource of destroyables.splice(0)) resource.destroy();
  };

  try {
    if (shaderInfo.uniformBinding) {
      const bytes = packOcioWebGpuUniforms(shaderInfo);
      const buffer = device.createBuffer({
        label: 'OCIO uniforms',
        size: Math.max(16, alignTo(bytes.byteLength, 16)),
        usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM
      });
      destroyables.push(buffer);
      if (bytes.byteLength) device.queue.writeBuffer(buffer, 0, bytes);
      addEntry(shaderInfo.uniformBinding.group, {
        binding: shaderInfo.uniformBinding.binding,
        resource: { buffer }
      });
    }

    for (const textureInfo of shaderInfo.textures) {
      const uploaded = createOcioWebGpuTexture(device, textureInfo, texturePrecision, textureUsage);
      destroyables.push(uploaded.texture);
      addEntry(textureInfo.texture.group, {
        binding: textureInfo.texture.binding,
        resource: uploaded.texture.createView()
      });
      addEntry(textureInfo.sampler.group, {
        binding: textureInfo.sampler.binding,
        resource: uploaded.sampler
      });
    }

    const bindGroups = new Map();
    for (const [group, entries] of entriesByGroup) {
      bindGroups.set(group, device.createBindGroup({
        label: `OCIO resources group ${group}`,
        layout: pipeline.getBindGroupLayout(group),
        entries
      }));
    }

    let disposed = false;
    return {
      bindGroups,
      texturePrecision,
      dispose() {
        if (disposed) return;
        disposed = true;
        destroyAll();
      }
    };
  } catch (error) {
    destroyAll();
    throw error;
  }
}

function createOcioWebGpuTexture(device, textureInfo, texturePrecision, textureUsage) {
  if (textureInfo.dimensions !== 2 && textureInfo.dimensions !== 3) {
    throw new Error(`Unsupported OCIO WebGPU texture dimension: ${textureInfo.dimensions}`);
  }

  const useFloat32 = texturePrecision === 'float32';
  const componentCount = textureInfo.channels === 1 ? 1 : 4;
  const format = textureInfo.channels === 1
    ? (useFloat32 ? 'r32float' : 'r16float')
    : (useFloat32 ? 'rgba32float' : 'rgba16float');
  const data = convertTextureValues(textureInfo, useFloat32);
  const bytesPerComponent = useFloat32 ? 4 : 2;
  const texture = device.createTexture({
    label: textureInfo.name,
    size: {
      width: textureInfo.width,
      height: textureInfo.height,
      depthOrArrayLayers: textureInfo.dimensions === 3 ? textureInfo.depth : 1
    },
    dimension: textureInfo.dimensions === 3 ? '3d' : '2d',
    format,
    usage: textureUsage.COPY_DST | textureUsage.TEXTURE_BINDING
  });
  try {
    device.queue.writeTexture(
      { texture },
      data,
      {
        bytesPerRow: textureInfo.width * componentCount * bytesPerComponent,
        rowsPerImage: textureInfo.height
      },
      {
        width: textureInfo.width,
        height: textureInfo.height,
        depthOrArrayLayers: textureInfo.dimensions === 3 ? textureInfo.depth : 1
      }
    );

    const filter = textureInfo.interpolation === 'nearest' ? 'nearest' : 'linear';
    const sampler = device.createSampler({
      label: textureInfo.samplerName,
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge'
    });
    return { texture, sampler };
  } catch (error) {
    texture.destroy();
    throw error;
  }
}

function convertTextureValues(textureInfo, useFloat32) {
  const values = textureInfo.values;
  let expanded = values;
  if (textureInfo.channels === 3) {
    expanded = new Float32Array((values.length / 3) * 4);
    for (let source = 0, target = 0; source < values.length; source += 3, target += 4) {
      expanded[target] = values[source];
      expanded[target + 1] = values[source + 1];
      expanded[target + 2] = values[source + 2];
      expanded[target + 3] = 1;
    }
  }
  if (useFloat32) return expanded;

  const half = new Uint16Array(expanded.length);
  for (let index = 0; index < expanded.length; index += 1) {
    half[index] = float32ToFloat16(expanded[index]);
  }
  return half;
}

function float32ToFloat16(value) {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;

  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | (mantissa ? 0x7e00 : 0x7c00);
  mantissa += 0x1000;
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
