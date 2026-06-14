#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OCIO_SOURCE_DIR="${ROOT_DIR}/ocio"
DEFAULT_EMSDK_DIR="${ROOT_DIR}/emsdk"

OCIO_SOURCE_DIR="${OCIO_SOURCE_DIR:-${DEFAULT_OCIO_SOURCE_DIR}}"
EMSDK_DIR="${EMSDK_DIR:-${DEFAULT_EMSDK_DIR}}"
BUILD_DIR="${BUILD_DIR:-${ROOT_DIR}/build}"
EM_CACHE="${EM_CACHE:-${BUILD_DIR}/emscripten-cache}"
OCIO_BUILD_DIR="${OCIO_BUILD_DIR:-${BUILD_DIR}/ocio-wasm}"
OCIO_INSTALL_DIR="${OCIO_INSTALL_DIR:-${BUILD_DIR}/ocio-wasm-install}"
WRAPPER_BUILD_DIR="${WRAPPER_BUILD_DIR:-${BUILD_DIR}/ocio-js-wasm}"
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist}"
OCIO_EXT_DIST_DIR="${OCIO_EXT_DIST_DIR:-${OCIO_BUILD_DIR}/ext/dist}"
PARALLEL="${CMAKE_BUILD_PARALLEL_LEVEL:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')}"
EMCMAKE="${EMSDK_DIR}/upstream/emscripten/emcmake"
OCIO_PATCHES=(
    "${ROOT_DIR}/patches/opencolorio/0001-webgl-glsl-es-float-literals.patch"
)

if [[ "${1:-}" == "--clean" ]]; then
    rm -rf "${OCIO_BUILD_DIR}" "${OCIO_INSTALL_DIR}" "${WRAPPER_BUILD_DIR}" "${DIST_DIR}/ocio-wasm.js" "${DIST_DIR}/ocio-wasm.node.js" "${DIST_DIR}/ocio-wasm.wasm" "${DIST_DIR}/ocio-wasm.node.wasm"
fi

if [[ ! -x "${EMCMAKE}" ]]; then
    printf 'Emscripten emcmake was not found at %s\n' "${EMCMAKE}" >&2
    printf 'Set EMSDK_DIR to an activated emsdk checkout.\n' >&2
    exit 1
fi

if [[ ! -f "${OCIO_SOURCE_DIR}/CMakeLists.txt" ]]; then
    printf 'OpenColorIO source was not found at %s\n' "${OCIO_SOURCE_DIR}" >&2
    printf 'Set OCIO_SOURCE_DIR to an OpenColorIO 2.5 source checkout.\n' >&2
    exit 1
fi

apply_ocio_patch() {
    local patch_file="$1"
    local patch_name
    patch_name="$(basename "${patch_file}")"

    if [[ ! -f "${patch_file}" ]]; then
        printf 'OpenColorIO patch was not found: %s\n' "${patch_file}" >&2
        exit 1
    fi

    if git -C "${OCIO_SOURCE_DIR}" apply --check "${patch_file}" >/dev/null 2>&1; then
        printf 'Applying OpenColorIO patch: %s\n' "${patch_name}"
        git -C "${OCIO_SOURCE_DIR}" apply "${patch_file}"
        return 0
    fi

    if git -C "${OCIO_SOURCE_DIR}" apply --reverse --check "${patch_file}" >/dev/null 2>&1; then
        printf 'OpenColorIO patch already applied: %s\n' "${patch_name}"
        return 0
    fi

    printf 'OpenColorIO patch could not be applied cleanly: %s\n' "${patch_file}" >&2
    printf 'Check OCIO_SOURCE_DIR or refresh patches/opencolorio.\n' >&2
    exit 1
}

for patch_file in "${OCIO_PATCHES[@]}"; do
    apply_ocio_patch "${patch_file}"
done

OCIO_PATCH_SIGNATURE="$(for patch_file in "${OCIO_PATCHES[@]}"; do cksum "${patch_file}"; done)"
OCIO_PATCH_STAMP="${OCIO_INSTALL_DIR}/.ocio-js-opencolorio-patches"

mkdir -p "${BUILD_DIR}" "${DIST_DIR}"
mkdir -p "${EM_CACHE}"
export EM_CACHE

if [[ -f "${OCIO_INSTALL_DIR}/lib/cmake/OpenColorIO/OpenColorIOConfig.cmake" ]]; then
    if [[ ! -f "${OCIO_PATCH_STAMP}" ]] || [[ "$(cat "${OCIO_PATCH_STAMP}")" != "${OCIO_PATCH_SIGNATURE}" ]]; then
        printf 'OpenColorIO patch set changed; rebuilding OpenColorIO.\n'
        rm -rf "${OCIO_BUILD_DIR}" "${OCIO_INSTALL_DIR}"
    fi
