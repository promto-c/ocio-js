import { ACES_CG_V2_CONFIG, createOCIO } from '@bb-studio/ocio';

const width = 960;
const height = 540;

const elements = {
  canvas: document.querySelector('#canvas'),
  webgpuCanvas: document.querySelector('#webgpuCanvas'),
  cpuCanvas: document.querySelector('#cpuCanvas'),
  status: document.querySelector('#status'),
  version: document.querySelector('#version'),
  source: document.querySelector('#source'),
  display: document.querySelector('#display'),
  view: document.querySelector('#view'),
  exposure: document.querySelector('#exposure'),
  exposureValue: document.querySelector('#exposureValue'),
  gain: document.querySelector('#gain'),
  gainValue: document.querySelector('#gainValue'),
  gamma: document.querySelector('#gamma'),
  gammaValue: document.querySelector('#gammaValue'),
  imageFile: document.querySelector('#imageFile'),
  reset: document.querySelector('#reset'),
  builtinConfig: document.querySelector('#builtinConfig'),
  loadOcioFile: document.querySelector('#loadOcioFile'),
  loadConfigFolder: document.querySelector('#loadConfigFolder'),
  resetConfig: document.querySelector('#resetConfig'),
  configInfo: document.querySelector('#configInfo'),
  rendererPath: document.querySelector('#rendererPath'),
  rendererInfo: document.querySelector('#rendererInfo'),
  shaderInspector: document.querySelector('#shaderInspector'),
  shaderSummary: document.querySelector('#shaderSummary'),
  shaderView: document.querySelector('#shaderView'),
  shaderCode: document.querySelector('#shaderCode')
};

const ocioFileInput = document.createElement('input');
ocioFileInput.type = 'file';
ocioFileInput.accept = '.ocio';
ocioFileInput.style.display = 'none';
document.body.appendChild(ocioFileInput);

let ocio;
let config;
let processor;
const cpuContext = elements.cpuCanvas.getContext('2d');
const webglRenderer = createWebGLRenderer(elements.canvas);
let webgpuRenderer = null;
let webgpuInitError = null;
let sourcePixels = createSamplePixels(width, height);
let renderRevision = 0;
let shaderInspection = createCpuShaderInspection();

function createWebGLRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
  if (!gl) {
    return null;
  }

  const vertexShaderSource = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
