# OpenColorIO Patches

These patches are applied to `OCIO_SOURCE_DIR` by `scripts/build-wasm.sh` before building the WebAssembly OpenColorIO library.

## `0001-webgl-glsl-es-float-literals.patch`

OpenColorIO 2.5 generates GLSL for ACES fixed-function gamut tables in `FixedFunctionOpGPU.cpp`. Some generated expressions mix integer and floating-point values, such as `i_base + 12` or `(i_hi + 0.5) / 360`.

WebGL GLSL ES compilers are stricter than desktop GLSL and may reject those implicit int/float conversions. This patch makes the generated shader code use explicit float casts and float literals, such as `i_base + float(12)` and `/ 360.0`.

Keep this patch small and remove it once the equivalent fix is available in the OpenColorIO version used by this package.
