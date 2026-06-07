export const ACES_CG_V4_CONFIG = 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';
export const ACES_STUDIO_V4_CONFIG = 'ocio://studio-config-v4.0.0_aces-v2.0_ocio-v2.5';

export const TransformDirection = Object.freeze({
  FORWARD: 0,
  INVERSE: 1
});

export const OptimizationFlags = Object.freeze({
  DEFAULT: -2147483648,
  NONE: 0x00000000,
  LOSSLESS: 0x089c3fc3,
  VERY_GOOD: 0x0f9c3fc3,
  GOOD: 0x0fdc3fc3,
  DRAFT: -1
});

const DEFAULT_MODULE_PATH = '../dist/ocio-wasm.js';

function assertTypedArray(value, type, name) {
  if (!(value instanceof type)) {
    throw new TypeError(`${name} must be a ${type.name}`);
  }
}

function toDirection(value) {
  if (value === TransformDirection.INVERSE || value === 'inverse') {
    return TransformDirection.INVERSE;
  }
  return TransformDirection.FORWARD;
}

function toOptimizationFlags(value) {
  if (value === undefined || value === null || value === 'default') {
    return OptimizationFlags.DEFAULT;
  }
  if (typeof value === 'number') {
    return value;
  }
  const key = String(value).toUpperCase().replace(/[-\s]/g, '_');
  if (Object.hasOwn(OptimizationFlags, key)) {
    return OptimizationFlags[key];
  }
  throw new Error(`Unknown OCIO optimization mode: ${value}`);
}

export async function createOCIO(options = {}) {
  const moduleFactory = options.moduleFactory ?? (await import(options.modulePath ?? DEFAULT_MODULE_PATH)).default;
  const userLocateFile = options.locateFile;
  const moduleOptions = {
    ...options.moduleOptions,
    locateFile(path, prefix) {
      if (userLocateFile) {
        return userLocateFile(path, prefix);
      }
      if (path.endsWith('.wasm')) {
        return new URL(`../dist/${path}`, import.meta.url).href;
      }
      return prefix + path;
    }
  };

  return new OCIO(await moduleFactory(moduleOptions));
}

export class OCIO {
  constructor(module) {
    this.module = module;
  }

  get version() {
    return this._string('ocio_get_version');
  }

  get versionHex() {
    return this.module._ocio_get_version_hex();
  }

  get lastError() {
    return this._string('ocio_get_last_error');
  }

  clearAllCaches() {
    this.module._ocio_clear_all_caches();
  }

  listBuiltinConfigs() {
    const count = this.module._ocio_builtin_config_get_count();
    const configs = [];
    for (let index = 0; index < count; index += 1) {
      configs.push({
        name: this._string('ocio_builtin_config_get_name', index),
        uiName: this._string('ocio_builtin_config_get_ui_name', index),
        recommended: this.module._ocio_builtin_config_is_recommended(index) === 1
      });
    }
    return configs;
  }

  getBuiltinConfigYaml(name) {
    return this._withCString(name, (namePtr) => this._string('ocio_builtin_config_get_yaml', namePtr));
  }

  createBuiltinConfig(name = ACES_CG_V4_CONFIG) {
    const handle = this._withCString(name, (namePtr) => this.module._ocio_config_create_builtin(namePtr));
    this._assertHandle(handle, `Could not create built-in OCIO config ${name}`);
    return new Config(this, handle);
  }

  createConfigFromFile(path) {
    const handle = this._withCString(path, (pathPtr) => this.module._ocio_config_create_from_file(pathPtr));
    this._assertHandle(handle, `Could not create OCIO config from ${path}`);
    return new Config(this, handle);
  }

  createConfigFromString(text, options = {}) {
    const workingDir = options.workingDir ?? '';
    const handle = this._withCStrings([text, workingDir], ([textPtr, workingDirPtr]) => (
      this.module._ocio_config_create_from_string(textPtr, workingDirPtr)
    ));
    this._assertHandle(handle, 'Could not create OCIO config from string');
    return new Config(this, handle);
  }

  mkdirp(path) {
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '' : '.';
    for (const part of parts) {
      current = current === '' ? `/${part}` : `${current}/${part}`;
      try {
        this.module.FS.mkdir(current);
      } catch (error) {
        if (error?.errno !== 20) {
          throw error;
        }
      }
    }
  }

  writeFile(path, data) {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (directory) {
      this.mkdirp(directory);
    }
    this.module.FS.writeFile(path, data);
  }

  readFile(path, options) {
    return this.module.FS.readFile(path, options);
  }

  _assertHandle(handle, message) {
    if (!handle) {
      throw new Error(`${message}: ${this.lastError}`);
    }
  }

  _assertStatus(status, message) {
    if (!status) {
      throw new Error(`${message}: ${this.lastError}`);
    }
  }

  _string(functionName, ...args) {
    const pointer = this.module[`_${functionName}`](...args);
    return pointer ? this.module.UTF8ToString(pointer) : '';
  }

