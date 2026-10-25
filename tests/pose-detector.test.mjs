import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTOR_ASSETS, loadPoseDetector } from '../pose-detector.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function moduleStub(createFromOptions) {
  return async () => ({
    FilesetResolver: { forVisionTasks: async (url) => { assert.equal(url, DETECTOR_ASSETS.wasm); return {}; } },
    PoseLandmarker: { createFromOptions },
  });
}

test('the bundle and WASM use the same explicitly published release', () => {
  const packageURL = DETECTOR_ASSETS.library.replace('/vision_bundle.mjs', '');
  assert.match(packageURL, /@\d+\.\d+\.\d+$/);
  assert.equal(DETECTOR_ASSETS.wasm, `${packageURL}/wasm`);
});

test('a failed import produces an actionable download error', async () => {
  await assert.rejects(loadPoseDetector({ importModule: async () => { throw new Error('404'); } }), /No se pudo descargar/);
});

test('GPU failure falls back to CPU with the same model', async () => {
  const delegates = [];
  const detector = { close() {} };
  const result = await loadPoseDetector({ importModule: moduleStub(async (_, options) => {
    assert.equal(options.baseOptions.modelAssetPath, DETECTOR_ASSETS.model);
    delegates.push(options.baseOptions.delegate);
    if (delegates.length === 1) throw new Error('WebGL unavailable');
    return detector;
  }) });
  assert.equal(result, detector);
  assert.deepEqual(delegates, ['GPU', 'CPU']);
});

test('a timed-out initialization closes the detector if it resolves later', async () => {
  let resolveDetector;
  let closed = 0;
  const ready = new Promise((resolve) => { resolveDetector = resolve; });
  await assert.rejects(loadPoseDetector({ timeoutMs: 10, importModule: moduleStub(() => ready) }), /tardó demasiado/);
  resolveDetector({ close() { closed += 1; } });
  await pause(0);
  assert.equal(closed, 1);
});

test('cancelling during initialization prevents CPU fallback and progress from a stale attempt', async () => {
  let current = true;
  let calls = 0;
  const messages = [];
  await assert.rejects(loadPoseDetector({
    isCurrent: () => current,
    onProgress: (message) => messages.push(message),
    importModule: moduleStub(async () => { calls += 1; current = false; throw new Error('cancelled GPU'); }),
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(messages.length, 2);
});

