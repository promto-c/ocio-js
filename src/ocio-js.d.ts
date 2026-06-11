export const ACES_CG_V2_CONFIG: 'ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4';
export const ACES_STUDIO_V2_CONFIG: 'ocio://studio-config-v2.2.0_aces-v1.3_ocio-v2.4';
export const ACES_CG_V4_CONFIG: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';
export const ACES_STUDIO_V4_CONFIG: 'ocio://studio-config-v4.0.0_aces-v2.0_ocio-v2.5';

export const TransformDirection: Readonly<{
  FORWARD: 0;
  INVERSE: 1;
}>;

export const OptimizationFlags: Readonly<{
  DEFAULT: number;
  NONE: number;
  LOSSLESS: number;
  VERY_GOOD: number;
  GOOD: number;
  DRAFT: -1;
}>;

export interface CreateOCIOOptions {
  moduleFactory?: (options?: unknown) => Promise<unknown>;
  modulePath?: string;
  moduleOptions?: Record<string, unknown>;
  locateFile?: (path: string, prefix: string) => string;
}

export interface BuiltinConfigInfo {
  name: string;
  uiName: string;
  recommended: boolean;
}

export interface ColorSpaceInfo {
  name: string;
  canonicalName: string;
  family: string;
  encoding: string;
  description: string;
  isData: boolean;
  referenceSpace: number;
  aliases: string[];
  categories: string[];
}

export interface RoleInfo {
  name: string;
  colorSpace: string;
}

export interface ViewInfo {
  name: string;
  transform: string;
  colorSpace: string;
  looks: string;
  description: string;
}

export interface DisplayViewProcessorOptions {
  source: string;
  display: string;
  view: string;
  direction?: 0 | 1 | 'forward' | 'inverse';
  optimization?: number | 'default' | 'none' | 'lossless' | 'very-good' | 'good' | 'draft';
}

export type GpuShaderLanguage =
  | 'glsl'
  | 'glsl_1.2'
  | 'glsl_1.3'
  | 'glsl_4.0'
  | 'glsl_es_1.0'
  | 'glsl_es_3.0'
  | 'webgl'
  | 'webgl1'
  | 'webgl2';

export interface GpuShaderOptions {
  language?: GpuShaderLanguage;
  functionName?: string;
  resourcePrefix?: string;
  textureMaxWidth?: number;
  allowTexture1D?: boolean;
}

export interface OcioGpuTexture {
  name: string;
  samplerName: string;
  width: number;
  height: number;
  depth: number;
  dimensions: 1 | 2 | 3;
  channels: 1 | 3;
  interpolation: string;
  values: Float32Array;
}

export interface OcioGpuUniform {
  name: string;
  type: 'double' | 'bool' | 'float3' | 'vector_float' | 'vector_int' | 'unknown';
  bufferOffset: number;
  value: number | boolean | number[];
}

export interface GpuShaderInfo {
  shaderText: string;
  functionName: string;
  language: string;
  cacheId: string;
  uniformBufferSize: number;
  textures: OcioGpuTexture[];
  uniforms: OcioGpuUniform[];
}

export function createOCIO(options?: CreateOCIOOptions): Promise<OCIO>;

export class OCIO {
  readonly module: unknown;
  readonly version: string;
  readonly versionHex: number;
  readonly lastError: string;

  clearAllCaches(): void;
  listBuiltinConfigs(): BuiltinConfigInfo[];
  getBuiltinConfigYaml(name: string): string;
  createBuiltinConfig(name?: string): Config;
  createConfigFromFile(path: string): Config;
  createConfigFromString(text: string, options?: { workingDir?: string }): Config;
  mkdirp(path: string): void;
  writeFile(path: string, data: string | ArrayBufferView): void;
  readFile(path: string, options?: unknown): Uint8Array | string;
}

export class Config {
  readonly version: { major: number; minor: number };
  validate(): true;
  dispose(): void;
  listRoles(): RoleInfo[];
  listColorSpaces(): ColorSpaceInfo[];
  getColorSpace(name: string): ColorSpaceInfo;
  listDisplays(): string[];
  getDefaultDisplay(): string;
  listViews(display: string): ViewInfo[];
  getView(display: string, view: string): ViewInfo;
  getDefaultView(display: string, colorSpace?: string): string;
  listLooks(): string[];
  listViewTransforms(): string[];
  listNamedTransforms(): string[];
  createColorSpaceProcessor(source: string, destination: string, options?: { optimization?: DisplayViewProcessorOptions['optimization'] }): Processor;
  createDisplayViewProcessor(options: DisplayViewProcessorOptions): Processor;
}

export class Processor {
  readonly cacheId: string;
  readonly isNoOp: boolean;
  readonly isIdentity: boolean;
  dispose(): void;
  applyRGBF32(rgb: Float32Array, options?: { copy?: boolean }): Float32Array;
  applyRGBAF32(rgba: Float32Array, options?: { copy?: boolean }): Float32Array;
  applyRGBA8(rgba: Uint8Array | Uint8ClampedArray, options?: { copy?: boolean }): Uint8Array | Uint8ClampedArray;
  getGpuShaderInfo(options?: GpuShaderOptions): GpuShaderInfo;
  getGpuShaderText(options?: GpuShaderOptions): string;
}