out vec2 v_uv;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_uv;
}`;

  const passthroughFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_image;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_image, v_uv);
}`;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const quadVertices = new Float32Array([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    -1, 1, 0, 0,
    1, -1, 1, 1,
    1, 1, 1, 0
  ]);

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  const supportsLinearFloatTextures = Boolean(gl.getExtension('OES_texture_float_linear'));
  const programCache = new Map();
  const passthroughProgram = createProgram(gl, vertexShader, passthroughFragmentSource);
  let sourceTexture = null;
  let ocioTextures = [];

  function getOcioProgram(shaderInfo, fragmentSource) {
    const key = shaderInfo.cacheId || shaderInfo.shaderText;
    if (!programCache.has(key)) {
      programCache.set(key, createProgram(gl, vertexShader, fragmentSource));
    }
    return programCache.get(key);
  }

  function bindSourceTexture(pixels, type = gl.FLOAT) {
    if (!sourceTexture) {
      sourceTexture = gl.createTexture();
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (type === gl.FLOAT) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, pixels);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    checkGLError(gl, 'source texture upload');
  }

  function deleteOcioTextures() {
    for (const texture of ocioTextures) {
      gl.deleteTexture(texture);
    }
    ocioTextures = [];
  }

  function uploadOcioTextures(shaderInfo) {
    if (shaderInfo.textures.length + 1 > maxTextureUnits) {
      throw new Error(`OCIO GPU shader needs ${shaderInfo.textures.length + 1} texture units, but WebGL exposes ${maxTextureUnits}`);
    }
    if (!supportsLinearFloatTextures && shaderInfo.textures.some((texture) => texture.interpolation !== 'nearest')) {
      throw new Error('WebGL float texture linear filtering is unavailable');
    }

    deleteOcioTextures();
    shaderInfo.textures.forEach((texture, index) => {
      if (texture.dimensions === 1) {
        throw new Error('WebGL does not support 1D OCIO LUT textures');
      }

      const unit = index + 1;
      const target = texture.dimensions === 3 ? gl.TEXTURE_3D : gl.TEXTURE_2D;
      const gpuTexture = gl.createTexture();
      const format = texture.channels === 1
        ? { internal: gl.R32F, external: gl.RED }
        : { internal: gl.RGB32F, external: gl.RGB };

      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, gpuTexture);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, texture.interpolation === 'nearest' ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, texture.interpolation === 'nearest' ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (target === gl.TEXTURE_3D) {
        gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        gl.texImage3D(
          target,
          0,
          format.internal,
          texture.width,
          texture.height,
          texture.depth,
          0,
          format.external,
          gl.FLOAT,
          texture.values
        );
      } else {
        gl.texImage2D(
          target,
          0,
          format.internal,
          texture.width,
          texture.height,
          0,
          format.external,
          gl.FLOAT,
          texture.values
        );
      }
      checkGLError(gl, `OCIO texture upload: ${texture.name}`);
      ocioTextures.push(gpuTexture);
    });
  }

  function bindOcioUniforms(program, shaderInfo, params) {
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_exposureScale'), params.exposureScale);
    gl.uniform1f(gl.getUniformLocation(program, 'u_inverseGamma'), params.inverseGamma);

    shaderInfo.textures.forEach((texture, index) => {
      const location = gl.getUniformLocation(program, texture.samplerName);
      if (location) {
        gl.uniform1i(location, index + 1);
      }
    });

    shaderInfo.uniforms.forEach((uniform) => {
      const location = gl.getUniformLocation(program, uniform.name);
      if (!location) {
        return;
      }
      if (uniform.type === 'bool') {
        gl.uniform1i(location, uniform.value ? 1 : 0);
      } else if (uniform.type === 'float3') {
        gl.uniform3fv(location, new Float32Array(uniform.value));
      } else if (uniform.type === 'vector_float') {
        gl.uniform1fv(location, new Float32Array(uniform.value));
      } else if (uniform.type === 'vector_int') {
        gl.uniform1iv(location, new Int32Array(uniform.value));
      } else if (typeof uniform.value === 'number') {
        gl.uniform1f(location, uniform.value);
      }
    });
  }

  function draw(program) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  return {
    renderOcio(processorHandle, pixels, params) {
      const shaderInfo = processorHandle.getGpuShaderInfo({
        language: 'glsl_es_3.0',
        functionName: 'OCIODisplay',
        resourcePrefix: 'ocio',
        textureMaxWidth: maxTextureSize,
        allowTexture1D: false
      });
      const usedShader = buildOcioFragmentShader(shaderInfo);
      const program = getOcioProgram(shaderInfo, usedShader);
      bindSourceTexture(pixels, gl.FLOAT);
      uploadOcioTextures(shaderInfo);
      gl.useProgram(program);
      bindOcioUniforms(program, shaderInfo, params);
      draw(program);
      checkGLError(gl, 'OCIO WebGL render');
      return { shaderInfo, usedShader };
    },

    renderBytes(bytes) {
      bindSourceTexture(bytes, gl.UNSIGNED_BYTE);
      gl.useProgram(passthroughProgram);
      gl.uniform1i(gl.getUniformLocation(passthroughProgram, 'u_image'), 0);
      draw(passthroughProgram);
    }
  };
}

