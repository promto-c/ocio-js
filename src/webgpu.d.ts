import type { WebGpuShaderInfo } from './ocio-js.js';

export type OcioWebGpuTexturePrecision = 'float32' | 'float16';
export type OcioWebGpuRequiredFeature = 'float32-filterable';

export interface OcioWebGpuResourceOptions {
  /**
   * Storage precision for OCIO LUT textures. Defaults to `float32`.
   * `float16` is an explicit precision tradeoff and is never selected automatically.
   */
  texturePrecision?: OcioWebGpuTexturePrecision;
}

/** Minimal structural WebGPU surface required by the OCIO resource helpers. */
export interface OcioWebGpuDevice<TBindGroup = unknown> {
  readonly features: { has(feature: OcioWebGpuRequiredFeature): boolean };
  readonly queue: {
    writeBuffer(...args: any[]): void;
    writeTexture(...args: any[]): void;
  };
  createBuffer(descriptor: any): { destroy(): void };
  createTexture(descriptor: any): { createView(): any; destroy(): void };
  createSampler(descriptor: any): any;
  createBindGroup(descriptor: any): TBindGroup;
}

/** Minimal structural render-pipeline surface required by the OCIO resource helpers. */
export interface OcioWebGpuPipeline {
  getBindGroupLayout(group: number): any;
}

export interface OcioWebGpuResources<TBindGroup = unknown> {
  /** OCIO-owned bind groups keyed by their WGSL group index. */
  readonly bindGroups: ReadonlyMap<number, TBindGroup>;
  readonly texturePrecision: OcioWebGpuTexturePrecision;
  /** Destroy buffers and textures allocated by this resource set. Safe to call more than once. */
  dispose(): void;
}

/**
 * Return optional WebGPU features needed by the requested OCIO LUT precision.
 * Float32 LUTs only require `float32-filterable` when the OCIO shader needs filtered sampling.
 */
export function getOcioWebGpuRequiredFeatures(
  shaderInfo: WebGpuShaderInfo,
  options?: OcioWebGpuResourceOptions,
): readonly OcioWebGpuRequiredFeature[];

/** Return the first bind-group index not occupied by OCIO resources. */
export function getOcioWebGpuNextBindGroupIndex(shaderInfo: WebGpuShaderInfo): number;

/** Pack OCIO uniform metadata into the byte layout declared by its generated shader. */
export function packOcioWebGpuUniforms(shaderInfo: WebGpuShaderInfo): Uint8Array;

/**
 * Upload OCIO LUTs/uniforms and build the bind groups expected by `shaderInfo.shaderText`.
 * The caller owns the render pipeline; call `dispose()` when these OCIO resources are retired.
 */
export function createOcioWebGpuResources<TBindGroup>(
  device: OcioWebGpuDevice<TBindGroup>,
  pipeline: OcioWebGpuPipeline,
  shaderInfo: WebGpuShaderInfo,
  options?: OcioWebGpuResourceOptions,
): OcioWebGpuResources<TBindGroup>;
