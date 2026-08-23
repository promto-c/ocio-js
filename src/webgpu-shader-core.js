const COMBINED_SAMPLER_PATTERN = /layout\s*\(([^)]*)\)\s*uniform\s+sampler([123])D\s+([A-Za-z_]\w*)\s*;/g;
const LAYOUT_PATTERN = /layout\s*\(([^)]*)\)/g;
const SET_PATTERN = /\bset\s*=\s*(\d+)/;
const BINDING_PATTERN = /\bbinding\s*=\s*(\d+)/;
const UNIFORM_BLOCK_PATTERN = /layout\s*\(([^)]*)\)\s*uniform\s+[A-Za-z_]\w*\s*\{/;
const WEBGPU_TRANSFORM_FUNCTION = 'ocio_js_webgpu_transform';

function replaceIdentifierCall(source, functionName, replacementName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`\\btexture\\s*\\(\\s*${escapedName}\\s*,`, 'g'), `texture(${replacementName},`);
}

function parseBindingLayout(layout) {
  const setMatch = layout.match(SET_PATTERN);
  const bindingMatch = layout.match(BINDING_PATTERN);
  if (!setMatch || !bindingMatch) return null;
  return { group: Number(setMatch[1]), binding: Number(bindingMatch[1]) };
}

function collectOccupiedBindings(source) {
  const occupiedByGroup = new Map();
  for (const match of source.matchAll(LAYOUT_PATTERN)) {
    const binding = parseBindingLayout(match[1]);
    if (!binding) continue;
    if (!occupiedByGroup.has(binding.group)) {
      occupiedByGroup.set(binding.group, new Set());
    }
    occupiedByGroup.get(binding.group).add(binding.binding);
  }
  return occupiedByGroup;
}

function allocateBinding(occupied) {
  let binding = occupied.size ? Math.max(...occupied) + 1 : 0;
  while (occupied.has(binding)) binding += 1;
  occupied.add(binding);
  return binding;
}

function findMatchingParenthesis(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function countTopLevelArguments(source) {
  if (!source.trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const char of source) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) count += 1;
  }
  return count;
}

function useExplicitLodForTextureReads(source) {
  const pattern = /\btexture\s*\(/g;
  let cursor = 0;
  let output = '';
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findMatchingParenthesis(source, openIndex);
    if (closeIndex < 0) break;
    const argumentsText = source.slice(openIndex + 1, closeIndex);
    if (countTopLevelArguments(argumentsText) !== 2) continue;

    output += source.slice(cursor, match.index);
    output += `textureLod(${argumentsText}, 0.0)`;
    cursor = closeIndex + 1;
    pattern.lastIndex = closeIndex + 1;
  }
  return cursor === 0 ? source : output + source.slice(cursor);
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

  const occupiedByGroup = collectOccupiedBindings(source);
  const textureBySampler = new Map(shaderInfo.textures.map((texture) => [texture.samplerName, texture]));
  const bindings = new Map();

  source = source.replace(COMBINED_SAMPLER_PATTERN, (declaration, layout, dimensionsText, samplerName) => {
    const textureBinding = parseBindingLayout(layout);
    if (!textureBinding) {
      throw new Error(`OCIO WebGPU normalization found sampler ${samplerName} without set/binding metadata`);
    }

    const texture = textureBySampler.get(samplerName);
    if (!texture) {
      throw new Error(`OCIO WebGPU normalization could not match sampler ${samplerName} to texture metadata`);
    }

    const occupied = occupiedByGroup.get(textureBinding.group) ?? new Set([textureBinding.binding]);
    occupiedByGroup.set(textureBinding.group, occupied);
    const samplerBinding = allocateBinding(occupied);
    bindings.set(samplerName, {
      texture: textureBinding,
      sampler: { group: textureBinding.group, binding: samplerBinding }
    });

    const dimensions = Number(dimensionsText);
    return `layout(set=${textureBinding.group}, binding=${textureBinding.binding}) uniform texture${dimensions}D ${texture.name};\n`
      + `layout(set=${textureBinding.group}, binding=${samplerBinding}) uniform sampler ${samplerName};`;
  });

  for (const [samplerName, binding] of bindings) {
    const texture = textureBySampler.get(samplerName);
    const combinedSampler = `sampler${texture.dimensions}D(${texture.name}, ${samplerName})`;
    source = replaceIdentifierCall(source, samplerName, combinedSampler);
    if (!binding.texture || !binding.sampler) {
      throw new Error(`OCIO WebGPU normalization produced incomplete bindings for ${samplerName}`);
    }
  }

  // OCIO LUT resources have a single mip level. Force explicit LOD 0 so Naga
  // emits textureSampleLevel instead of derivative-dependent textureSample.
  source = useExplicitLodForTextureReads(source);

  const missingTextures = shaderInfo.textures.filter((texture) => !bindings.has(texture.samplerName));
  if (missingTextures.length) {
    throw new Error(`OCIO WebGPU normalization did not bind texture metadata: ${missingTextures.map((texture) => texture.name).join(', ')}`);
  }

  const uniformMatch = source.match(UNIFORM_BLOCK_PATTERN);
  const uniformBinding = uniformMatch ? parseBindingLayout(uniformMatch[1]) : null;
  if (shaderInfo.uniformBufferSize > 0 && !uniformBinding) {
    throw new Error('OCIO WebGPU normalization could not resolve the GPU uniform-buffer binding');
  }

  const sourceFunctionName = shaderInfo.functionName;
  source += `\nvec4 ${WEBGPU_TRANSFORM_FUNCTION}(vec4 color) { return ${sourceFunctionName}(color); }\n`;
  source += `layout(location=0) out vec4 ocio_naga_output;\nvoid main() { ocio_naga_output = ${WEBGPU_TRANSFORM_FUNCTION}(vec4(0.0)); }\n`;

  return {
    source,
    functionName: WEBGPU_TRANSFORM_FUNCTION,
    uniformBinding,
    textureBindings: bindings,
  };

}

export function resolveTranslatedWgslFunctionName(shaderText, sourceFunctionName) {
  const functionNames = Array.from(
    shaderText.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g),
    (match) => match[1]
  );
  if (functionNames.includes(sourceFunctionName)) {
    return sourceFunctionName;
  }

  const renamedCandidates = functionNames.filter((name) => name.startsWith(`${sourceFunctionName}_`));
  if (renamedCandidates.length === 1) {
    return renamedCandidates[0];
  }

  throw new Error(
    `OCIO WebGPU translation could not resolve callable function ${sourceFunctionName}; `
    + `translated WGSL functions: ${functionNames.join(', ') || '(none)'}`
  );
}

export async function buildWebGpuShaderInfoWithTranslator(
  shaderInfo,
  translateGlslFragmentToWgsl,
) {
  const normalized = normalizeOcioVulkanGlsl(shaderInfo);
  const shaderText = await translateGlslFragmentToWgsl(normalized.source);
  const functionName = resolveTranslatedWgslFunctionName(shaderText, normalized.functionName);
  return {
    shaderText,
    sourceShaderText: shaderInfo.shaderText,
    functionName,
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