function buildOcioFragmentShader(shaderInfo) {
  return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_image;
uniform float u_exposureScale;
uniform float u_inverseGamma;
in vec2 v_uv;
out vec4 fragColor;

${shaderInfo.shaderText}

void main() {
  vec4 color = texture(u_image, v_uv);
  color.rgb = pow(max(color.rgb * u_exposureScale, vec3(0.0)), vec3(u_inverseGamma));
  fragColor = ${shaderInfo.functionName}(color);
}`;
}

async function createWebGPURenderer(canvas, adapter) {
  const requiredFeatures = adapter.features.has('float32-filterable')
    ? ['float32-filterable']
    : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('WebGPU canvas context is unavailable');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const sourceTexture = device.createTexture({
    label: 'OCIO demo source',
    size: { width, height },
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
  });
  const toneBuffer = device.createBuffer({
    label: 'OCIO demo tone controls',
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
  });
  const programCache = new Map();
  const useFloat32Luts = device.features.has('float32-filterable');

  async function getProgram(processorHandle) {
    const key = processorHandle.cacheId;
    if (!programCache.has(key)) {
      const pending = (async () => {
        const shaderInfo = await processorHandle.getWebGpuShaderInfo({
          functionName: 'OCIODisplay',
          resourcePrefix: 'ocio_webgpu'
        });
        const viewerGroup = getWebGpuViewerGroup(shaderInfo);
        const viewerShader = buildWebGpuViewerShader(shaderInfo, viewerGroup);
        const usedShader = `${shaderInfo.shaderText}\n\n${viewerShader}`;
        const module = device.createShaderModule({
          label: 'OCIO demo WGSL',
          code: usedShader
        });
        await assertWebGpuShaderModule(module);

        const descriptor = {
          label: 'OCIO demo pipeline',
          layout: 'auto',
          vertex: { module, entryPoint: 'viewer_vertex' },
          fragment: {
            module,
            entryPoint: 'viewer_fragment',
            targets: [{ format }]
          },
          primitive: { topology: 'triangle-list' }
        };
        const pipeline = device.createRenderPipelineAsync
          ? await device.createRenderPipelineAsync(descriptor)
          : device.createRenderPipeline(descriptor);
        const ocioBindGroups = createWebGpuOcioBindGroups(
          device,
          pipeline,
          shaderInfo,
          useFloat32Luts
        );
        const viewerBindGroup = device.createBindGroup({
          label: 'OCIO demo viewer resources',
          layout: pipeline.getBindGroupLayout(viewerGroup),
          entries: [
            { binding: 0, resource: sourceTexture.createView() },
            { binding: 1, resource: { buffer: toneBuffer } }
          ]
        });

        return {
          shaderInfo,
          usedShader,
          pipeline,
          ocioBindGroups,
          viewerBindGroup,
          viewerGroup
        };
      })();
      programCache.set(key, pending);
      pending.catch(() => programCache.delete(key));
    }
    return programCache.get(key);
  }

  return {
    device,
    useFloat32Luts,

    async renderOcio(processorHandle, pixels, params) {
      const program = await getProgram(processorHandle);
      device.queue.writeTexture(
        { texture: sourceTexture },
        pixels,
        { bytesPerRow: width * 4 * Float32Array.BYTES_PER_ELEMENT, rowsPerImage: height },
        { width, height }
      );
      device.queue.writeBuffer(
        toneBuffer,
        0,
        new Float32Array([params.exposureScale, params.inverseGamma, 0, 0])
      );

      const encoder = device.createCommandEncoder({ label: 'OCIO demo frame' });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
      pass.setPipeline(program.pipeline);
      for (const [group, bindGroup] of program.ocioBindGroups) {
        pass.setBindGroup(group, bindGroup);
      }
      pass.setBindGroup(program.viewerGroup, program.viewerBindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);

      return {
        shaderInfo: program.shaderInfo,
        usedShader: program.usedShader,
        texturePrecision: useFloat32Luts ? 'float32' : 'float16'
      };
    }
  };
}

function getWebGpuViewerGroup(shaderInfo) {
  const groups = [];
  if (shaderInfo.uniformBinding) {
    groups.push(shaderInfo.uniformBinding.group);
  }
  for (const texture of shaderInfo.textures) {
    groups.push(texture.texture.group, texture.sampler.group);
  }
  return (groups.length ? Math.max(...groups) : -1) + 1;
}

function buildWebGpuViewerShader(shaderInfo, viewerGroup) {
  return `struct ViewerTone {
  exposure_scale: f32,
  inverse_gamma: f32,
  padding: vec2<f32>,
};

@group(${viewerGroup}) @binding(0) var viewer_source: texture_2d<f32>;
@group(${viewerGroup}) @binding(1) var<uniform> viewer_tone: ViewerTone;

@vertex
fn viewer_vertex(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn viewer_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  var color = textureLoad(viewer_source, vec2<i32>(position.xy), 0);
  color.rgb = pow(
    max(color.rgb * viewer_tone.exposure_scale, vec3<f32>(0.0)),
    vec3<f32>(viewer_tone.inverse_gamma),
  );
  return ${shaderInfo.functionName}(color);
}`;
}

async function assertWebGpuShaderModule(module) {
  if (typeof module.getCompilationInfo !== 'function') {
    return;
  }
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === 'error');
  if (errors.length) {
    const detail = errors.slice(0, 3).map((message) => {
      const location = message.lineNum ? `line ${message.lineNum}: ` : '';
      return `${location}${message.message}`;
    }).join('\n');
    throw new Error(`WebGPU WGSL compilation failed: ${detail}`);
  }
}

function createWebGpuOcioBindGroups(device, pipeline, shaderInfo, useFloat32) {
  const entriesByGroup = new Map();
  const retain = [];
  const addEntry = (group, entry) => {
    if (!entriesByGroup.has(group)) {
      entriesByGroup.set(group, []);
    }
    entriesByGroup.get(group).push(entry);
  };

  if (shaderInfo.uniformBinding) {
    const bytes = packWebGpuUniforms(shaderInfo);
    const buffer = device.createBuffer({
      label: 'OCIO uniforms',
      size: Math.max(16, alignTo(bytes.byteLength, 16)),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
    device.queue.writeBuffer(buffer, 0, bytes);
    retain.push(buffer);
    addEntry(shaderInfo.uniformBinding.group, {
      binding: shaderInfo.uniformBinding.binding,
      resource: { buffer }
    });
  }

  for (const texture of shaderInfo.textures) {
    const uploaded = createWebGpuOcioTexture(device, texture, useFloat32);
    retain.push(uploaded.texture, uploaded.sampler);
    addEntry(texture.texture.group, {
      binding: texture.texture.binding,
      resource: uploaded.texture.createView()
    });
    addEntry(texture.sampler.group, {
      binding: texture.sampler.binding,
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
  bindGroups.retain = retain;
  return bindGroups;
}

function createWebGpuOcioTexture(device, textureInfo, useFloat32) {
  if (textureInfo.dimensions !== 2 && textureInfo.dimensions !== 3) {
    throw new Error(`Unsupported OCIO WebGPU texture dimension: ${textureInfo.dimensions}`);
  }

  const componentCount = textureInfo.channels === 1 ? 1 : 4;
  const format = textureInfo.channels === 1
    ? (useFloat32 ? 'r32float' : 'r16float')
    : (useFloat32 ? 'rgba32float' : 'rgba16float');
  const data = convertWebGpuTextureValues(textureInfo, useFloat32);
  const bytesPerComponent = useFloat32 ? 4 : 2;
  const gpuTexture = device.createTexture({
    label: textureInfo.name,
    size: {
      width: textureInfo.width,
      height: textureInfo.height,
      depthOrArrayLayers: textureInfo.dimensions === 3 ? textureInfo.depth : 1
    },
    dimension: textureInfo.dimensions === 3 ? '3d' : '2d',
    format,
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
  });
  device.queue.writeTexture(
    { texture: gpuTexture },
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
  return { texture: gpuTexture, sampler };
}

function convertWebGpuTextureValues(textureInfo, useFloat32) {
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
  if (useFloat32) {
    return expanded;
  }

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
  if (exponent >= 31) {
    return sign | (mantissa ? 0x7e00 : 0x7c00);
  }
  mantissa += 0x1000;
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

function packWebGpuUniforms(shaderInfo) {
  const size = Math.max(0, shaderInfo.uniformBufferSize);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const writeValues = (offset, values, integer = false) => {
    values.forEach((value, index) => {
      const position = offset + index * 4;
      if (position + 4 > buffer.byteLength) return;
      if (integer) view.setInt32(position, Number(value), true);
      else view.setFloat32(position, Number(value), true);
    });
  };

  for (const uniform of shaderInfo.uniforms) {
    const values = Array.isArray(uniform.value) ? uniform.value : [uniform.value];
    if (uniform.type === 'bool') {
      writeValues(uniform.bufferOffset, [uniform.value ? 1 : 0], true);
    } else if (uniform.type === 'vector_int') {
      writeValues(uniform.bufferOffset, values, true);
    } else {
      writeValues(uniform.bufferOffset, values);
    }
  }
  return new Uint8Array(buffer);
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'WebGL shader compilation failed');
  }
  return shader;
}

function createProgram(gl, vertexShader, fragmentSource) {
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log || 'WebGL shader link failed');
  }
  return program;
}

function checkGLError(gl, label) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`${label} failed with WebGL error 0x${error.toString(16)}`);
  }
}

function createCpuShaderInspection(detail = 'CPU · WASM') {
  return {
    path: 'cpu',
    summary: detail,
    source: 'CPU/WASM processing does not generate a GPU shader.',
    generated: 'CPU/WASM processing does not generate a GPU shader.',
    used: 'processor.applyRGBAF32(...) executes the OpenColorIO CPU processor in WebAssembly.',
    resources: JSON.stringify({ path: 'cpu', shader: null }, null, 2)
  };
}

function createGpuShaderInspection(path, result) {
  const info = result.shaderInfo;
  const isWebGpu = path === 'webgpu';
  const resources = {
    path,
    language: info.language,
    sourceLanguage: isWebGpu ? info.sourceLanguage : info.language,
    functionName: info.functionName,
    cacheId: info.cacheId,
    uniformBufferSize: info.uniformBufferSize,
    uniformBinding: info.uniformBinding ?? null,
    textures: info.textures.map((texture) => ({
      name: texture.name,
      samplerName: texture.samplerName,
      size: [texture.width, texture.height, texture.depth],
      dimensions: texture.dimensions,
      channels: texture.channels,
      interpolation: texture.interpolation,
      textureBinding: texture.texture ?? null,
      samplerBinding: texture.sampler ?? null
    })),
    uniforms: info.uniforms,
    ...(result.texturePrecision ? { texturePrecision: result.texturePrecision } : {})
  };

  return {
    path,
    summary: isWebGpu
      ? `WebGPU · WGSL · ${info.textures.length} LUTs`
      : `WebGL 2 · GLSL ES 3.0 · ${info.textures.length} LUTs`,
    source: isWebGpu ? info.sourceShaderText : info.shaderText,
    generated: info.shaderText,
    used: result.usedShader,
    resources: JSON.stringify(resources, null, 2)
  };
}

function updateShaderInspection(inspection) {
  shaderInspection = inspection;
  renderShaderInspector();
}

function renderShaderInspector() {
  const labels = {
    cpu: {
      used: 'CPU path',
      generated: 'Generated shader',
      source: 'OCIO source',
      resources: 'Resources'
    },
    webgl2: {
      used: 'Final GLSL used',
      generated: 'OCIO GLSL',
      source: 'OCIO GLSL source',
      resources: 'Resources'
    },
    webgpu: {
      used: 'Final WGSL used',
      generated: 'Naga WGSL',
      source: 'OCIO Vulkan GLSL',
      resources: 'Resources'
    }
  }[shaderInspection.path];

  for (const option of elements.shaderView.options) {
    option.textContent = labels[option.value];
  }
  elements.shaderSummary.textContent = shaderInspection.summary;
  elements.shaderCode.textContent = shaderInspection[elements.shaderView.value];
}

function showRendererCanvas(path) {
  const active = path === 'webgpu'
    ? elements.webgpuCanvas
    : path === 'webgl2'
      ? elements.canvas
      : elements.cpuCanvas;
  for (const canvas of [elements.canvas, elements.webgpuCanvas, elements.cpuCanvas]) {
    canvas.hidden = canvas !== active;
  }
}

async function initializeRendererSupport() {
  const webglOption = elements.rendererPath.querySelector('option[value="webgl2"]');
  const webgpuOption = elements.rendererPath.querySelector('option[value="webgpu"]');
  webglOption.disabled = !webglRenderer;

  if (!navigator.gpu) {
    webgpuInitError = 'navigator.gpu is unavailable';
    webgpuOption.disabled = true;
    updateRendererInfo();
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new Error('No WebGPU adapter was returned');
    }
    webgpuRenderer = await createWebGPURenderer(elements.webgpuCanvas, adapter);
    webgpuOption.disabled = false;
  } catch (error) {
    webgpuInitError = error instanceof Error ? error.message : String(error);
    webgpuOption.disabled = true;
  }
  updateRendererInfo();
}

function updateRendererInfo() {
  const rows = [
    ['WebGPU · WGSL', Boolean(webgpuRenderer), webgpuInitError],
    ['WebGL 2 · GLSL ES 3.0', Boolean(webglRenderer), webglRenderer ? '' : 'unavailable'],
    ['CPU · WASM', true, 'always available']
  ];
  elements.rendererInfo.replaceChildren(...rows.map(([label, available, detail]) => {
    const row = document.createElement('div');
    row.className = available ? 'available' : 'unavailable';
    const suffix = detail ? ` — ${detail}` : '';
    row.textContent = `${available ? '✓' : '–'} ${label}${suffix}`;
    return row;
  }));
}

function resolveRendererPath() {
  const requested = elements.rendererPath.value;
  if (requested === 'auto') {
    if (webgpuRenderer) return 'webgpu';
    if (webglRenderer) return 'webgl2';
    return 'cpu';
  }
  if (requested === 'webgpu' && !webgpuRenderer) {
    throw new Error(`WebGPU is unavailable${webgpuInitError ? `: ${webgpuInitError}` : ''}`);
  }
  if (requested === 'webgl2' && !webglRenderer) {
    throw new Error('WebGL 2 is unavailable');
  }
  return requested;
}

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`.trim();
}

