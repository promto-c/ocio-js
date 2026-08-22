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
