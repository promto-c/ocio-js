#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${ROOT_DIR}/crates/naga-wasm"
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist}"
WASM_BINDGEN="${WASM_BINDGEN:-$(command -v wasm-bindgen || true)}"

if [[ -z "${WASM_BINDGEN}" ]]; then
    printf 'wasm-bindgen was not found. Install wasm-bindgen-cli 0.2.127.\n' >&2
    exit 1
fi

cargo build \
    --manifest-path "${CRATE_DIR}/Cargo.toml" \
    --target wasm32-unknown-unknown \
    --release

mkdir -p "${DIST_DIR}"
"${WASM_BINDGEN}" \
    "${CRATE_DIR}/target/wasm32-unknown-unknown/release/ocio_js_naga.wasm" \
    --target web \
    --out-dir "${DIST_DIR}" \
    --out-name naga-wasm \
    --no-typescript

printf 'Built %s\n' "${DIST_DIR}/naga-wasm.js"
printf 'Built %s\n' "${DIST_DIR}/naga-wasm_bg.wasm"