function fillSelect(select, values, selected) {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    return option;
  }));
}

function chooseDefaultSource(colorSpaces) {
  const names = colorSpaces.filter((cs) => !cs.isData).map((cs) => cs.name);
  return names.find((name) => name === 'ACEScg')
    ?? names.find((name) => /linear.*rec\.?709|srgb/i.test(name))
    ?? names[0];
}

async function switchConfig(newConfig) {
  processor?.dispose();
  config?.dispose();
  config = newConfig;

  const colorSpaces = config.listColorSpaces();
  const sourceNames = colorSpaces.filter((cs) => !cs.isData).map((cs) => cs.name);
  fillSelect(elements.source, sourceNames, chooseDefaultSource(colorSpaces));

  const displays = config.listDisplays();
  fillSelect(elements.display, displays, config.getDefaultDisplay() || displays[0]);

  updateViews();
  updateConfigInfo();
  await render();
}

function updateViews() {
  const display = elements.display.value;
  const views = config.listViews(display).map((view) => view.name);
  const defaultView = config.getDefaultView(display, elements.source.value) || views[0];
  fillSelect(elements.view, views, views.includes(elements.view.value) ? elements.view.value : defaultView);
}

function updateConfigInfo() {
  try {
    config.validate();
    const colorSpaces = config.listColorSpaces();
    const displays = config.listDisplays();
    const defaultDisplay = config.getDefaultDisplay() || displays[0];
    const views = config.listViews(defaultDisplay).map((v) => v.name);
    const roles = config.listRoles();

    elements.configInfo.innerHTML = `
      <div class="config-valid">✓ Config valid</div>
      <div class="config-stat">Roles: ${roles.length}</div>
      <div class="config-stat">Color spaces: ${colorSpaces.length}</div>
      <div class="config-stat">Displays: ${displays.join(', ')}</div>
      <div class="config-stat">Views (${defaultDisplay}): ${views.join(', ')}</div>
    `;
  } catch (error) {
    elements.configInfo.innerHTML = `
      <div class="config-error">✗ ${error.message}</div>
    `;
  }
}

