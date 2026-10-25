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
  let cameraConstraints = null;
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
      appendChild(child) { child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1); this.children.push(child); child.parentElement = this; return child; },
      insertBefore(child, before) { child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1); const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; return child; },
      getContext: () => context2d, querySelector: (selector) => element(id + selector),
      play: async () => {}, readyState: 4, currentTime: 1,
    };
    elements.set(id, el);
    el.children = id === 'hearts' ? [element('heart0'), element('heart1'), element('heart2')] : [];
    return el;
  }
  element('cameraPreview').parentElement = element('cameraCard');
  const setTimer = (callback) => { const id = ++timerId; timers.set(id, callback); return id; };
  const window = { matchMedia: () => ({ matches: true }), isSecureContext: true, addEventListener() {}, setTimeout: setTimer };
  const sandbox = {
    console, Math, Date, DOMException, window,
    document: { body: element('body'), getElementById: element, addEventListener() {} },
    location: { hostname: 'localhost' },
    navigator: { mediaDevices: { getUserMedia: permission ?? (async (constraints) => { cameraConstraints = constraints; return stream; }) } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    performance: { now: () => time },
    requestAnimationFrame() {}, setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
    __deps: { loadPoseDetector: detectorLoader ?? (async () => detector) },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]+\n/, 'const { loadPoseDetector } = globalThis.__deps;\n') + '\nglobalThis.app = {state, ui, startCamera, stopCamera, backToHome, handlePose, beginGame, failCamera, updateGame, updateFrame, updatePlayerFromPose, hitDanceAction, buildDanceChart, extractBody, endGame, setCameraPresentation};', sandbox);
  const app = sandbox.app;
  const calibrate = () => {
    for (let i = 0; i < 15; i++) { time += 150; app.handlePose({ ...pose }); }
  };
  return { ...app, stream, detector, timers, calibrate, documentBody: element('body'), tick: (ms) => { time += ms; }, stopped: () => stopped, closed: () => closed, constraints: () => cameraConstraints };
}

test('camera play requests a portrait 9:16 stream and moves the preview into the AR stage', async () => {
  const app = harness();
  await app.startCamera();
  assert.equal(app.constraints().video.aspectRatio.ideal, 9 / 16);
  assert.equal(app.ui.cameraPreview.parentElement, app.ui.arStage);
  assert.equal(app.state.mode, 'camera');
  assert.equal(app.ui.gameCanvas.width, 540);
  assert.equal(app.ui.gameCanvas.height, 960);
  assert.equal(app.documentBody.classList.contains('camera-ar-mode'), true);
  app.stopCamera();
  assert.equal(app.ui.cameraPreview.parentElement, app.ui.cameraCard);
  assert.equal(app.ui.gameCanvas.width, 960);
  assert.equal(app.ui.gameCanvas.height, 600);
  assert.equal(app.documentBody.classList.contains('camera-ar-mode'), false);
});

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

test('camera restart after game over resets score, lives, streak and dance chart', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate();
  app.state.phase = 'over'; app.state.lives = 0; app.state.score = 900;
  app.state.notes = [{ action: 'left', time: 1, lane: 0, judged: false }];
  app.beginGame('camera');
  assert.equal(app.state.phase, 'countdown');
  assert.equal(app.state.lives, 3);
  assert.equal(app.state.score, 0);
  assert.equal(app.state.notes.length, 48);
  assert.equal(app.state.combo, 0);
});

test('starting with stale tracking recalibrates instead of starting a blind game', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate(); app.tick(1400);
  await app.startCamera();
  assert.equal(app.state.phase, 'calibrating');
  assert.equal(app.timers.size, 0);
});

test('mirrored lateral motion and crouching create dance steps after calibration', async () => {
  const app = harness();
  await app.startCamera(); app.calibrate(); app.beginGame('camera');
  app.state.phase = 'playing';
  app.state.gameTime = app.state.notes.find((note) => note.action === 'right').time;
  app.updatePlayerFromPose({ ...pose, shoulderX: 0.3 });
  assert.equal(app.state.targetLane, 2);
  assert.equal(app.state.hits, 1);
  app.state.gameTime = app.state.notes.find((note) => note.action === 'down').time;
  for (let i = 0; i < 2; i++) app.updatePlayerFromPose({ ...pose, shoulderY: 0.45, hipY: 0.7 });
  assert.equal(app.state.isDucking, true);
  assert.equal(app.state.hits, 2);
  for (let i = 0; i < 3; i++) app.updatePlayerFromPose(pose);
  assert.equal(app.state.isDucking, false);
});

test('dance chart hits award perfect and good scores inside their timing windows', () => {
  const app = harness();
  app.state.phase = 'playing'; app.state.notes = app.buildDanceChart();
  const perfect = app.state.notes[0]; app.state.gameTime = perfect.time + 0.08;
  assert.equal(app.hitDanceAction(perfect.action), true);
  assert.equal(app.state.score, 100); assert.equal(app.state.combo, 1);
  const good = app.state.notes.find((note) => !note.judged);
  app.state.gameTime = good.time + 0.28;
  assert.equal(app.hitDanceAction(good.action), true);
  assert.equal(app.state.score, 160); assert.equal(app.state.combo, 2);
  assert.equal(app.state.bestCombo, 2);
});

test('a completed 30-second dance round ends with the success result', () => {
  const app = harness();
  app.state.phase = 'playing'; app.state.notes = app.buildDanceChart();
  for (let i = 0; i < 3; i++) app.state.notes[i].judged = true;
  app.state.misses = 3; app.state.missStreak = 0;
  app.state.notes = [];
  app.state.nextObstacleAt = Infinity;
  app.state.gameTime = 29.98;
  app.updateGame(0.05);
  assert.equal(app.state.phase, 'over'); assert.equal(app.state.finishedByTime, true);
});

test('a late note consumes a life only after three consecutive misses', () => {
  const app = harness();
  app.state.phase = 'playing';
  app.state.notes = [0, 1, 2].map((index) => ({ action: 'left', lane: 0, time: index + 1, judged: false }));
  app.state.gameTime = 4;
  app.updateGame(0.01);
  assert.equal(app.state.misses, 3);
  assert.equal(app.state.lives, 2);
  assert.equal(app.state.phase, 'playing');
});

test('both raised wrists are recognized as an up step', async () => {
  const app = harness();
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  landmarks[11] = { x: 0.4, y: 0.3, visibility: 1 }; landmarks[12] = { x: 0.6, y: 0.3, visibility: 1 };
  landmarks[23] = { x: 0.43, y: 0.6, visibility: 1 }; landmarks[24] = { x: 0.57, y: 0.6, visibility: 1 };
  landmarks[15].y = 0.15; landmarks[16].y = 0.15;
  assert.equal(app.extractBody(landmarks).armsRaised, true);
  app.state.phase = 'playing'; app.state.baseline = { mirroredX: 0.5, shoulderY: 0.3, hipY: 0.6, torsoScale: 0.3, laneThreshold: 0.12 };
  app.state.notes = app.buildDanceChart();
  app.state.gameTime = app.state.notes.find((note) => note.action === 'up').time;
  app.updatePlayerFromPose(app.extractBody(landmarks));
  app.updatePlayerFromPose(app.extractBody(landmarks));
  assert.equal(app.state.hits, 1);
  assert.equal(app.state.activePad, 'up');
});

test('slow rendering counts the full elapsed time toward the 30-second round', () => {
  const app = harness();
  app.state.phase = 'playing'; app.state.previousFrame = 1000;
  app.state.nextObstacleAt = Infinity;
  app.updateFrame(3500);
  assert.equal(app.state.gameTime, 2.5);
});
