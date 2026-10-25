const LIBRARY = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';
const WASM_FILES = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
let landmarker = null;
let busy = false;

async function initialize() {
  const { FilesetResolver, PoseLandmarker } = await import(LIBRARY);
  const vision = await FilesetResolver.forVisionTasks(WASM_FILES);
  const options = {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, options);
  } catch {
    // Some phones cannot run WebGL in a background thread. CPU keeps the same local processing.
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
    });
  }
  self.postMessage({ type: 'READY' });
}

function pointIsVisible(point) {
  return point && (point.visibility ?? point.presence ?? 0) >= 0.45;
}

function extractBody(landmarks) {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];

  if (![leftShoulder, rightShoulder, leftHip, rightHip].every(pointIsVisible)) return null;

  return {
    shoulderX: (leftShoulder.x + rightShoulder.x) / 2,
    shoulderY: (leftShoulder.y + rightShoulder.y) / 2,
    hipY: (leftHip.y + rightHip.y) / 2,
    shoulderWidth: Math.abs(leftShoulder.x - rightShoulder.x),
    torsoScale: Math.max(0.08, Math.abs((leftHip.y + rightHip.y - leftShoulder.y - rightShoulder.y) / 2)),
    // Outline points let the live preview confirm that tracking follows the user's silhouette.
    outline: [11, 12, 14, 16, 24, 23, 25, 27].map((index) => {
      const point = landmarks[index];
      return pointIsVisible(point) ? { x: point.x, y: point.y } : null;
    }),
  };
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'INIT') {
    try {
      await initialize();
    } catch (error) {
      self.postMessage({ type: 'ERROR', message: error?.message ?? 'No se pudo cargar el detector.' });
    }
    return;
  }

  if (data?.type !== 'FRAME' || !landmarker || busy) {
    data?.bitmap?.close?.();
    return;
  }

  busy = true;
  try {
    const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
    const pose = result.landmarks?.[0];
    self.postMessage({ type: 'POSE', body: pose ? extractBody(pose) : null });
  } catch (error) {
    self.postMessage({ type: 'ERROR', message: error?.message ?? 'Error al detectar la pose.' });
  } finally {
    data.bitmap.close();
    busy = false;
  }
});