function rebuildProcessor() {
  processor?.dispose();
  processor = config.createDisplayViewProcessor({
    source: elements.source.value,
    display: elements.display.value,
    view: elements.view.value,
    optimization: 'lossless'
  });
}

function readToneControls() {
  const exposure = Number(elements.exposure.value);
  const gain = Number(elements.gain.value);
  const gamma = Number(elements.gamma.value);
  elements.exposureValue.value = exposure.toFixed(2);
  elements.gainValue.value = gain.toFixed(2);
  elements.gammaValue.value = gamma.toFixed(2);
  return {
    exposure,
    gain,
    gamma,
    exposureScale: gain * (2 ** exposure),
    inverseGamma: 1 / gamma
  };
}

function renderCpu(params) {
  const working = new Float32Array(sourcePixels);
  for (let index = 0; index < working.length; index += 4) {
    working[index] = Math.max(0, working[index] * params.exposureScale) ** params.inverseGamma;
    working[index + 1] = Math.max(0, working[index + 1] * params.exposureScale) ** params.inverseGamma;
    working[index + 2] = Math.max(0, working[index + 2] * params.exposureScale) ** params.inverseGamma;
  }

  processor.applyRGBAF32(working);

  const output = cpuContext.createImageData(width, height);
  for (let index = 0; index < working.length; index += 4) {
    output.data[index] = toByte(working[index]);
    output.data[index + 1] = toByte(working[index + 1]);
    output.data[index + 2] = toByte(working[index + 2]);
    output.data[index + 3] = toByte(working[index + 3]);
  }
  cpuContext.putImageData(output, 0, 0);
}

