import assert from 'node:assert/strict';
import { DETECTOR_ASSETS } from '../pose-detector.mjs';

// Unlike an import mock, this catches nonexistent releases and missing WASM files.
const assets = [
  DETECTOR_ASSETS.library,
  `${DETECTOR_ASSETS.wasm}/vision_wasm_internal.js`,
  `${DETECTOR_ASSETS.wasm}/vision_wasm_internal.wasm`,
  `${DETECTOR_ASSETS.wasm}/vision_wasm_nosimd_internal.js`,
  `${DETECTOR_ASSETS.wasm}/vision_wasm_nosimd_internal.wasm`,
  DETECTOR_ASSETS.model,
];
const results = await Promise.allSettled(assets.map(async (url) => {
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  console.log(`OK ${response.status} ${url}`);
}));
const failures = results.filter((result) => result.status === 'rejected');
for (const failure of failures) console.error(failure.reason);
if (failures.length) process.exitCode = 1;

