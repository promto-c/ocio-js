# @bb-studio/ocio

Unofficial OpenColorIO 2.5.2 WebAssembly bindings for browser and Node.js.

This package is not affiliated with or endorsed by the OpenColorIO project.

**Live demo:** https://promto-c.github.io/ocio-js/

The native module links against OpenColorIO C++ and runs the OCIO CPU processor path in WebAssembly. The ACES demo uses the built-in `ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5` config.

## Install

```sh
npm install @bb-studio/ocio
```

The npm package exposes the JavaScript API from `@bb-studio/ocio`. `createOCIO()` selects the correct WebAssembly loader for the current runtime and resolves the bundled wasm file automatically.

The package ships three internal Emscripten artifacts:

- `dist/ocio-wasm.js`
- `dist/ocio-wasm.node.js`
- `dist/ocio-wasm.wasm`

Node.js uses `dist/ocio-wasm.node.js`. Browsers, workers, and other runtimes use `dist/ocio-wasm.js`. Both wrappers load the same `dist/ocio-wasm.wasm` binary. The browser wrapper is built without Node.js runtime branches, so browser bundlers do not see Node.js built-in imports such as `node:module`.

## WASM URL Resolution

By default, `createOCIO()` resolves the bundled wasm file with the standard `new URL('../dist/ocio-wasm.wasm', import.meta.url)` pattern.

Vite apps can keep the same import and opt into the built-in Vite asset URL adapter with a resolver condition:

```js
// vite.config.js
export default {
  resolve: {
    conditions: ['vite', 'module', 'browser', 'development|production']
  }
};
```

Then `createOCIO()` automatically uses the Vite-compatible wasm URL in dev and production builds.

If your app serves static assets from a CDN or public assets directory, pass the wasm URL directly:

```js
import { createOCIO } from '@bb-studio/ocio';

const ocio = await createOCIO({
  wasmUrl: '/assets/ocio-wasm.wasm'
});
```

Advanced Emscripten users can pass `locateFile` for full control over every auxiliary file lookup.

## Usage

```js
import { ACES_CG_V4_CONFIG, createOCIO } from '@bb-studio/ocio';

const ocio = await createOCIO();
const config = ocio.createBuiltinConfig(ACES_CG_V4_CONFIG);
const display = config.getDefaultDisplay();
const view = config.getDefaultView(display, 'ACEScg');
const processor = config.createDisplayViewProcessor({
  source: 'ACEScg',
  display,
  view
});

const rgba = new Float32Array([0.18, 0.18, 0.18, 1]);
processor.applyRGBAF32(rgba);

processor.dispose();
config.dispose();
```

## File Rules

Resolve media paths through the active config instead of reproducing OCIO matching rules:

```js
const match = config.matchFileRule('/show/plates/shot010.exr');
if (match) {
  console.log(match.colorSpace, match.ruleName, match.custom);
}

const rules = config.listFileRules();
```

## Custom OCIO Configs

For a custom config that does not reference external files, load the config text and create it directly:

```js
import { createOCIO } from '@bb-studio/ocio';

const ocio = await createOCIO();
const configText = await fetch('/configs/show/config.ocio').then((response) => response.text());
const config = ocio.createConfigFromString(configText);

config.validate();
config.dispose();
```

If the config references LUTs or other files, write those files into the wasm filesystem first and pass a working directory. Keep the same relative paths used by the OCIO config:

```js
import { readFile } from 'node:fs/promises';
import { createOCIO } from '@bb-studio/ocio';

const ocio = await createOCIO();
const workingDir = '/show-config';

const configText = await readFile('./show/config.ocio', 'utf8');
ocio.writeFile(`${workingDir}/luts/look.cube`, await readFile('./show/luts/look.cube'));

const config = ocio.createConfigFromString(configText, { workingDir });
const processor = config.createColorSpaceProcessor('Input - Camera', 'Output - Rec.709', {
  context: { SHOT: '010', LUT: 'luts/shot010.cube' },
});

const rgb = new Float32Array([0.18, 0.18, 0.18]);
processor.applyRGBF32(rgb);

processor.dispose();
config.dispose();
```