function renderStatus(renderer, detail = '') {
  const suffix = detail ? ` (${renderer}: ${detail})` : ` (${renderer})`;
  return `${elements.source.value} through ${elements.display.value} / ${elements.view.value}${suffix}`;
}

async function renderWithPath(path, params, revision) {
  if (path === 'webgpu') {
    const result = await webgpuRenderer.renderOcio(processor, sourcePixels, params);
    if (revision !== renderRevision) return false;
    showRendererCanvas('webgpu');
    updateShaderInspection(createGpuShaderInspection('webgpu', result));
    const detail = `${result.shaderInfo.textures.length} LUT textures · ${result.texturePrecision} LUT upload`;
    setStatus(renderStatus('WebGPU · WGSL', detail), 'ok');
    return true;
  }

  if (path === 'webgl2') {
    const result = webglRenderer.renderOcio(processor, sourcePixels, params);
    if (revision !== renderRevision) return false;
    showRendererCanvas('webgl2');
    updateShaderInspection(createGpuShaderInspection('webgl2', result));
    setStatus(renderStatus('WebGL 2 · GLSL ES 3.0', `${result.shaderInfo.textures.length} LUT textures`), 'ok');
    return true;
  }

  renderCpu(params);
  if (revision !== renderRevision) return false;
  showRendererCanvas('cpu');
  updateShaderInspection(createCpuShaderInspection());
  setStatus(renderStatus('CPU · WASM'), 'ok');
  return true;
}

