# ocio-js

OpenColorIO 2.5 WebAssembly bindings for browser and Node.js. The native module links against OpenColorIO C++ and runs the OCIO CPU processor path in wasm; the ACES demo uses the built-in `ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5` config.

## Build

This checkout expects local OpenColorIO 2.5 and Emscripten checkouts. By default the build script uses:

- `ocio`
- `emsdk`

Override them if needed:

```sh
OCIO_SOURCE_DIR=/path/to/OpenColorIO EMSDK_DIR=/path/to/emsdk npm run build:wasm
```

The build creates:

- `dist/ocio-wasm.js`
- `dist/ocio-wasm.wasm`

## Test

```sh
npm test
```

The test loads the wasm module in Node, creates the ACES v4 / ACES 2.0 built-in CG config, validates it, enumerates color spaces and displays, and applies real OCIO processors to float pixels.

## Browser Demo

```sh
npm run serve:demo
```

Then open `http://localhost:4173/examples/browser/`.

The demo renders a generated HDR sample image through the OCIO display/view processor. You can choose the input color space, display, view, exposure, gain, gamma, or load your own image.

## Minimal API

```js
import { ACES_CG_V4_CONFIG, createOCIO } from './src/index.js';

const ocio = await createOCIO();
const config = ocio.createBuiltinConfig(ACES_CG_V4_CONFIG);
const processor = config.createDisplayViewProcessor({
  source: 'ACEScg',
  display: config.getDefaultDisplay(),
  view: config.getDefaultView(config.getDefaultDisplay(), 'ACEScg')
});

const rgba = new Float32Array([0.18, 0.18, 0.18, 1]);
processor.applyRGBAF32(rgba);
```