The paths passed to `writeFile()` and `createConfigFromFile()` are virtual wasm filesystem paths, not direct host filesystem paths.

You can also write the config itself and load it by path:

```js
ocio.writeFile(`${workingDir}/config.ocio`, configText);
const config = ocio.createConfigFromFile(`${workingDir}/config.ocio`);
```

## Transform Processors

In addition to color-space and display/view processors, configs may create processors for files,
looks, named transforms, or an ordered group of transforms. All processor types support the same
CPU methods and GPU shader extraction.

```js
ocio.writeFile('/project/luts/show-look.cube', lutBytes);

const fileProcessor = config.createFileTransformProcessor({
  src: '/project/luts/show-look.cube',
  interpolation: 'best',
  direction: 'forward',
  optimization: 'lossless'
});

const lookProcessor = config.createLookTransformProcessor({
  source: 'ACEScg',
  destination: 'ACEScg',
  looks: 'Show Look'
});

const namedProcessor = config.createNamedTransformProcessor('Utility Curve', {
  direction: 'inverse'
});
```

Use a group when several operations should be optimized and extracted as one processor:

```js
const processor = config.createGroupTransformProcessor([
  { type: 'colorSpace', source: 'ACEScg', destination: 'ACEScct' },
  { type: 'file', src: '/project/luts/grade.cube', interpolation: 'tetrahedral' },
  { type: 'colorSpace', source: 'ACEScct', destination: 'ACEScg' }
], {
  context: { SHOT: '010' },
  optimization: 'lossless'
});

const shaderInfo = processor.getGpuShaderInfo({
  language: 'glsl_es_3.0',
  functionName: 'OCIOGrade',
  resourcePrefix: 'ocio_grade'
});
```

Supported group descriptors are `colorSpace`, `file`, `look`, `displayView`, and `named`.
File descriptors support direction, interpolation, CCC/CDL selection, and CDL clamp style.
Display/view descriptors may bypass configured looks or data transforms when required.

The metadata APIs are intended for building validated application UI:

```js
const fileFormats = ocio.listFileTransformFormats();
const supportsCube = ocio.isFileTransformFormatSupported('.cube');
const look = config.getLook('Show Look');
const namedTransform = config.getNamedTransform('Utility Curve');
const resultSpace = config.getLooksResultColorSpace('+Show Look');
```

Paths used by `FileTransform` are resolved by OpenColorIO against the config context and working
directory. In browsers, copy files into the Emscripten filesystem with `writeFile()` before
creating the processor.

## WebGPU / WGSL

Every OCIO `Processor` can produce WGSL for WebGPU. The package asks OpenColorIO for Vulkan GLSL (`glsl_vk_4.6`) and translates that shader to WGSL through the bundled Naga WebAssembly runtime:

```js
const shaderInfo = await processor.getWebGpuShaderInfo({
  functionName: 'OCIODisplay',
  resourcePrefix: 'ocio_display'
});

console.log(shaderInfo.shaderText);       // WGSL module source
console.log(shaderInfo.functionName);     // callable OCIO function in that module
console.log(shaderInfo.textures);         // LUT data + texture/sampler bindings
console.log(shaderInfo.uniforms);         // OCIO uniform values + byte offsets
console.log(shaderInfo.uniformBinding);   // uniform-buffer bind location, when present
```

`shaderInfo.functionName` is intended to be called from your own shader entry point. `ocio-js` does not own your render pipeline, canvas, source texture, or frame loop. For example, a viewer fragment shader may append to the returned WGSL and call the OCIO function. The group number below is illustrative; use `getOcioWebGpuNextBindGroupIndex()` when composing real resources:

```wgsl
@group(1) @binding(0) var viewer_source: texture_2d<f32>;

@fragment
fn viewer_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let color = textureLoad(viewer_source, vec2<i32>(position.xy), 0);
  return OCIODisplay(color);
}
```

