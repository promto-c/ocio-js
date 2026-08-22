import { translateGlslFragmentToWgsl } from '#naga-runtime';

const COMBINED_SAMPLER_PATTERN = /layout\s*\(\s*set\s*=\s*(\d+)\s*,\s*binding\s*=\s*(\d+)\s*\)\s*uniform\s+sampler([123])D\s+([A-Za-z_]\w*)\s*;/g;
const UNIFORM_BLOCK_PATTERN = /layout\s*\(\s*set\s*=\s*(\d+)\s*,\s*binding\s*=\s*(\d+)\s*\)\s*uniform\s+[A-Za-z_]\w*\s*\{/;

function replaceIdentifierCall(source, functionName, replacementName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`\\btexture\\s*\\(\\s*${escapedName}\\s*,`, 'g'), `texture(${replacementName},`);
}

export function normalizeOcioVulkanGlsl(shaderInfo) {
  let source = shaderInfo.shaderText.trim();
  if (!source.startsWith('#version')) {
    source = `#version 460\n${source}`;
  }

  // Naga's GLSL frontend cannot validate stores through nested swizzles such as
  // `color.rgb.r`. These are exactly equivalent to direct component access.
  source = source
    .replace(/\.rgb\.r\b/g, '.r')
    .replace(/\.rgb\.g\b/g, '.g')
    .replace(/\.rgb\.b\b/g, '.b');

  const declarations = [...source.matchAll(COMBINED_SAMPLER_PATTERN)];
  const maxBindingByGroup = new Map();
  for (const match of declarations) {
    const group = Number(match[1]);
    const binding = Number(match[2]);
    maxBindingByGroup.set(group, Math.max(maxBindingByGroup.get(group) ?? -1, binding));
  }

  const textureBySampler = new Map(shaderInfo.textures.map((texture) => [texture.samplerName, texture]));
  const bindings = new Map();

  source = source.replace(COMBINED_SAMPLER_PATTERN, (declaration, groupText, bindingText, dimensionsText, samplerName) => {
    const group = Number(groupText);
    const textureBinding = Number(bindingText);
    const texture = textureBySampler.get(samplerName);
    if (!texture) {
      throw new Error(`OCIO WebGPU normalization could not match sampler ${samplerName} to texture metadata`);
    }

    const dimensions = Number(dimensionsText);
    const samplerBinding = (maxBindingByGroup.get(group) ?? textureBinding) + 1;
    maxBindingByGroup.set(group, samplerBinding);
    bindings.set(samplerName, {
      texture: { group, binding: textureBinding },
      sampler: { group, binding: samplerBinding }
    });

    return `layout(set=${group}, binding=${textureBinding}) uniform texture${dimensions}D ${texture.name};\n`
      + `layout(set=${group}, binding=${samplerBinding}) uniform sampler ${samplerName};`;
  });

  for (const samplerName of bindings.keys()) {
    const texture = textureBySampler.get(samplerName);
    const dimensions = texture.dimensions;
    const combinedSampler = `sampler${dimensions}D(${texture.name}, ${samplerName})`;
    source = replaceIdentifierCall(source, samplerName, combinedSampler);
  }

  const functionName = shaderInfo.functionName;
  source += `\nlayout(location=0) out vec4 ocio_naga_output;\nvoid main() { ocio_naga_output = ${functionName}(vec4(0.0)); }\n`;

  const uniformMatch = source.match(UNIFORM_BLOCK_PATTERN);
  const uniformBinding = uniformMatch
    ? { group: Number(uniformMatch[1]), binding: Number(uniformMatch[2]) }
    : null;

  return {
    source,
    uniformBinding,
    textureBindings: bindings
  };
}

export async function buildWebGpuShaderInfo(shaderInfo) {
  const normalized = normalizeOcioVulkanGlsl(shaderInfo);
  const shaderText = await translateGlslFragmentToWgsl(normalized.source);
  return {
    shaderText,
    sourceShaderText: shaderInfo.shaderText,
    functionName: shaderInfo.functionName,
    language: 'wgsl',
    sourceLanguage: shaderInfo.language,
    cacheId: shaderInfo.cacheId,
    uniformBufferSize: shaderInfo.uniformBufferSize,
    uniformBinding: normalized.uniformBinding,
    textures: shaderInfo.textures.map((texture) => ({
      ...texture,
      ...normalized.textureBindings.get(texture.samplerName)
    })),
    uniforms: shaderInfo.uniforms
  };
}