  _withCString(value, callback) {
    const text = value == null ? '' : String(value);
    const byteLength = this.module.lengthBytesUTF8(text) + 1;
    const pointer = this.module._malloc(byteLength);
    this.module.stringToUTF8(text, pointer, byteLength);
    try {
      return callback(pointer);
    } finally {
      this.module._free(pointer);
    }
  }

  _withCStrings(values, callback) {
    const pointers = [];
    try {
      for (const value of values) {
        const text = value == null ? '' : String(value);
        const byteLength = this.module.lengthBytesUTF8(text) + 1;
        const pointer = this.module._malloc(byteLength);
        this.module.stringToUTF8(text, pointer, byteLength);
        pointers.push(pointer);
      }
      return callback(pointers);
    } finally {
      for (const pointer of pointers) {
        this.module._free(pointer);
      }
    }
  }
}

export class Config {
  constructor(ocio, handle) {
    this.ocio = ocio;
    this.handle = handle;
  }

  get version() {
    return {
      major: this.ocio.module._ocio_config_get_major_version(this.handle),
      minor: this.ocio.module._ocio_config_get_minor_version(this.handle)
    };
  }

  validate() {
    this.ocio._assertStatus(this.ocio.module._ocio_config_validate(this.handle), 'OCIO config validation failed');
    return true;
  }

  dispose() {
    if (this.handle) {
      this.ocio.module._ocio_config_release(this.handle);
      this.handle = 0;
    }
  }

  listRoles() {
    const count = this.ocio.module._ocio_config_get_num_roles(this.handle);
    return Array.from({ length: count }, (_, index) => ({
      name: this.ocio._string('ocio_config_get_role_name', this.handle, index),
      colorSpace: this.ocio._string('ocio_config_get_role_color_space', this.handle, index)
    }));
  }

  listColorSpaces() {
    const count = this.ocio.module._ocio_config_get_num_color_spaces(this.handle);
    return Array.from({ length: count }, (_, index) => {
      const name = this.ocio._string('ocio_config_get_color_space_name', this.handle, index);
      return this.getColorSpace(name);
    });
  }

  getColorSpace(name) {
    return this.ocio._withCString(name, (namePtr) => {
      const aliasCount = this.ocio.module._ocio_config_get_num_color_space_aliases(this.handle, namePtr);
      const categoryCount = this.ocio.module._ocio_config_get_num_color_space_categories(this.handle, namePtr);
      return {
        name,
        canonicalName: this.ocio._string('ocio_config_get_canonical_name', this.handle, namePtr),
        family: this.ocio._string('ocio_config_get_color_space_family', this.handle, namePtr),
        encoding: this.ocio._string('ocio_config_get_color_space_encoding', this.handle, namePtr),
        description: this.ocio._string('ocio_config_get_color_space_description', this.handle, namePtr),
        isData: this.ocio.module._ocio_config_get_color_space_is_data(this.handle, namePtr) === 1,
        referenceSpace: this.ocio.module._ocio_config_get_color_space_reference_space(this.handle, namePtr),
        aliases: Array.from({ length: aliasCount }, (_, index) => (
          this.ocio._string('ocio_config_get_color_space_alias', this.handle, namePtr, index)
        )),
        categories: Array.from({ length: categoryCount }, (_, index) => (
          this.ocio._string('ocio_config_get_color_space_category', this.handle, namePtr, index)
        ))
      };
    });
  }

  listDisplays() {
    const count = this.ocio.module._ocio_config_get_num_displays(this.handle);
    return Array.from({ length: count }, (_, index) => this.ocio._string('ocio_config_get_display', this.handle, index));
  }

  getDefaultDisplay() {
    return this.ocio._string('ocio_config_get_default_display', this.handle);
  }

  listViews(display) {
    return this.ocio._withCString(display, (displayPtr) => {
      const count = this.ocio.module._ocio_config_get_num_views(this.handle, displayPtr);
      return Array.from({ length: count }, (_, index) => {
        const name = this.ocio._string('ocio_config_get_view', this.handle, displayPtr, index);
        return this.getView(display, name);
      });
    });
  }

  getView(display, view) {
    return this.ocio._withCStrings([display, view], ([displayPtr, viewPtr]) => ({
      name: view,
      transform: this.ocio._string('ocio_config_get_view_transform_name', this.handle, displayPtr, viewPtr),
      colorSpace: this.ocio._string('ocio_config_get_view_color_space_name', this.handle, displayPtr, viewPtr),
      looks: this.ocio._string('ocio_config_get_view_looks', this.handle, displayPtr, viewPtr),
      description: this.ocio._string('ocio_config_get_view_description', this.handle, displayPtr, viewPtr)
    }));
  }

  getDefaultView(display, colorSpace) {
    if (colorSpace) {
      return this.ocio._withCStrings([display, colorSpace], ([displayPtr, colorSpacePtr]) => (
        this.ocio._string('ocio_config_get_default_view_for_color_space', this.handle, displayPtr, colorSpacePtr)
      ));
    }
    return this.ocio._withCString(display, (displayPtr) => (
      this.ocio._string('ocio_config_get_default_view', this.handle, displayPtr)
    ));
  }

