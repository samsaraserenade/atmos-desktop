// Entry point for the vendor/matrix-sdk.bundle.js ESM bundle consumed by
// src/client.js (`import * as sdk from '../vendor/matrix-sdk.bundle.js'`).
// Re-exports matrix-js-sdk's full public API plus OlmMachine from the
// crypto-wasm package it depends on (used directly by
// src/crypto-service.js for offline Megolm-export decryption), since
// matrix-js-sdk's own index does not re-export that class itself.
//
// Rebuild with:
//   npx esbuild build/matrix-sdk-entry.js --bundle --format=esm \
//     --outfile=vendor/matrix-sdk.bundle.js
// then copy the matching wasm binary alongside it (the bundle locates it
// at runtime via a URL relative to its own location):
//   cp node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm vendor/pkg/
export * from 'matrix-js-sdk';
export { OlmMachine } from '@matrix-org/matrix-sdk-crypto-wasm';
