# @bb-studio/ocio

Unofficial OpenColorIO 2.5 WebAssembly bindings for browser and Node.js.

This package is not affiliated with or endorsed by the OpenColorIO project.

The native module links against OpenColorIO C++ and runs the OCIO CPU processor path in WebAssembly. The ACES demo uses the built-in `ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5` config.

## Install

```sh
npm install @bb-studio/ocio
```

The npm package exposes the JavaScript API from `@bb-studio/ocio`. `createOCIO()` selects the correct WebAssembly loader for the current runtime and resolves the bundled wasm file automatically.

It ships three prebuilt Emscripten artifacts:

- `dist/ocio-wasm.js`
- `dist/ocio-wasm.node.js`
- `dist/ocio-wasm.wasm`

Node.js uses `dist/ocio-wasm.node.js`. Browsers, workers, and other runtimes use `dist/ocio-wasm.js`. Both wrappers load the same `dist/ocio-wasm.wasm` binary. The browser wrapper is built without Node.js runtime branches, so browser bundlers do not see Node.js built-in imports such as `node:module`.

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
const processor = config.createColorSpaceProcessor('Input - Camera', 'Output - Rec.709');

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

## Build From Source

This checkout expects local OpenColorIO 2.5 and Emscripten checkouts. By default the build script uses:

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

```sh
npm run serve:demo
```

Then open the URL printed by the script, usually `http://localhost:4173/examples/browser/`.

The demo renders a generated HDR sample image through the OCIO display/view processor. You can choose the input color space, display, view, exposure, gain, gamma, or load your own image.

## License

This package is licensed under the BSD-3-Clause license.

It includes WebAssembly builds of OpenColorIO, which is also licensed under BSD-3-Clause.
See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for bundled third-party notices.