  listLooks() {
    const count = this.ocio.module._ocio_config_get_num_looks(this.handle);
    return Array.from({ length: count }, (_, index) => this.ocio._string('ocio_config_get_look_name', this.handle, index));
  }

  listViewTransforms() {
    const count = this.ocio.module._ocio_config_get_num_view_transforms(this.handle);
    return Array.from({ length: count }, (_, index) => (
      this.ocio._string('ocio_config_get_view_transform_name_by_index', this.handle, index)
    ));
  }

  listNamedTransforms() {
    const count = this.ocio.module._ocio_config_get_num_named_transforms(this.handle);
    return Array.from({ length: count }, (_, index) => (
      this.ocio._string('ocio_config_get_named_transform_name', this.handle, index)
    ));
  }

  createColorSpaceProcessor(source, destination, options = {}) {
    const optimization = toOptimizationFlags(options.optimization);
    const handle = this.ocio._withCStrings([source, destination], ([sourcePtr, destinationPtr]) => (
      this.ocio.module._ocio_processor_create_color_space(this.handle, sourcePtr, destinationPtr, optimization)
    ));
    this.ocio._assertHandle(handle, `Could not create OCIO ColorSpace processor ${source} -> ${destination}`);
    return new Processor(this.ocio, handle);
  }

  createDisplayViewProcessor({ source, display, view, direction = TransformDirection.FORWARD, optimization } = {}) {
    const optimizationFlags = toOptimizationFlags(optimization);
    const transformDirection = toDirection(direction);
    const handle = this.ocio._withCStrings([source, display, view], ([sourcePtr, displayPtr, viewPtr]) => (
      this.ocio.module._ocio_processor_create_display_view(
        this.handle,
        sourcePtr,
        displayPtr,
        viewPtr,
        transformDirection,
        optimizationFlags
      )
    ));
    this.ocio._assertHandle(handle, `Could not create OCIO Display/View processor ${source} -> ${display}/${view}`);
    return new Processor(this.ocio, handle);
  }
}

export class Processor {
  constructor(ocio, handle) {
    this.ocio = ocio;
    this.handle = handle;
  }

  get cacheId() {
    return this.ocio._string('ocio_processor_get_cache_id', this.handle);
  }

  get isNoOp() {
    return this.ocio.module._ocio_processor_is_noop(this.handle) === 1;
  }

  get isIdentity() {
    return this.ocio.module._ocio_processor_is_identity(this.handle) === 1;
  }

  dispose() {
    if (this.handle) {
      this.ocio.module._ocio_processor_release(this.handle);
      this.handle = 0;
    }
  }

  applyRGBF32(rgb, options = {}) {
    assertTypedArray(rgb, Float32Array, 'rgb');
    if (rgb.length % 3 !== 0) {
      throw new RangeError('rgb length must be divisible by 3');
    }
    const target = options.copy ? new Float32Array(rgb) : rgb;
    return this._applyFloat32(target, 3, 'ocio_processor_apply_rgb_f32');
  }

  applyRGBAF32(rgba, options = {}) {
    assertTypedArray(rgba, Float32Array, 'rgba');
    if (rgba.length % 4 !== 0) {
      throw new RangeError('rgba length must be divisible by 4');
    }
    const target = options.copy ? new Float32Array(rgba) : rgba;
    return this._applyFloat32(target, 4, 'ocio_processor_apply_rgba_f32');
  }

  applyRGBA8(rgba, options = {}) {
    if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
      throw new TypeError('rgba must be a Uint8Array or Uint8ClampedArray');
    }
    if (rgba.length % 4 !== 0) {
      throw new RangeError('rgba length must be divisible by 4');
    }

    const target = options.copy ? new rgba.constructor(rgba) : rgba;
    const byteLength = target.byteLength;
    const pointer = this.ocio.module._malloc(byteLength);
    this.ocio.module.HEAPU8.set(target, pointer);
    try {
      this.ocio._assertStatus(
        this.ocio.module._ocio_processor_apply_rgba_u8(this.handle, pointer, target.length / 4),
        'OCIO Uint8 RGBA processing failed'
      );
      target.set(this.ocio.module.HEAPU8.subarray(pointer, pointer + byteLength));
      return target;
    } finally {
      this.ocio.module._free(pointer);
    }
  }

  _applyFloat32(target, channels, functionName) {
    const byteLength = target.byteLength;
    const pointer = this.ocio.module._malloc(byteLength);
    this.ocio.module.HEAPF32.set(target, pointer / Float32Array.BYTES_PER_ELEMENT);
    try {
      this.ocio._assertStatus(
        this.ocio.module[`_${functionName}`](this.handle, pointer, target.length / channels),
        'OCIO Float32 processing failed'
      );
      target.set(this.ocio.module.HEAPF32.subarray(
        pointer / Float32Array.BYTES_PER_ELEMENT,
        pointer / Float32Array.BYTES_PER_ELEMENT + target.length
      ));
      return target;
    } finally {
      this.ocio.module._free(pointer);
    }
  }
}