async function render() {
  const revision = ++renderRevision;
  try {
    rebuildProcessor();
    const params = readToneControls();
    const requested = elements.rendererPath.value;
    const primaryPath = resolveRendererPath();

    try {
      const committed = await renderWithPath(primaryPath, params, revision);
      if (!committed) return;
    } catch (primaryError) {
      if (requested !== 'auto') {
        throw primaryError;
      }

      const fallbacks = primaryPath === 'webgpu'
        ? [webglRenderer ? 'webgl2' : null, 'cpu']
        : ['cpu'];
      let lastError = primaryError;
      for (const fallback of fallbacks.filter(Boolean)) {
        try {
          const committed = await renderWithPath(fallback, params, revision);
          if (!committed) return;
          const reason = primaryError instanceof Error
            ? primaryError.message.split('\n')[0]
            : String(primaryError);
          setStatus(`${renderStatus(fallback === 'webgl2' ? 'WebGL 2 fallback' : 'CPU fallback')} · ${reason}`, 'ok');
          return;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
      throw lastError;
    }

    if (revision !== renderRevision) {
      return;
    }
  } catch (error) {
    if (revision === renderRevision) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }
}

function toByte(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

function createSamplePixels(w, h) {
  const pixels = new Float32Array(w * h * 4);
  const patches = [
    [0.18, 0.18, 0.18],
    [0.9, 0.08, 0.04],
    [0.04, 0.7, 0.12],
    [0.05, 0.18, 1.2],
    [1.4, 0.78, 0.08],
    [0.62, 0.12, 0.9],
    [2.5, 2.5, 2.5],
    [0.02, 0.02, 0.02]
  ];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      const index = (y * w + x) * 4;
      let r = Math.max(0, 1.35 * u);
      let g = Math.max(0, 1.1 * v);
      let b = Math.max(0, 0.25 + 1.5 * (1 - u) * (1 - v));

      const barY = Math.floor((y - h * 0.63) / (h * 0.13));
      const barX = Math.floor((x - w * 0.08) / (w * 0.105));
      if (barY >= 0 && barY < 2 && barX >= 0 && barX < 4) {
        [r, g, b] = patches[barY * 4 + barX];
      }

      const dx = u - 0.72;
      const dy = v - 0.32;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 5.2);
      r += glow * 3.5;
      g += glow * 2.6;
      b += glow * 1.1;

      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 1;
    }
  }

  return pixels;
}

async function loadImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scratch = new OffscreenCanvas(width, height);
  const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
  scratchContext.fillStyle = 'black';
  scratchContext.fillRect(0, 0, width, height);

  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  scratchContext.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

  const image = scratchContext.getImageData(0, 0, width, height);
  const pixels = new Float32Array(width * height * 4);
  for (let index = 0; index < image.data.length; index += 4) {
    pixels[index] = image.data[index] / 255;
    pixels[index + 1] = image.data[index + 1] / 255;
    pixels[index + 2] = image.data[index + 2] / 255;
    pixels[index + 3] = image.data[index + 3] / 255;
  }
  sourcePixels = pixels;

  const srgb = Array.from(elements.source.options).find((option) => /sRGB Encoded Rec\.709/i.test(option.value));
  if (srgb) {
    elements.source.value = srgb.value;
  }
  updateViews();
  await render();
}

