#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OCIO_SOURCE_DIR="${ROOT_DIR}/../ocio-js/ocio"
DEFAULT_EMSDK_DIR="${ROOT_DIR}/../ocio-js/emsdk"

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

if [[ "${1:-}" == "--clean" ]]; then
    rm -rf "${OCIO_BUILD_DIR}" "${OCIO_INSTALL_DIR}" "${WRAPPER_BUILD_DIR}" "${DIST_DIR}/ocio-wasm.js" "${DIST_DIR}/ocio-wasm.wasm"
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

mkdir -p "${BUILD_DIR}" "${DIST_DIR}"
mkdir -p "${EM_CACHE}"
export EM_CACHE

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

cmake --build "${WRAPPER_BUILD_DIR}" --target ocio-wasm --parallel "${PARALLEL}"

printf 'Built %s\n' "${DIST_DIR}/ocio-wasm.js"
printf 'Built %s\n' "${DIST_DIR}/ocio-wasm.wasm"
