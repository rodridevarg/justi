import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../game.js', import.meta.url), 'utf8');
const pose = { shoulderX: 0.5, shoulderY: 0.3, hipY: 0.6, shoulderWidth: 0.25, torsoScale: 0.3 };
function harness({ permission, detectorLoader } = {}) {
  const elements = new Map();
  const timers = new Map();
  let time = 1000;
  let timerId = 0;
  let stopped = 0;
  let closed = 0;
  const track = { stop() { stopped += 1; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const detector = { close() { closed += 1; } };
  const context2d = new Proxy({}, { get: (_, key) => key.startsWith('create') ? () => ({ addColorStop() {} }) : () => {} });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(['hidden']);
    const el = {
      id, textContent: '', innerHTML: '', style: {}, disabled: false, width: 640, height: 480,
      classList: { add: (...xs) => xs.forEach((x) => classes.add(x)), remove: (...xs) => xs.forEach((x) => classes.delete(x)), contains: (x) => classes.has(x), toggle(x, force) { const add = force ?? !classes.has(x); add ? classes.add(x) : classes.delete(x); } },
      setAttribute() {}, addEventListener() {}, scrollIntoView() {},
      getContext: () => context2d, querySelector: (selector) => element(id + selector),
      play: async () => {}, readyState: 4, currentTime: 1,
    };
    elements.set(id, el);
    el.children = id === 'hearts' ? [element('heart0'), element('heart1'), element('heart2')] : [];
    return el;
  }
  const setTimer = (callback) => { const id = ++timerId; timers.set(id, callback); return id; };
  const window = { matchMedia: () => ({ matches: true }), isSecureContext: true, addEventListener() {}, setTimeout: setTimer };
  const sandbox = {
    console, Math, Date, DOMException, window,
    document: { getElementById: element, addEventListener() {} },
    location: { hostname: 'localhost' },
    navigator: { mediaDevices: { getUserMedia: permission ?? (async () => stream) } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    performance: { now: () => time },
    requestAnimationFrame() {}, setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
    __deps: { loadPoseDetector: detectorLoader ?? (async () => detector) },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]+\n/, 'const { loadPoseDetector } = globalThis.__deps;\n') + '\nglobalThis.app = {state, ui, startCamera, backToHome, handlePose, beginGame, failCamera, updateGame, updateFrame, updatePlayerFromPose, handleCollision, endGame};', sandbox);
  const app = sandbox.app;
  const calibrate = () => {
    for (let i = 0; i < 15; i++) { time += 150; app.handlePose({ ...pose }); }
  };
  return { ...app, stream, detector, timers, calibrate, tick: (ms) => { time += ms; }, stopped: () => stopped, closed: () => closed };
}

test('permission followed by detector failure keeps the error visible and releases the camera', async () => {
  const app = harness({ detectorLoader: async () => { throw new Error('No se pudo descargar el detector corporal.'); } });
  await app.startCamera();
  assert.equal(app.state.phase, 'idle');
  assert.equal(app.stopped(), 1);
  assert.equal(app.ui.cameraError.classList.contains('hidden'), false);
  assert.match(app.ui.cameraErrorMessage.textContent, /No se pudo descargar/);
  assert.equal(app.ui.cameraStart.disabled, false);
  assert.equal(app.ui.manualStart.disabled, false);
  app.beginGame('manual');
  assert.equal(app.state.mode, 'manual');
  assert.equal(app.state.phase, 'countdown');
});

test('cancel while permission is pending restores the buttons and closes a late camera stream', async () => {
  let resolvePermission;
  const app = harness({ permission: () => new Promise((resolve) => { resolvePermission = resolve; }) });
  const pending = app.startCamera();
  app.backToHome();
  assert.equal(app.ui.cameraStart.disabled, false);
  assert.equal(app.ui.manualStart.disabled, false);
  resolvePermission(app.stream);
  await pending;
  assert.equal(app.stopped(), 1);
  assert.equal(app.state.phase, 'idle');
});

test('a detector resolving after cancel is closed and cannot restore calibration', async () => {
  let resolveDetector;
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const app = harness({ detectorLoader: () => new Promise((resolve) => { resolveDetector = resolve; signalEntered(); }) });
  const pending = app.startCamera();
  await entered;
  app.backToHome();
  resolveDetector(app.detector);
  await pending;
  assert.equal(app.closed(), 1);
  assert.equal(app.state.phase, 'idle');
  assert.equal(app.state.detectorReady, false);
});

test('calibration requires consecutive detections and camera start initializes the complete game', async () => {
  const app = harness();
  await app.startCamera();
  for (let i = 0; i < 8; i++) { app.tick(150); app.handlePose({ ...pose }); }
  app.handlePose(null);
  for (let i = 0; i < 8; i++) { app.tick(150); app.handlePose({ ...pose }); }
  assert.equal(app.state.phase, 'calibrating');
  app.calibrate();
  assert.equal(app.state.phase, 'ready');
  app.state.score = 123;
  app.state.gameTime = 8;
  await app.startCamera();
  assert.equal(app.state.phase, 'countdown');
  assert.equal(app.state.score, 0);
  assert.equal(app.state.gameTime, 0);
  assert.equal(app.ui.pauseButton.disabled, false);
  app.failCamera('Cámara desconectada');
  assert.equal(app.timers.size, 0);
  assert.equal(app.ui.cameraError.classList.contains('hidden'), false);
});

test('camera restart after game over resets score, lives and obstacles', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate();
  app.state.phase = 'over'; app.state.lives = 0; app.state.score = 900;
  app.state.obstacles = [{}];
  app.beginGame('camera');
  assert.equal(app.state.phase, 'countdown');
  assert.equal(app.state.lives, 3);
  assert.equal(app.state.score, 0);
  assert.equal(app.state.obstacles.length, 0);
});

test('starting with stale tracking recalibrates instead of starting a blind game', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate(); app.tick(1400);
  await app.startCamera();
  assert.equal(app.state.phase, 'calibrating');
  assert.equal(app.timers.size, 0);
});

test('mirrored lateral motion and crouching control the player after calibration', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate(); app.beginGame('camera');
  app.updatePlayerFromPose({ ...pose, shoulderX: 0.3 });
  assert.equal(app.state.targetLane, 2);
  for (let i = 0; i < 2; i++) app.updatePlayerFromPose({ ...pose, shoulderY: 0.45, hipY: 0.7 });
  assert.equal(app.state.isDucking, true);
  for (let i = 0; i < 3; i++) app.updatePlayerFromPose(pose);
  assert.equal(app.state.isDucking, false);
});

test('crouching clears beams, crates cost a life, and a completed round ends at 30 seconds', () => {
  const app = harness();
  app.state.phase = 'playing'; app.state.playerPosition = 0; app.state.isDucking = true;
  app.handleCollision({ kind: 'beam', lane: 1 });
  assert.equal(app.state.lives, 3); assert.equal(app.state.dodges, 1);
  app.handleCollision({ kind: 'crate', lane: 1 });
  assert.equal(app.state.lives, 2);
  app.state.nextObstacleAt = Infinity;
  app.state.gameTime = 29.98;
  app.updateGame(0.05);
  assert.equal(app.state.phase, 'over'); assert.equal(app.state.finishedByTime, true);
});

test('slow rendering counts the full elapsed time toward the 30-second round', () => {
  const app = harness();
  app.state.phase = 'playing'; app.state.previousFrame = 1000;
  app.state.nextObstacleAt = Infinity;
  app.updateFrame(3500);
  assert.equal(app.state.gameTime, 2.5);
});