async function loadBuiltinConfig(name) {
  const newConfig = ocio.createBuiltinConfig(name);
  elements.builtinConfig.value = name.replace(/^ocio:\/\//, '');
  await switchConfig(newConfig);
}

async function loadBuiltinConfigs() {
  const configs = ocio.listBuiltinConfigs();
  const select = elements.builtinConfig;
  select.replaceChildren(...configs.map(({ name, uiName }) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = uiName;
    return option;
  }));
  select.value = ACES_CG_V2_CONFIG.replace(/^ocio:\/\//, '');
}

async function writeDirectoryToFs(directoryHandle, basePath) {
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    entries.push({ name, handle });
  }
  for (const { name, handle } of entries) {
    const path = `${basePath}/${name}`;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      ocio.writeFile(path, new Uint8Array(buffer));
    } else if (handle.kind === 'directory') {
      ocio.mkdirp(path);
      await writeDirectoryToFs(handle, path);
    }
  }
}

async function main() {
  ocio = await createOCIO();

  elements.version.textContent = `OCIO ${ocio.version}`;
  renderShaderInspector();
  await initializeRendererSupport();
  await loadBuiltinConfigs();
  await loadBuiltinConfig(ACES_CG_V2_CONFIG);
}

for (const element of [elements.source, elements.display]) {
  element.addEventListener('change', () => {
    updateViews();
    render();
  });
}

elements.rendererPath.addEventListener('change', render);
elements.shaderView.addEventListener('change', renderShaderInspector);
elements.view.addEventListener('change', render);
for (const element of [elements.exposure, elements.gain, elements.gamma]) {
  element.addEventListener('input', render);
}

elements.imageFile.addEventListener('change', () => {
  const file = elements.imageFile.files?.[0];
  if (file) {
    loadImageFile(file).catch((error) => setStatus(error.message, 'error'));
  }
});

elements.reset.addEventListener('click', () => {
  sourcePixels = createSamplePixels(width, height);
  elements.imageFile.value = '';
  render();
});

elements.builtinConfig.addEventListener('change', () => {
  loadBuiltinConfig(elements.builtinConfig.value).catch((error) => {
    setStatus(`Failed to switch config: ${error.message}`, 'error');
  });
});

elements.loadOcioFile.addEventListener('click', () => {
  ocioFileInput.value = '';
  ocioFileInput.click();
});

ocioFileInput.addEventListener('change', async () => {
  const file = ocioFileInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const newConfig = ocio.createConfigFromString(text);
    await switchConfig(newConfig);
    setStatus(`Loaded: ${file.name}`, 'ok');
  } catch (error) {
    setStatus(`Failed to load config: ${error.message}`, 'error');
  }
});

elements.loadConfigFolder.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    setStatus('Folder picker requires Chrome/Edge.', 'error');
    return;
  }

  try {
    const directoryHandle = await window.showDirectoryPicker({ mode: 'read' });
    let configFile = null;

    for await (const [name, handle] of directoryHandle.entries()) {
      if (name === 'config.ocio' && handle.kind === 'file') {
        configFile = await handle.getFile();
        break;
      }
    }

    if (!configFile) {
      setStatus('No config.ocio found in folder.', 'error');
      return;
    }

    const baseDir = '/user-config';
    await writeDirectoryToFs(directoryHandle, baseDir);
    const configText = await configFile.text();
    const newConfig = ocio.createConfigFromString(configText, { workingDir: baseDir });
    await switchConfig(newConfig);
    setStatus(`Loaded config folder: ${directoryHandle.name}`, 'ok');
  } catch (error) {
    if (error.name !== 'AbortError') {
      setStatus(`Failed to load folder: ${error.message}`, 'error');
    }
  }
});

elements.resetConfig.addEventListener('click', () => {
  loadBuiltinConfig(ACES_CG_V2_CONFIG).catch((error) => {
    setStatus(`Failed to reset: ${error.message}`, 'error');
  });
});

main().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), 'error');
});