fi

if [[ ! -f "${OCIO_INSTALL_DIR}/lib/cmake/OpenColorIO/OpenColorIOConfig.cmake" ]]; then
    "${EMCMAKE}" cmake \
        -S "${OCIO_SOURCE_DIR}" \
        -B "${OCIO_BUILD_DIR}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="${OCIO_INSTALL_DIR}" \
        -DCMAKE_CXX_FLAGS="-fexceptions" \
        -DBUILD_SHARED_LIBS=OFF \
        -DOCIO_BUILD_APPS=OFF \
        -DOCIO_BUILD_DOCS=OFF \
        -DOCIO_BUILD_GPU_TESTS=OFF \
        -DOCIO_BUILD_JAVA=OFF \
        -DOCIO_BUILD_NUKE=OFF \
        -DOCIO_BUILD_OPENFX=OFF \
        -DOCIO_BUILD_PYTHON=OFF \
        -DOCIO_BUILD_TESTS=OFF \
        -DOCIO_INSTALL_EXT_PACKAGES=ALL \
        -DOCIO_USE_SIMD=OFF \
        -DOCIO_USE_SSE2=OFF \
        -DOCIO_USE_SSE3=OFF \
        -DOCIO_USE_SSSE3=OFF \
        -DOCIO_USE_SSE4=OFF \
        -DOCIO_USE_SSE42=OFF \
        -DOCIO_USE_AVX=OFF \
        -DOCIO_USE_AVX2=OFF \
        -DOCIO_USE_AVX512=OFF \
        -DOCIO_USE_F16C=OFF \
        -DOCIO_WARNING_AS_ERROR=OFF

    cmake --build "${OCIO_BUILD_DIR}" --target install --parallel "${PARALLEL}"
    printf '%s\n' "${OCIO_PATCH_SIGNATURE}" > "${OCIO_PATCH_STAMP}"
fi

"${EMCMAKE}" cmake \
    -S "${ROOT_DIR}" \
    -B "${WRAPPER_BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="${OCIO_INSTALL_DIR};${OCIO_EXT_DIST_DIR}" \
    -DOpenColorIO_DIR="${OCIO_INSTALL_DIR}/lib/cmake/OpenColorIO" \
    -Dexpat_DIR="${OCIO_EXT_DIST_DIR}/lib/cmake/expat-2.7.2" \
    -DImath_DIR="${OCIO_EXT_DIST_DIR}/lib/cmake/Imath" \
    -Dminizip-ng_DIR="${OCIO_EXT_DIST_DIR}/lib/cmake/minizip-ng" \
    -Dyaml-cpp_DIR="${OCIO_EXT_DIST_DIR}/lib/cmake/yaml-cpp" \
    -Dpystring_ROOT="${OCIO_EXT_DIST_DIR}" \
    -Dpystring_INCLUDE_DIR="${OCIO_EXT_DIST_DIR}/include/pystring" \
    -Dpystring_LIBRARY="${OCIO_EXT_DIST_DIR}/lib/libpystring.a" \
    -DZLIB_ROOT="${OCIO_EXT_DIST_DIR}" \
    -DZLIB_INCLUDE_DIR="${OCIO_EXT_DIST_DIR}/include" \
    -DZLIB_LIBRARY="${OCIO_EXT_DIST_DIR}/lib/libz.a" \
    -DZLIB_USE_STATIC_LIBS=ON \
    -DOCIO_WASM_DIST_DIR="${DIST_DIR}"

cmake --build "${WRAPPER_BUILD_DIR}" --target ocio-wasm --target ocio-wasm-node --parallel "${PARALLEL}"

NODE_WRAPPER="${DIST_DIR}/ocio-wasm.node.js"
NODE_WASM="${DIST_DIR}/ocio-wasm.node.wasm"
SHARED_WASM="${DIST_DIR}/ocio-wasm.wasm"

if [[ -f "${NODE_WASM}" ]]; then
    if ! cmp -s "${SHARED_WASM}" "${NODE_WASM}"; then
        printf 'Generated wasm binaries differ: %s and %s\n' "${SHARED_WASM}" "${NODE_WASM}" >&2
        exit 1
    fi

    node -e "const fs = require('node:fs'); const file = process.argv[1]; const source = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, source.replaceAll('ocio-wasm.node.wasm', 'ocio-wasm.wasm'));" "${NODE_WRAPPER}"
    rm -f "${NODE_WASM}"
fi

printf 'Built %s\n' "${DIST_DIR}/ocio-wasm.js"
printf 'Built %s\n' "${DIST_DIR}/ocio-wasm.node.js"
printf 'Built %s\n' "${DIST_DIR}/ocio-wasm.wasm"
