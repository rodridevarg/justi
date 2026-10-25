// Keep the JS bundle and WASM runtime on the same published release.
const VERSION = '0.10.21';
const PACKAGE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const DETECTOR_ASSETS = Object.freeze({
  library: `${PACKAGE_URL}/vision_bundle.mjs`,
  wasm: `${PACKAGE_URL}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
});

export async function loadPoseDetector({
  isCurrent = () => true,
  onProgress = () => {},
  timeoutMs = 45000,
  importModule = (url) => import(url),
} = {}) {
  let expired = false;
  let timer;
  let stage = 'descarga';
  const active = () => !expired && isCurrent();
  const check = () => {
    if (!active()) throw new DOMException('Inicio de cámara cancelado', 'AbortError');
  };
  const progress = (message) => { check(); onProgress(message); };

  const initialize = async () => {
    progress('Descargando el detector corporal…');
    const { FilesetResolver, PoseLandmarker } = await importModule(DETECTOR_ASSETS.library);
    check();
    const vision = await FilesetResolver.forVisionTasks(DETECTOR_ASSETS.wasm);
    check();
    stage = 'inicio';
    const common = {
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.55,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    let detector;
    try {
      progress('Preparando la detección de movimientos…');
      detector = await PoseLandmarker.createFromOptions(vision, {
        ...common, baseOptions: { modelAssetPath: DETECTOR_ASSETS.model, delegate: 'GPU' },
      });
    } catch (error) {
      check();
      console.warn('[Body Dodge] GPU no disponible; probando CPU:', error);
      progress('Preparando el modo compatible…');
      detector = await PoseLandmarker.createFromOptions(vision, {
        ...common, baseOptions: { modelAssetPath: DETECTOR_ASSETS.model, delegate: 'CPU' },
      });
    }
    // A cancelled/timed-out attempt must release a detector that resolves late.
    if (!active()) {
      detector.close();
      check();
    }
    return detector;
  };

  try {
    return await Promise.race([
      initialize(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('La preparación tardó demasiado. Revisá tu conexión y volvé a intentarlo.'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    console.error(`[Body Dodge] Error en ${stage} del detector:`, error);
    if (expired) throw error;
    throw new Error(stage === 'descarga'
      ? 'No se pudo descargar el detector corporal. Revisá tu conexión a Internet y volvé a intentarlo.'
      : 'La cámara tiene permiso, pero el detector no pudo iniciarse. Probá abrir el enlace directamente en Chrome o Safari.',
    { cause: error });
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