The optional `@bb-studio/ocio/webgpu` entry point contains resource helpers for the binding metadata returned above:

```js
import {
  createOcioWebGpuResources,
  getOcioWebGpuNextBindGroupIndex,
  getOcioWebGpuRequiredFeatures
} from '@bb-studio/ocio/webgpu';

const shaderInfo = await processor.getWebGpuShaderInfo({
  functionName: 'OCIODisplay',
  resourcePrefix: 'ocio_display'
});

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU adapter unavailable');

const requiredFeatures = getOcioWebGpuRequiredFeatures(shaderInfo);
for (const feature of requiredFeatures) {
  if (!adapter.features.has(feature)) {
    throw new Error(`Required WebGPU feature is unavailable: ${feature}`);
  }
}
const device = await adapter.requestDevice({ requiredFeatures });

const viewerGroup = getOcioWebGpuNextBindGroupIndex(shaderInfo);
// Build your shader module and render pipeline here. Place application-owned
// bindings such as the source image in viewerGroup or later groups.

const resources = createOcioWebGpuResources(device, pipeline, shaderInfo);
for (const [group, bindGroup] of resources.bindGroups) {
  pass.setBindGroup(group, bindGroup);
}

// When the cached processor/pipeline resources are retired:
resources.dispose();
```

### LUT precision

OCIO LUT values are exposed as `Float32Array`. `createOcioWebGpuResources()` therefore defaults to float32 GPU textures and never silently lowers precision. If the shader uses filtered LUT sampling, query `getOcioWebGpuRequiredFeatures()` before device creation; it will request `float32-filterable` when needed.

A caller may explicitly choose half-float LUT storage when that tradeoff is acceptable:

```js
const resources = createOcioWebGpuResources(device, pipeline, shaderInfo, {
  texturePrecision: 'float16'
});
```

This opt-in removes the `float32-filterable` requirement for filtered LUTs but intentionally reduces LUT storage precision.

### Caching and loading

`shaderInfo.cacheId` is suitable for application-side shader/pipeline resource caches. Reuse the returned OCIO bind groups while that processor shader is active rather than re-uploading LUTs every frame.

The Naga translator is loaded lazily. Applications using only CPU processing or GLSL extraction do not initialize the additional Naga WebAssembly runtime.

## Build From Source

This checkout expects a local OpenColorIO 2.5.2 checkout and Emscripten. By default the build script uses:

- `ocio`
- `emsdk`

Override them if needed:

```sh
OCIO_SOURCE_DIR=/path/to/OpenColorIO EMSDK_DIR=/path/to/emsdk npm run build:wasm
```

The build creates:

- `dist/ocio-wasm.js`
- `dist/ocio-wasm.node.js`
- `dist/ocio-wasm.wasm`

## Publish

For maintainers only:

```sh
npm test
npm run pack:dry-run
npm publish
```

The package is scoped and configured with `publishConfig.access` set to `public`.

## Test

```sh
npm test
```

The test loads the wasm module in Node, creates the ACES v4 / ACES 2.0 built-in CG config, validates it, enumerates color spaces and displays, and applies real OCIO processors to float pixels.

## Browser Demo

For local development, serve the demo directly from the repository:

```sh
npm run serve:demo
```

To build and preview the same self-contained static site deployed to GitHub Pages:

```sh
npm run build:demo
npm run preview:demo
```

`build:demo` creates `demo-dist/` using only browser runtime files. It does not rebuild OpenColorIO or Naga.

The live demo is deployed from `main` by `.github/workflows/pages.yml` using GitHub Pages Actions:

https://promto-c.github.io/ocio-js/

For first-time setup, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Subsequent pushes to `main` deploy automatically; the workflow may also be run manually.

The demo renders a generated HDR sample image through the OCIO display/view processor. You can choose the input color space, display, view, exposure, gain, gamma, or load your own image.

## License

This package is licensed under the BSD-3-Clause license.

It includes WebAssembly builds of OpenColorIO, which is also licensed under BSD-3-Clause.
See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for bundled third-party notices.
