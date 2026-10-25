import { loadPoseDetector } from './pose-detector.mjs?v=0.3.2';

const WORLD = { width: 960, height: 600, horizon: 155, finishLine: 0.96 };
const WIDE_WORLD = { width: 960, height: 600, horizon: 155 };
const PORTRAIT_WORLD = { width: 540, height: 960, horizon: 248 };
const LANE_OFFSET = [-1, 0, 1];
const DANCE_BPM = 103;
const BEAT = 60 / DANCE_BPM;
const NOTE_TRAVEL = 1.65;
const PERFECT_WINDOW = 0.17;
const GOOD_WINDOW = 0.38;
const CALIBRATION_SAMPLES_REQUIRED = 8;
const CALIBRATION_STABLE_MS = 1350;
const CALIBRATION_GAP_MS = 1800;
const ACTIONS = ['left', 'down', 'up', 'right'];
const ACTION_LABELS = { left: 'IZQUIERDA', down: 'ABAJO', up: 'ARRIBA', right: 'DERECHA' };
const ACTION_GLYPHS = { left: '←', down: '↓', up: '↑', right: '→' };
const ACTION_COLORS = { left: '#69d9ff', down: '#c3f66b', up: '#ffcf65', right: '#ff6cae' };
const DANCE_CHART = ['left', 'right', 'up', 'down', 'left', 'down', 'right', 'up', 'down', 'left', 'up', 'right', 'left', 'down', 'up', 'right'];
const ELEMENTS = [
  'gameCanvas', 'gameFrame', 'arStage', 'gameWave', 'scoreValue', 'timerValue', 'timerFill', 'hearts',
  'startOverlay', 'calibrationOverlay', 'pauseOverlay', 'gameOverOverlay', 'countdownOverlay',
  'calibrationIcon', 'calibrationLabel', 'calibrationTitle', 'calibrationHint', 'calibrationProgress', 'calibrationFootnote',
  'calibrationCancel', 'pauseEyebrow', 'pauseTitle', 'pauseHint', 'resumeButton', 'pauseQuit',
  'gameOverEyebrow', 'gameOverTitle', 'gameOverText', 'finalScore', 'restartButton', 'gameOverHome',
  'countdownNumber', 'cameraStart', 'manualStart', 'cameraPreview', 'cameraVideo', 'poseCanvas', 'cameraPlaceholder',
  'cameraRec', 'trackingIndicator', 'trackingLabel', 'cameraCard', 'cameraState', 'controlStatus',
  'lanePip', 'pauseButton', 'manualPanel', 'leftControl', 'rightControl', 'duckControl', 'upControl',
  'fullscreenBtn', 'muteBtn', 'gameHud', 'cameraError', 'cameraErrorMessage',
];
const ui = Object.fromEntries(ELEMENTS.map((id) => [id, document.getElementById(id)]));
const canvas = ui.gameCanvas;
const ctx = canvas.getContext('2d');
const video = ui.cameraVideo;
const poseCtx = ui.poseCanvas.getContext('2d');
const MOTION_REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  phase: 'idle', mode: null, stream: null, detectorReady: false,
  gameTime: 0, clock: 0, previousFrame: 0, lastDetectionAt: 0,
  lastVideoTime: -1, lastBodyAt: 0, playerLane: 1, targetLane: 1, playerPosition: 0, isDucking: false,
  lives: 3, score: 0, combo: 0, bestCombo: 0, hits: 0, misses: 0, notes: [], activePad: null,
  effects: [], stars: [], shake: 0, muted: false, audio: null,
  calibrationSamples: [], calibrationStarted: 0, calibrationWaitStarted: 0, baseline: null, calibrationHold: false,
  body: null, highStreak: 0, lowStreak: 0, armStreak: 0, missStreak: 0, bodyAction: null,
  cameraError: '', cameraSession: 0, finishedByTime: false, detector: null,
};

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, amount) => a + (b - a) * amount;
const padScore = (value) => Math.floor(value).toString().padStart(6, '0');
const isVisible = (element) => Boolean(element && !element.classList.contains('hidden'));

function setOverlay(name) {
  for (const id of ['startOverlay', 'calibrationOverlay', 'pauseOverlay', 'gameOverOverlay', 'countdownOverlay']) {
    ui[id].classList.toggle('hidden', id !== name);
  }
}

function setControlStatus(message, variant = '') {
  ui.controlStatus.textContent = message;
  ui.lanePip.className = `status-pip ${variant}`.trim();
}

function setCameraState(message, active = false) {
  ui.cameraState.innerHTML = `<span class="state-dot"></span> ${message}`;
  ui.cameraState.classList.toggle('is-active', active);
  ui.cameraCard.classList.toggle('camera-error', !active && message === 'NO DISPONIBLE');
}

function renderLives() {
  for (const [index, heart] of [...ui.hearts.children].entries()) {
    heart.classList.toggle('is-lost', index >= state.lives);
  }
  ui.hearts.setAttribute('aria-label', `${state.lives} ${state.lives === 1 ? 'vida' : 'vidas'} restantes`);
}

function setCameraPresentation(active) {
  const world = active ? PORTRAIT_WORLD : WIDE_WORLD;
  WORLD.width = world.width;
  WORLD.height = world.height;
  WORLD.horizon = world.horizon;
  canvas.width = world.width;
  canvas.height = world.height;
  document.body.classList.toggle('camera-ar-mode', active);
  if (active) {
    ui.arStage.appendChild(ui.cameraPreview);
  } else if (ui.cameraPreview.parentElement !== ui.cameraCard) {
    ui.cameraCard.insertBefore(ui.cameraPreview, ui.cameraCard.querySelector('.camera-foot'));
  }
  createStars();
}

function setTracking(found) {
  ui.trackingIndicator.classList.toggle('is-tracking', found);
  ui.trackingLabel.textContent = found ? 'SIGUIÉNDOTE'
    : state.mode !== 'camera' ? 'ESPERANDO' : state.detectorReady ? 'BUSCANDO' : 'PREPARANDO';
}

function paintPosePreview(body) {
  const width = ui.poseCanvas.width;
  const height = ui.poseCanvas.height;
  poseCtx.clearRect(0, 0, width, height);
  if (!body?.outline) return;

  const edges = [[0, 1], [0, 2], [1, 3], [2, 4], [4, 5], [3, 6], [6, 7], [7, 5]];
  poseCtx.lineWidth = 4;
  poseCtx.lineCap = 'round';
  poseCtx.lineJoin = 'round';
  poseCtx.strokeStyle = 'rgba(255, 107, 54, .92)';
  for (const [first, second] of edges) {
    const start = body.outline[first];
    const end = body.outline[second];
    if (!start || !end) continue;
    poseCtx.beginPath();
    poseCtx.moveTo(start.x * width, start.y * height);
    poseCtx.lineTo(end.x * width, end.y * height);
    poseCtx.stroke();
  }
  poseCtx.fillStyle = '#f5efbe';
  for (const landmark of body.outline) {
    if (!landmark) continue;
    poseCtx.beginPath();
    poseCtx.arc(landmark.x * width, landmark.y * height, 3, 0, Math.PI * 2);
    poseCtx.fill();
  }
}

function updatePlayerFromPose(body) {
  if (!body || !state.baseline || state.phase === 'calibrating') return;
  const baseline = state.baseline;
  // The webcam preview is mirrored, so moving toward the user's right increases this value.
  const mirroredDx = (1 - body.shoulderX) - baseline.mirroredX;
  const steps = clamp(Math.round(mirroredDx / baseline.laneThreshold), -1, 1);
  state.targetLane = 1 + steps;

  const shoulderDrop = body.shoulderY - baseline.shoulderY;
  const hipDrop = body.hipY - baseline.hipY;
  const duckSignal = shoulderDrop > baseline.torsoScale * 0.19 && hipDrop > baseline.torsoScale * 0.11;
  if (duckSignal) {
    state.highStreak = Math.min(5, state.highStreak + 1);
    state.lowStreak = 0;
  } else {
    state.lowStreak = Math.min(8, state.lowStreak + 1);
    state.highStreak = 0;
  }

  if (state.highStreak >= 2) state.isDucking = true;
  if (state.lowStreak >= 3) state.isDucking = false;

  state.armStreak = body.armsRaised ? Math.min(5, state.armStreak + 1) : 0;
  const action = state.highStreak >= 2 ? 'down'
    : state.armStreak >= 2 ? 'up'
      : steps < 0 ? 'left' : steps > 0 ? 'right' : null;
  if (action && action !== state.bodyAction && state.phase === 'playing') hitDanceAction(action);
  state.bodyAction = action;
}

function makeBaseline(samples) {
  const average = (key) => samples.reduce((total, sample) => total + sample[key], 0) / samples.length;
  const shoulderWidth = average('shoulderWidth');
  return {
    mirroredX: 1 - average('shoulderX'),
    shoulderY: average('shoulderY'),
    hipY: average('hipY'),
    torsoScale: average('torsoScale'),
    laneThreshold: Math.max(0.055, shoulderWidth * 0.48),
  };
}

function drawBackground(time) {
  const { width, height, horizon } = WORLD;
  if (document.body.classList.contains('camera-ar-mode')) {
    ctx.clearRect(0, 0, width, height);
    return;
  }
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#171425');
  sky.addColorStop(0.37, '#151425');
  sky.addColorStop(0.69, '#1a1626');
  sky.addColorStop(1, '#100f19');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const horizonLight = ctx.createRadialGradient(width / 2, horizon + 50, 12, width / 2, horizon + 50, 400);
  horizonLight.addColorStop(0, 'rgba(255, 95, 112, .2)');
  horizonLight.addColorStop(0.3, 'rgba(153, 92, 186, .1)');
  horizonLight.addColorStop(1, 'rgba(16, 15, 25, 0)');
  ctx.fillStyle = horizonLight;
  ctx.fillRect(0, horizon - 30, width, 390);

  for (const star of state.stars) {
    const starRange = height - horizon;
    const y = horizon + ((star.y + time * star.speed) % starRange);
    const fade = Math.sin((y - horizon) / starRange * Math.PI) * star.alpha;
    ctx.fillStyle = `rgba(220, 204, 255, ${Math.max(0, fade)})`;
    ctx.beginPath();
    ctx.arc(star.x, y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(239, 108, 167, .08)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 9; index += 1) {
    const x = index * width / 8;
    ctx.beginPath();
    ctx.moveTo(width / 2, horizon + 49);
    ctx.lineTo(x, height + 2);
    ctx.stroke();
  }
  for (let index = 1; index <= 11; index += 1) {
    const phase = ((index * 0.115 + time * 0.24) % 1);
    const progress = phase * phase;
    const y = horizon + progress * (height - horizon);
    const half = width * (0.075 + progress * 0.45);
    ctx.beginPath();
    ctx.moveTo(width / 2 - half, y);
    ctx.lineTo(width / 2 + half, y);
    ctx.strokeStyle = `rgba(228, 111, 171, ${0.035 + progress * 0.07})`;
    ctx.lineWidth = 0.7 + progress * 1.2;
    ctx.stroke();
  }

  // A glowing three-lane runway that narrows into the violet horizon.
  ctx.beginPath();
  ctx.moveTo(width / 2 - 99, horizon + 9);
  ctx.lineTo(width / 2 + 99, horizon + 9);
  ctx.lineTo(width / 2 + 397, height + 5);
  ctx.lineTo(width / 2 - 397, height + 5);
  ctx.closePath();
  const runway = ctx.createLinearGradient(0, horizon, 0, height);
  runway.addColorStop(0, 'rgba(80, 57, 94, .4)');
  runway.addColorStop(1, 'rgba(40, 30, 48, .83)');
  ctx.fillStyle = runway;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(width / 2 - 98, horizon + 10);
  ctx.lineTo(width / 2 + 98, horizon + 10);
  ctx.lineTo(width / 2 + 397, height + 4);
  ctx.lineTo(width / 2 - 397, height + 4);
  ctx.closePath();
  ctx.clip();

  for (const laneEdge of [-0.5, 0.5]) {
    const topX = width / 2 + laneEdge * 132;
    const bottomX = width / 2 + laneEdge * 530;
    ctx.beginPath();
    ctx.moveTo(topX, horizon + 10);
    ctx.lineTo(bottomX, height + 5);
    ctx.strokeStyle = 'rgba(204, 151, 245, .38)';
    ctx.setLineDash([4, 17]);
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#ba84f9';
    ctx.shadowBlur = 7;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  }
  ctx.restore();

  for (const edge of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(width / 2 + edge * 99, horizon + 9);
    ctx.lineTo(width / 2 + edge * 397, height + 5);
    ctx.strokeStyle = 'rgba(255, 108, 185, .29)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ff49a3';
    ctx.shadowBlur = 9;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const horizonLine = ctx.createLinearGradient(175, 0, 785, 0);
  horizonLine.addColorStop(0, 'rgba(255, 77, 159, 0)');
  horizonLine.addColorStop(0.5, 'rgba(255, 105, 173, .7)');
  horizonLine.addColorStop(1, 'rgba(255, 77, 159, 0)');
  ctx.strokeStyle = horizonLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(177, horizon + 9);
  ctx.lineTo(783, horizon + 9);
  ctx.stroke();
}

function getProjection(lanePosition, depth) {
  const perspective = Math.pow(clamp(depth, 0, 1.14), 1.43);
  const trackHalfWidth = 94 + perspective * 284;
  return {
    x: WORLD.width / 2 + lanePosition * (63 + perspective * 225),
    y: WORLD.horizon + 12 + perspective * 402,
    scale: 0.23 + perspective * 1.02,
    trackHalfWidth,
  };
}

function drawBlock(obstacle) {
  const projection = getProjection(LANE_OFFSET[obstacle.lane], obstacle.depth);
  const { x, y, scale } = projection;
  const size = clamp(scale, 0.22, 1.5);

  if (obstacle.kind === 'beam') {
    const w = (65 + scale * 49) * scale;
    const h = (10 + scale * 13) * scale;
    ctx.save();
    ctx.shadowColor = '#ff49a3';
    ctx.shadowBlur = 12 * size;
    const bar = ctx.createLinearGradient(x - w / 2, y - h, x + w / 2, y);
    bar.addColorStop(0, '#ffb16d');
    bar.addColorStop(0.5, '#ff579f');
    bar.addColorStop(1, '#bb74ff');
    ctx.fillStyle = bar;
    roundRect(x - w / 2, y - h * 1.6, w, h, 4 * size);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(19, 17, 26, .87)';
    roundRect(x - w * 0.38, y - h * 1.1, w * 0.76, h * 0.68, 3 * size);
    ctx.fill();
    ctx.restore();
  } else {
    const w = (25 + scale * 35) * scale;
    const h = (21 + scale * 28) * scale;
    ctx.save();
    ctx.shadowColor = '#ff794f';
    ctx.shadowBlur = 13 * size;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h);
    ctx.lineTo(x, y - h * 1.24);
    ctx.lineTo(x + w / 2, y - h);
    ctx.lineTo(x + w / 2, y);
    ctx.lineTo(x - w / 2, y);
    ctx.closePath();
    const crate = ctx.createLinearGradient(x - w / 2, y - h, x + w / 2, y);
    crate.addColorStop(0, '#ffb45e');
    crate.addColorStop(0.55, '#ff7047');
    crate.addColorStop(1, '#df406f');
    ctx.fillStyle = crate;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(57, 24, 42, .55)';
    ctx.lineWidth = 2 * size;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.27, y - h * 0.77);
    ctx.lineTo(x + w * 0.27, y - h * 0.24);
    ctx.moveTo(x + w * 0.27, y - h * 0.77);
    ctx.lineTo(x - w * 0.27, y - h * 0.24);
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, r);
}

function drawRunner(time) {
  const laneX = state.playerPosition;
  // Use the eased position for both drawing and collision checks.
  const projection = getProjection(laneX, 0.91);
  const cx = projection.x;
  const duck = state.isDucking;
  const bob = duck ? 0 : Math.sin(time * 12) * 3;
  const ground = 489;
  const scale = 0.86;
  const torsoY = duck ? 454 : 423;
  const hipY = duck ? 476 : 458;
  const headY = duck ? 438 : 395 + bob;
  const bodyColor = state.mode === 'camera' ? '#9df4ea' : '#efd2ff';
  const ink = '#1c1830';

  ctx.save();
  ctx.fillStyle = 'rgba(7, 7, 15, .58)';
  ctx.beginPath();
  ctx.ellipse(cx, ground + 3, duck ? 31 : 24, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8 * scale;
  ctx.strokeStyle = ink;
  ctx.beginPath();
  ctx.moveTo(cx, torsoY + 22);
  ctx.lineTo(cx - (duck ? 16 : 10), hipY);
  ctx.lineTo(cx + (duck ? 15 : 8), hipY - 1);
  ctx.moveTo(cx - 6, hipY);
  ctx.lineTo(cx - (duck ? 27 : 13), ground - (duck ? 1 : 21));
  ctx.moveTo(cx + 6, hipY);
  ctx.lineTo(cx + (duck ? 25 : 16), ground - (duck ? 1 : 24));
  ctx.moveTo(cx - 7, torsoY + 7);
  ctx.lineTo(cx - (duck ? 23 : 21), torsoY + (duck ? 16 : 25));
  ctx.lineTo(cx - (duck ? 31 : 16), torsoY + (duck ? 21 : 47));
  ctx.moveTo(cx + 7, torsoY + 7);
  ctx.lineTo(cx + (duck ? 18 : 20), torsoY + (duck ? 16 : 22));
  ctx.lineTo(cx + (duck ? 24 : 13), torsoY + (duck ? 24 : 43));
  ctx.stroke();

  ctx.lineWidth = 4.5 * scale;
  ctx.strokeStyle = bodyColor;
  ctx.shadowColor = bodyColor;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(cx, torsoY + 23);
  ctx.lineTo(cx + (duck ? -1 : 0), hipY);
  ctx.moveTo(cx - 5, hipY + 1);
  ctx.lineTo(cx - (duck ? 22 : 12), ground - (duck ? 2 : 19));
  ctx.moveTo(cx + 5, hipY + 1);
  ctx.lineTo(cx + (duck ? 20 : 15), ground - (duck ? 2 : 22));
  ctx.moveTo(cx - 5, torsoY + 10);
  ctx.lineTo(cx - (duck ? 23 : 18), torsoY + (duck ? 19 : 28));
  ctx.lineTo(cx - (duck ? 30 : 15), torsoY + (duck ? 24 : 46));
  ctx.moveTo(cx + 5, torsoY + 10);
  ctx.lineTo(cx + (duck ? 17 : 17), torsoY + (duck ? 18 : 26));
  ctx.lineTo(cx + (duck ? 24 : 13), torsoY + (duck ? 25 : 43));
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#f4be98';
  ctx.beginPath();
  ctx.arc(cx, headY, duck ? 10 : 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#21182e';
  ctx.beginPath();
  ctx.arc(cx, headY - 3, 10, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c1f66b';
  for (const footX of [cx - (duck ? 31 : 16), cx + (duck ? 25 : 16)]) {
    roundRect(footX - 6, ground - 3, 15, 7, 3);
    ctx.fill();
  }
  ctx.restore();
}

function drawEffects(dt) {
  for (let index = state.effects.length - 1; index >= 0; index -= 1) {
    const effect = state.effects[index];
    effect.life -= dt;
    effect.y -= dt * 22;
    if (effect.life <= 0) {
      state.effects.splice(index, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = clamp(effect.life / effect.duration, 0, 1);
    ctx.font = '700 14px "Barlow Condensed", sans-serif';
    ctx.letterSpacing = '1.5px';
    ctx.textAlign = 'center';
    ctx.fillStyle = effect.color;
    ctx.shadowColor = effect.color;
    ctx.shadowBlur = 10;
    ctx.fillText(effect.text, effect.x, effect.y);
    ctx.restore();
  }
}

function drawScene(time, dt) {
  if (MOTION_REDUCED.matches) time *= 0.25;
  drawBackground(time);
  drawDanceTrack();
  drawEffects(dt);
}

function drawDanceTrack() {
  const { width, height, horizon } = WORLD;
  const topY = horizon + height * 0.035;
  const hitY = height * 0.835;
  const topWidth = width * 0.64;
  const topLeft = (width - topWidth) / 2;
  const bottomWidth = width * 0.94;
  const bottomLeft = (width - bottomWidth) / 2;
  const trackBottom = Math.min(height - 12, hitY + height * 0.055);
  const laneWidth = bottomWidth / 4;
  const padHeight = Math.max(46, height * 0.058);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topLeft, topY); ctx.lineTo(topLeft + topWidth, topY);
  ctx.lineTo(bottomLeft + bottomWidth, trackBottom); ctx.lineTo(bottomLeft, trackBottom);
  ctx.closePath();
  const cameraOverlay = document.body.classList.contains('camera-ar-mode');
  ctx.fillStyle = cameraOverlay ? 'rgba(12, 9, 22, .22)' : 'rgba(12, 9, 22, .94)'; ctx.fill();
  for (let lane = 0; lane < 4; lane += 1) {
    const color = ACTION_COLORS[ACTIONS[lane]];
    const xTop = topLeft + lane * topWidth / 4;
    const xBottom = bottomLeft + lane * bottomWidth / 4;
    ctx.beginPath();
    ctx.moveTo(xTop, topY); ctx.lineTo(xTop + topWidth / 4, topY);
    ctx.lineTo(xBottom + laneWidth, trackBottom); ctx.lineTo(xBottom, trackBottom);
    ctx.closePath();
    ctx.fillStyle = cameraOverlay
      ? (lane % 2 ? 'rgba(34, 23, 48, .12)' : 'rgba(23, 18, 38, .16)')
      : (lane % 2 ? 'rgba(34, 23, 48, .88)' : 'rgba(23, 18, 38, .9)'); ctx.fill();
    ctx.strokeStyle = `${color}55`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xTop, topY); ctx.lineTo(xBottom, hitY + 35); ctx.stroke();
    const padX = xBottom + laneWidth / 2;
    const padWidth = laneWidth * 0.76;
    const padY = hitY - padHeight / 2;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = state.activePad === ACTIONS[lane] ? 24 : 9;
    ctx.fillStyle = state.activePad === ACTIONS[lane] ? `${color}66` : `${color}20`;
    roundRect(padX - padWidth / 2, padY, padWidth, padHeight, Math.min(10, padHeight / 4)); ctx.fill();
    ctx.strokeStyle = `${color}${state.activePad === ACTIONS[lane] ? 'ff' : '99'}`; ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(Math.min(30, padHeight * 0.55))}px "DM Sans", sans-serif`; ctx.fillText(ACTION_GLYPHS[ACTIONS[lane]], padX, hitY);
    ctx.restore();
  }
  ctx.strokeStyle = '#f6e6ff'; ctx.lineWidth = 2; ctx.shadowColor = '#ff49a3'; ctx.shadowBlur = 13;
  ctx.beginPath(); ctx.moveTo(bottomLeft, hitY - padHeight * 0.72); ctx.lineTo(bottomLeft + bottomWidth, hitY - padHeight * 0.72); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f3d9ff'; ctx.font = '700 13px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('¡PISÁ AL RITMO!', width / 2, horizon - height * 0.025);
  for (const note of state.notes) {
    if (note.judged) continue;
    const progress = 1 - (note.time - state.gameTime) / NOTE_TRAVEL;
    if (progress < 0 || progress > 1.08) continue;
    const y = topY + progress * (hitY - topY - 34);
    const x = bottomLeft + (note.lane + 0.5) * laneWidth;
    const noteWidth = Math.min(laneWidth * 0.78, laneWidth * (0.36 + progress * 0.22));
    const noteHeight = Math.max(25, height * (0.027 + progress * 0.025));
    const color = ACTION_COLORS[note.action];
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.fillStyle = color; roundRect(x - noteWidth / 2, y - noteHeight / 2, noteWidth, noteHeight, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#17121f'; ctx.font = `900 ${Math.round(22 + progress * 6)}px "DM Sans", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ACTION_GLYPHS[note.action], x, y);
    ctx.restore();
  }
  ctx.restore();
}

function createStars() {
  state.stars = Array.from({ length: 60 }, () => ({
    x: rand(12, WORLD.width - 12), y: rand(0, WORLD.height - WORLD.horizon), speed: rand(8, 38), radius: rand(0.5, 1.35), alpha: rand(0.18, 0.62),
  }));
}

function addPop(text, lane, color) {
  state.effects.push({ text, x: WORLD.width / 2, y: 282, color, life: 0.7, duration: 0.7 });
}

function buildDanceChart() {
  const notes = [];
  for (let index = 0, time = 2.25; time < 30; index += 1, time += BEAT) {
    const action = DANCE_CHART[index % DANCE_CHART.length];
    notes.push({ action, lane: ACTIONS.indexOf(action), time, judged: false });
  }
  return notes;
}

function hitDanceAction(action) {
  if (state.phase !== 'playing') return false;
  state.activePad = action;
  const note = state.notes.filter((item) => !item.judged && item.action === action)
    .sort((a, b) => Math.abs(a.time - state.gameTime) - Math.abs(b.time - state.gameTime))[0];
  if (!note || Math.abs(note.time - state.gameTime) > GOOD_WINDOW) {
    addPop(note ? '¡MÁS CERCA DEL RITMO!' : '¡SEGUÍ EL RITMO!', 0, '#ffb45e');
    return false;
  }
  note.judged = true;
  const perfect = Math.abs(note.time - state.gameTime) <= PERFECT_WINDOW;
  state.hits += 1;
  state.missStreak = 0;
  state.combo += 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  state.score += perfect ? 100 : 60;
  addPop(perfect ? `¡PERFECT! ${state.combo}×` : `¡BIEN! ${state.combo}×`, note.lane, perfect ? ACTION_COLORS[action] : '#c3f66b');
  if (!state.muted) playChime();
  ui.gameWave.innerHTML = `RACHA <b>${state.combo}</b>`;
  return true;
}

function missDanceNote(note) {
  note.judged = true;
  state.misses += 1;
  state.missStreak += 1;
  state.combo = 0;
  if (state.missStreak >= 3) {
    state.missStreak = 0;
    state.lives -= 1;
    addPop('¡VIDA MENOS!', note.lane, '#ff607f');
    renderLives();
    if (!state.muted) playChime(true);
    if (state.lives <= 0) endGame(false);
  } else {
    addPop('¡SE ESCAPÓ!', note.lane, '#ffb45e');
  }
}

function updateHUD() {
  const remaining = Math.max(0, 30 - state.gameTime);
  const totalSeconds = Math.ceil(remaining);
  ui.scoreValue.textContent = padScore(state.score);
  ui.timerValue.textContent = `00:${String(totalSeconds).padStart(2, '0')}`;
  ui.timerFill.style.width = `${(remaining / 30) * 100}%`;
  ui.timerFill.classList.toggle('is-low', remaining <= 8);
  ui.gameWave.innerHTML = `RACHA <b>${state.combo}</b>`;
}

function updateGame(dt) {
  if (state.phase !== 'playing') return;
  state.gameTime = Math.min(30, state.gameTime + dt);
  state.shake = Math.max(0, state.shake - dt);
  state.activePad = null;
  if (!state.muted && state.gameTime >= state.nextBeatAt) {
    playBeatTick();
    state.nextBeatAt += BEAT;
  }
  for (const note of state.notes) {
    if (state.phase !== 'playing') break;
    if (!note.judged && state.gameTime > note.time + GOOD_WINDOW) missDanceNote(note);
  }
  updateHUD();

  if (state.gameTime >= 30 && state.phase === 'playing') endGame(true);
}

function updateFrame(now) {
  const gameElapsed = Math.max(0, (now - (state.previousFrame || now)) / 1000);
  const elapsed = Math.min(0.05, gameElapsed);
  state.previousFrame = now;
  state.clock += gameElapsed;
  updateGame(gameElapsed);

  // MediaPipe runs on the main thread: WebGL/WASM are more reliable on mobile
  // than inside a module Worker. Throttle inference to keep rendering responsive.
  if (state.mode === 'camera' && state.detectorReady && state.detector &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      now - state.lastDetectionAt > 125 && video.currentTime !== state.lastVideoTime) {
    state.lastDetectionAt = now;
    state.lastVideoTime = video.currentTime;
    try {
      const result = state.detector.detectForVideo(video, now);
      const landmarks = result.landmarks?.[0];
      handlePose(landmarks ? extractBody(landmarks) : null);
    } catch (error) {
      console.error('[Body Dodge] Falló la inferencia:', error);
      failCamera('La detección se interrumpió: ' + (error?.message || 'error desconocido'));
    }
  }

  if (state.phase === 'calibrating') {
    if (state.calibrationSamples.length && state.lastBodyAt && now - state.lastBodyAt > CALIBRATION_GAP_MS) {
      state.calibrationSamples = [];
      state.calibrationStarted = 0;
    }
    progressCalibration();
  }

  if (state.mode === 'camera' && state.phase === 'playing' && state.lastBodyAt > 0 && now - state.lastBodyAt > 1300) {
    pauseGame(true);
  }

  if (state.shake > 0 && !MOTION_REDUCED.matches) ctx.setTransform(1, 0, 0, 1, rand(-4, 4) * state.shake / 0.35, rand(-4, 4) * state.shake / 0.35);
  else ctx.setTransform(1, 0, 0, 1, 0, 0);

  drawScene(state.clock, elapsed);
  requestAnimationFrame(updateFrame);
}

function startCalibration() {
  stopReadyAutoStart();
  state.phase = 'calibrating';
  state.calibrationSamples = [];
  state.calibrationStarted = 0;
  state.calibrationWaitStarted = performance.now();
  state.calibrationHold = true;
  state.body = null;
  ui.calibrationIcon.textContent = '◉';
  ui.calibrationLabel.textContent = 'CÁMARA CONECTADA';
  ui.calibrationTitle.innerHTML = 'BUSCANDO<br /><span>TU POSE.</span>';
  ui.calibrationHint.textContent = 'Dejá el celular vertical y alejate hasta que se vean cabeza, hombros y caderas.';
  ui.calibrationFootnote.textContent = 'LA IMAGEN SE PROCESA EN TU DISPOSITIVO';
  ui.calibrationProgress.style.width = '0%';
  setCameraState('AJUSTANDO', true);
  setControlStatus('MOSTRÁ LOS HOMBROS Y LAS CADERAS');
  ui.cameraPlaceholder.classList.add('hidden');
  video.classList.add('is-active');
  ui.cameraRec.classList.remove('hidden');
  setOverlay('calibrationOverlay');
}

function progressCalibration() {
  const now = performance.now();
  const fraction = state.calibrationSamples.length
    ? Math.min(1, state.calibrationSamples.length / CALIBRATION_SAMPLES_REQUIRED, (now - state.calibrationStarted) / CALIBRATION_STABLE_MS)
    : 0;
  ui.calibrationProgress.style.width = `${Math.min(96, fraction * 100)}%`;
  const enoughSamples = state.calibrationSamples.length >= CALIBRATION_SAMPLES_REQUIRED;

  if (enoughSamples && fraction >= 1 && state.calibrationHold) {
    state.baseline = makeBaseline(state.calibrationSamples);
    state.targetLane = 1;
    state.playerLane = 1;
    state.playerPosition = 0;
    state.phase = 'ready';
    state.highStreak = 0;
    state.lowStreak = 0;
    state.isDucking = false;
    ui.cameraStart.disabled = false;
    ui.manualStart.disabled = false;
    ui.cameraStart.style.opacity = '';
    ui.manualStart.style.opacity = '';
    ui.cameraStart.style.cursor = '';
    setCameraState('LISTA', true);
    setControlStatus('CÁMARA LISTA · BAILÁ AL RITMO', 'active');
    setOverlay('startOverlay');
    ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">✳</span> YA ESTÁS EN LA PISTA';
    ui.startOverlay.querySelector('h2').innerHTML = 'TU CUERPO.<br /><span>TU JUEGO.</span>';
    ui.startOverlay.querySelector('p').textContent = '¡Listo! La cuenta regresiva empieza sola. Tocá para empezar ya.';
    ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> EMPEZAR AHORA <span class="button-arrow">→</span>';
    ui.manualStart.textContent = 'CAMBIAR A CONTROLES MANUALES';
    stopReadyAutoStart();
    readyAutoStartTimer = window.setTimeout(() => {
      readyAutoStartTimer = 0;
      if (state.phase === 'ready' && state.mode === 'camera') beginGame('camera');
    }, 1400);
  } else if (now - state.calibrationWaitStarted > 10000 && !enoughSamples && ui.calibrationLabel.textContent !== 'NO ENCONTRAMOS TU POSE') {
    ui.calibrationIcon.textContent = '↗';
    ui.calibrationLabel.textContent = 'NO ENCONTRAMOS TU POSE';
    ui.calibrationTitle.innerHTML = 'DALE, UN<br /><span>ÚLTIMO INTENTO.</span>';
    ui.calibrationHint.textContent = 'Alejá un poco el celular, mejorá la luz y asegurate de que tu cuerpo entre en el encuadre vertical.';
    ui.calibrationFootnote.textContent = 'CANCELÁ PARA CAMBIAR A LOS CONTROLES MANUALES';
    ui.calibrationProgress.style.width = '0%';
  } else if (enoughSamples && fraction < 1) {
    ui.calibrationIcon.textContent = '◉';
    ui.calibrationLabel.textContent = 'POSE DETECTADA';
    ui.calibrationTitle.innerHTML = 'CALIBRANDO<br /><span>ESTATE QUIETO.</span>';
    ui.calibrationHint.textContent = `Perfecto. Quedate quieto un momento… ${Math.ceil((1 - fraction) * 1.35)} s`;
  }
}

function handlePose(body) {
  if (body) {
    state.body = body;
    const now = performance.now();
    if (state.phase === 'calibrating') {
      if (state.calibrationSamples.length && state.lastBodyAt && now - state.lastBodyAt > CALIBRATION_GAP_MS) {
        state.calibrationSamples = [];
        state.calibrationStarted = now;
      }
      if (!state.calibrationSamples.length) state.calibrationStarted = now;
      state.calibrationSamples.push(body);
      if (state.calibrationSamples.length > 30) state.calibrationSamples.shift();
    }
    state.lastBodyAt = now;
    setTracking(true);
    paintPosePreview(body);
    updatePlayerFromPose(body);
    if (state.phase === 'paused' && ui.pauseEyebrow.textContent === 'TE PERDIMOS DE VISTA') {
      ui.pauseEyebrow.textContent = 'CÁMARA ACTIVA';
      ui.pauseTitle.innerHTML = 'YA VOLVISTE.<br /><span>¡SEGUÍ!</span>';
      ui.pauseHint.textContent = 'Te encontramos de nuevo. Tocá el botón y seguí el ritmo.';
      ui.resumeButton.disabled = false;
      ui.resumeButton.style.opacity = '';
      setControlStatus('CÁMARA ACTIVA · PODÉS SEGUIR', 'active');
    }
  } else {
    state.body = null;
    state.bodyAction = null;
    state.highStreak = 0;
    state.armStreak = 0;
    setTracking(false);
    poseCtx.clearRect(0, 0, ui.poseCanvas.width, ui.poseCanvas.height);
  }
  if (state.phase === 'calibrating') progressCalibration();
}

function extractBody(landmarks) {
  const visible = (point) => point && (point.visibility ?? point.presence ?? 1) >= 0.45;
  const ls = landmarks[11], rs = landmarks[12], lh = landmarks[23], rh = landmarks[24];
  if (![ls, rs, lh, rh].every(visible)) return null;
  return {
    shoulderX: (ls.x + rs.x) / 2,
    shoulderY: (ls.y + rs.y) / 2,
    hipY: (lh.y + rh.y) / 2,
    shoulderWidth: Math.abs(ls.x - rs.x),
    torsoScale: Math.max(0.08, Math.abs((lh.y + rh.y - ls.y - rs.y) / 2)),
    armsRaised: [15, 16].every(visible) && landmarks[15].y < ls.y - 0.035 && landmarks[16].y < rs.y - 0.035,
    outline: [11, 12, 14, 16, 24, 23, 25, 27].map((i) =>
      visible(landmarks[i]) ? { x: landmarks[i].x, y: landmarks[i].y } : null),
  };
}

async function createDetector(session) {
  const detector = await loadPoseDetector({
    isCurrent: () => session === state.cameraSession,
    onProgress: (message) => { ui.calibrationHint.textContent = message; },
  });
  if (session !== state.cameraSession) {
    detector.close();
    return;
  }
  state.detector = detector;
  state.detectorReady = true;
  startCalibration();
}

function resetStartButtons() {
  for (const button of [ui.cameraStart, ui.manualStart]) {
    button.disabled = false;
    button.style.opacity = '';
    button.style.cursor = '';
  }
}

function clearCameraError() {
  state.cameraError = '';
  ui.cameraError.classList.add('hidden');
  ui.cameraErrorMessage.textContent = '';
}

async function playCameraVideo() {
  let timer;
  try {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('La cámara no envió imágenes. Cerrá otras apps que usen la cámara y volvé a intentarlo.')), 12000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startCamera() {
  if (state.phase === 'loading' || state.phase === 'calibrating') return;
  if (state.phase === 'ready' && state.mode === 'camera') {
    beginGame('camera');
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    failCamera('Tu navegador no puede acceder a la cámara desde esta dirección. Probá localhost o la versión publicada en HTTPS.');
    return;
  }

  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    failCamera('La cámara necesita una conexión segura. Abrí la versión publicada en HTTPS o iniciá el juego desde tu computadora.');
    return;
  }

  clearCameraError();
  if (state.stream) stopCamera();
  const session = ++state.cameraSession;
  state.mode = 'camera';
  state.phase = 'loading';
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">♫</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = '¡A PISAR<br /><span>AL RITMO!</span>';
  ui.startOverlay.querySelector('p').textContent = 'Seguí las flechas: movete a los costados, levantá los brazos o agachate justo cuando llegan al piso.';
  ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> JUGAR CON CÁMARA <span class="button-arrow">→</span>';
  ui.manualStart.innerHTML = '<span aria-hidden="true">⌨</span> PROBAR CON TECLADO';
  setCameraState('CONECTANDO', true);
  setTracking(false);
  setControlStatus('CONECTANDO CÁMARA Y DETECTOR…');
  ui.gameHud.classList.remove('hidden');
  ui.cameraPlaceholder.classList.remove('hidden');
  ui.cameraCard.classList.remove('camera-error');
  ui.cameraStart.disabled = true;
  ui.manualStart.disabled = true;
  ui.cameraStart.style.opacity = '0.6';
  ui.manualStart.style.opacity = '0.6';
  ui.cameraStart.style.cursor = 'wait';
  setOverlay('calibrationOverlay');
  ui.calibrationIcon.textContent = '◉';
  ui.calibrationLabel.textContent = 'PREPARANDO TU CÁMARA';
  ui.calibrationTitle.innerHTML = 'CONECTANDO<br /><span>EL JUEGO.</span>';
  ui.calibrationHint.textContent = 'El detector se descarga una sola vez. Después procesa tus movimientos en este dispositivo.';
  ui.calibrationFootnote.textContent = 'LA IMAGEN NUNCA SALE DE TU DISPOSITIVO';
  ui.calibrationProgress.style.width = '0%';

  let stage = 'permission';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'user' }, aspectRatio: { ideal: 9 / 16 }, width: { ideal: 540 }, height: { ideal: 960 }, frameRate: { ideal: 24, max: 30 } },
    });
    if (session !== state.cameraSession) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    state.stream = stream;
    setCameraPresentation(true);
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      if (session === state.cameraSession) failCamera('La cámara se desconectó. Volvé a activarla para seguir jugando.');
    }, { once: true });
    stage = 'video';
    video.srcObject = stream;
    await playCameraVideo();
    if (session !== state.cameraSession) return;
    ui.cameraPlaceholder.classList.add('hidden');
    video.classList.add('is-active');
    ui.cameraRec.classList.remove('hidden');
    setCameraState('CÁMARA ACTIVA', true);
    stage = 'detector';
    await createDetector(session);
  } catch (error) {
    if (session !== state.cameraSession) return;
    console.error('[Body Dodge] Error de cámara:', error);
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
    const missing = error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError';
    const detail = stage === 'detector' ? error.message
      : stage === 'video' && denied
        ? 'La cámara tiene permiso, pero el video no pudo reproducirse. Abrí el enlace directamente en Chrome o Safari.'
        : denied
          ? 'El navegador bloqueó la cámara. Habilitala en los permisos de este sitio y volvé a intentarlo.'
          : missing
            ? 'No encontramos una cámara disponible en este dispositivo.'
            : error?.name === 'NotReadableError'
              ? 'La cámara está ocupada. Cerrá otras apps que la usen y volvé a intentarlo.'
              : error?.message || 'No pudimos iniciar la cámara. Volvé a intentarlo.';
    failCamera(detail);
  }
}

function failCamera(message) {
  stopCountdown();
  stopCamera();
  state.cameraError = message;
  ui.cameraErrorMessage.textContent = message;
  ui.cameraError.classList.remove('hidden');
  ui.cameraError.scrollIntoView({ block: 'nearest' });
  ui.pauseButton.disabled = true;
  ui.gameFrame.classList.remove('is-playing');
  state.phase = 'idle';
  state.mode = null;
  resetStartButtons();
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">♫</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = '¡A PISAR<br /><span>AL RITMO!</span>';
  ui.startOverlay.querySelector('p').textContent = message;
  ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> INTENTAR DE NUEVO <span class="button-arrow">→</span>';
  ui.manualStart.innerHTML = '<span aria-hidden="true">⌨</span> PROBAR SIN CÁMARA';
  ui.cameraStart.style.display = '';
  ui.startOverlay.classList.remove('hidden');
  setCameraState('NO DISPONIBLE');
  setTracking(false);
  setControlStatus('PODÉS JUGAR CON TECLADO O TÁCTIL', 'warning');
  ui.cameraPlaceholder.classList.remove('hidden');
  ui.cameraRec.classList.add('hidden');
  video.classList.remove('is-active');
  poseCtx.clearRect(0, 0, ui.poseCanvas.width, ui.poseCanvas.height);
  setOverlay('startOverlay');
}

function stopCamera() {
  stopReadyAutoStart();
  state.cameraSession += 1;
  setCameraPresentation(false);
  if (state.detector) {
    try { state.detector.close(); } catch (error) { console.warn('[Body Dodge] Error al cerrar detector:', error); }
    state.detector = null;
  }
  state.detectorReady = false;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  video.srcObject = null;
  state.body = null;
  state.baseline = null;
  state.calibrationSamples = [];
  state.calibrationStarted = 0;
  state.lastDetectionAt = 0;
  state.lastBodyAt = 0;
  state.lastVideoTime = -1;
}

function beginGame(mode) {
  stopReadyAutoStart();
  stopCountdown();
  clearCameraError();
  if (mode === 'manual') {
    stopCamera();
    state.mode = 'manual';
    state.baseline = null;
    state.phase = 'ready';
    setCameraState('EN ESPERA');
    setTracking(false);
    ui.cameraPlaceholder.classList.remove('hidden');
    ui.cameraRec.classList.add('hidden');
    video.classList.remove('is-active');
    poseCtx.clearRect(0, 0, ui.poseCanvas.width, ui.poseCanvas.height);
    ui.manualPanel.classList.remove('hidden');
    setControlStatus('SEGUÍ LAS FLECHAS · ← ↑ ↓ →', 'active');
  } else {
    if (!['ready', 'over'].includes(state.phase) || !state.detectorReady || !state.baseline) return;
    state.calibrationHold = false;
    ui.manualPanel.classList.add('hidden');
    setControlStatus('CÁMARA LISTA · BAILÁ AL RITMO', 'active');
  }

  state.gameTime = 0;
  state.lives = 3;
  state.combo = 0;
  state.bestCombo = 0;
  state.hits = 0;
  state.misses = 0;
  state.missStreak = 0;
  state.armStreak = 0;
  state.score = 0;
  state.nextBeatAt = 0;
  state.notes = buildDanceChart();
  state.effects = [];
  state.playerLane = 1;
  state.targetLane = 1;
  state.playerPosition = 0;
  state.isDucking = false;
  state.bodyAction = null;
  state.finishedByTime = false;
  ui.gameHud.classList.remove('hidden');
  ui.pauseButton.disabled = false;
  ui.gameFrame.classList.add('is-playing');
  renderLives();
  updateHUD();
  startCountdown();
}

let readyAutoStartTimer = 0;
let countdownTimer = 0;
function stopReadyAutoStart() {
  if (readyAutoStartTimer) clearTimeout(readyAutoStartTimer);
  readyAutoStartTimer = 0;
}
function stopCountdown() {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = 0;
}

function startCountdown() {
  stopCountdown();
  const words = ['3', '2', '1', '¡YA!'];
  state.phase = 'countdown';
  state.previousFrame = 0;
  ui.countdownNumber.textContent = words[0];
  setOverlay('countdownOverlay');

  const showNext = (index) => {
    if (index >= words.length) {
      state.phase = 'playing';
      state.previousFrame = performance.now();
      setOverlay(null);
      setControlStatus(state.mode === 'camera' ? 'CÁMARA ACTIVA · BAILÁ AL RITMO' : 'EN PARTIDA · PISÁ LAS FLECHAS', 'active');
      return;
    }
    ui.countdownNumber.textContent = words[index];
    countdownTimer = window.setTimeout(() => showNext(index + 1), 650);
  };

  countdownTimer = window.setTimeout(() => showNext(1), 650);
}

function endGame(survived) {
  if (state.phase === 'over') return;
  state.phase = 'over';
  state.finishedByTime = survived;
  state.isDucking = false;
  state.lives = Math.max(0, state.lives);
  ui.pauseButton.disabled = true;
  ui.gameFrame.classList.remove('is-playing');
  ui.finalScore.textContent = padScore(state.score);
  ui.gameOverEyebrow.textContent = survived ? '¡BAILASTE LOS 30 SEGUNDOS!' : 'FIN DE LA PARTIDA';
  ui.gameOverTitle.innerHTML = survived ? '¡QUÉ<br /><span>RITMAZO!</span>' : 'BUEN<br /><span>INTENTO.</span>';
  const accuracy = state.hits + state.misses ? Math.round(state.hits / (state.hits + state.misses) * 100) : 0;
  ui.gameOverText.textContent = `${accuracy}% de precisión · mejor racha ${state.bestCombo}. ¡Otra ronda y rompés la pista!`;
  if (state.mode === 'camera') {
    setControlStatus(survived ? 'COMPLETASTE LOS 30 SEGUNDOS' : 'FIN DE LA PARTIDA', survived ? 'active' : 'warning');
  } else {
    setControlStatus(survived ? 'COMPLETASTE LOS 30 SEGUNDOS' : 'FIN DE LA PARTIDA', survived ? 'active' : 'warning');
  }
  setOverlay('gameOverOverlay');
  if (survived && !state.muted) playChime();
}

function pauseGame(lostTracking = false) {
  if (state.phase !== 'playing' && state.phase !== 'countdown' && !(lostTracking && state.phase === 'paused')) return;
  stopCountdown();
  state.phase = 'paused';
  state.previousFrame = performance.now();
  state.isDucking = false;
  ui.pauseButton.disabled = false;
  if (lostTracking) {
    ui.pauseEyebrow.textContent = 'TE PERDIMOS DE VISTA';
    ui.pauseTitle.innerHTML = '¡VOLVÉ A<br /><span>ENCUADRARTE!</span>';
    ui.pauseHint.textContent = 'Mostrá tus hombros y el torso. Cuando el juego te encuentre, podés seguir.';
    ui.resumeButton.disabled = true;
    ui.resumeButton.style.opacity = '0.45';
    setControlStatus('PAUSA · MOSTRÁ EL CUERPO A LA CÁMARA', 'warning');
  } else {
    ui.pauseEyebrow.textContent = 'TOMATE UN RESPIRO';
    ui.pauseTitle.innerHTML = 'PARTIDA<br /><span>EN PAUSA.</span>';
    ui.pauseHint.textContent = 'Cuando estés listo, volvemos a la pista.';
    ui.resumeButton.disabled = false;
    ui.resumeButton.style.opacity = '';
    setControlStatus('PARTIDA EN PAUSA');
  }
  setOverlay('pauseOverlay');
}

function resumeGame() {
  if (state.phase !== 'paused') return;
  if (state.mode === 'camera' && (!state.detectorReady || !state.body || performance.now() - state.lastBodyAt > 1000)) {
    pauseGame(true);
    return;
  }
  ui.pauseEyebrow.textContent = 'TOMATE UN RESPIRO';
  ui.pauseTitle.innerHTML = 'PARTIDA<br /><span>EN PAUSA.</span>';
  ui.pauseHint.textContent = 'Cuando estés listo, volvemos a la pista.';
  ui.resumeButton.disabled = false;
  ui.resumeButton.style.opacity = '';
  state.targetLane = state.mode === 'camera' ? state.targetLane : state.playerLane;
  startCountdown();
}

function backToHome() {
  resetStartButtons();
  clearCameraError();
  stopCountdown();
  stopCamera();
  state.mode = null;
  state.baseline = null;
  state.phase = 'idle';
  state.gameTime = 0;
  state.lives = 3;
  state.score = 0;
  state.notes = [];
  state.effects = [];
  state.targetLane = 1;
  state.playerLane = 1;
  state.playerPosition = 0;
  state.isDucking = false;
  state.bodyAction = null;
  state.calibrationHold = false;
  ui.pauseButton.disabled = true;
  ui.manualPanel.classList.add('hidden');
  ui.gameFrame.classList.remove('is-playing', 'is-damaged');
  ui.cameraPlaceholder.classList.remove('hidden');
  ui.cameraRec.classList.add('hidden');
  video.classList.remove('is-active');
  ui.gameHud.classList.remove('hidden');
  ui.cameraStart.style.display = '';
  ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> BAILAR CON CÁMARA <span class="button-arrow">→</span>';
  ui.manualStart.innerHTML = '<span aria-hidden="true">⌨</span> PROBAR SIN CÁMARA';
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">♫</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = '¡A PISAR<br /><span>AL RITMO!</span>';
  ui.startOverlay.querySelector('p').textContent = 'Seguí las flechas: movete a los costados, levantá los brazos o agachate justo cuando llegan al piso.';
  renderLives();
  updateHUD();
  setCameraState('EN ESPERA');
  setTracking(false);
  setControlStatus('ELEGÍ UN MODO PARA EMPEZAR');
  setOverlay('startOverlay');
}

function setDucking(pressed) {
  if (pressed) hitDanceAction('down');
  ui.duckControl.classList.toggle('pressed', pressed);
}

function moveLane(direction) {
  hitDanceAction(direction < 0 ? 'left' : 'right');
}

function playChime(impact = false) {
  if (!state.audio || state.muted) return;
  try {
    const oscillator = state.audio.createOscillator();
    const gain = state.audio.createGain();
    oscillator.type = impact ? 'sawtooth' : 'sine';
    oscillator.frequency.setValueAtTime(impact ? 145 : 660, state.audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(impact ? 68 : 900, state.audio.currentTime + 0.12);
    gain.gain.setValueAtTime(impact ? 0.09 : 0.025, state.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, state.audio.currentTime + 0.14);
    oscillator.connect(gain);
    gain.connect(state.audio.destination);
    oscillator.start();
    oscillator.stop(state.audio.currentTime + 0.15);
  } catch {
    // Audio is decorative; gameplay keeps working if the browser blocks playback.
  }
}

function playBeatTick() {
  if (!state.audio || state.muted) return;
  try {
    const oscillator = state.audio.createOscillator();
    const gain = state.audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, state.audio.currentTime);
    gain.gain.setValueAtTime(0.018, state.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, state.audio.currentTime + 0.045);
    oscillator.connect(gain); gain.connect(state.audio.destination);
    oscillator.start(); oscillator.stop(state.audio.currentTime + 0.05);
  } catch { /* The visual rhythm remains available if audio is blocked. */ }
}

function initializeAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!state.audio && AudioContextClass) state.audio = new AudioContextClass();
    const resumed = state.audio?.resume?.();
    resumed?.catch?.(() => {});
  } catch (error) {
    console.warn('[Body Beat] El sonido no está disponible:', error);
    state.audio = null;
  }
}

function triggerStart(mode) {
  if (!state.muted) initializeAudio();
  if (mode === 'manual') {
    ui.startOverlay.classList.remove('hidden');
    beginGame('manual');
  } else {
    startCamera();
  }
}

ui.cameraStart.addEventListener('click', () => triggerStart('camera'));
ui.manualStart.addEventListener('click', () => {
  if (state.mode === 'camera' && state.phase === 'ready') {
    initializeAudio();
    beginGame('manual');
  } else {
    triggerStart('manual');
  }
});
ui.calibrationCancel.addEventListener('click', () => {
  backToHome();
  ui.startOverlay.querySelector('p').textContent = 'Movete para cambiar de carril. Agachate para pasar debajo. ¿Cuánto aguantás?';
  setCameraState('EN ESPERA');
});
ui.resumeButton.addEventListener('click', resumeGame);
ui.pauseButton.addEventListener('click', () => pauseGame(false));
ui.pauseQuit.addEventListener('click', backToHome);
ui.gameOverHome.addEventListener('click', backToHome);
ui.restartButton.addEventListener('click', () => {
  initializeAudio();
  if (state.mode === 'camera' && state.detectorReady) beginGame('camera');
  else beginGame('manual');
});
ui.leftControl.addEventListener('click', () => moveLane(-1));
ui.rightControl.addEventListener('click', () => moveLane(1));
ui.upControl.addEventListener('click', () => hitDanceAction('up'));
ui.duckControl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  ui.duckControl.setPointerCapture(event.pointerId);
  setDucking(true);
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  ui.duckControl.addEventListener(eventName, () => setDucking(false));
}
ui.fullscreenBtn.addEventListener('click', async () => {
  initializeAudio();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await ui.gameFrame.requestFullscreen();
  } catch (error) {
    console.info('[Body Dodge] Pantalla completa no disponible:', error?.message);
  }
});
ui.muteBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  ui.muteBtn.classList.toggle('is-muted', state.muted);
  ui.muteBtn.setAttribute('aria-label', state.muted ? 'Activar sonido' : 'Silenciar sonido');
  if (!state.muted) {
    initializeAudio();
    playChime();
  }
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' '].includes(key)) event.preventDefault();
  if (event.repeat) return;

  if (key === 'escape' && state.phase === 'playing') {
    pauseGame(false);
    return;
  }
  if ((key === 'p' || key === 'escape') && state.phase === 'paused') {
    resumeGame();
    return;
  }
  if (['arrowleft', 'a'].includes(key)) moveLane(-1);
  if (['arrowright', 'd'].includes(key)) moveLane(1);
  if (['arrowup', 'w'].includes(key) && state.phase === 'playing') hitDanceAction('up');
  if (['arrowdown', 's', ' '].includes(key) && state.phase === 'playing') setDucking(true);
  if (key === 'p' && state.phase === 'playing') pauseGame(false);
  if (['enter', ' '].includes(key) && state.phase === 'idle') triggerStart('manual');
  if (key === ' ' && state.phase === 'ready' && state.mode === 'camera') startCamera();
});
document.addEventListener('keyup', (event) => {
  if (['arrowdown', 's', ' '].includes(event.key.toLowerCase())) setDucking(false);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame(false);
});
window.addEventListener('blur', () => {
  setDucking(false);
  if (state.phase === 'playing') pauseGame(false);
});

if (!('OffscreenCanvas' in window)) {
  // MediaPipe uses its own canvas plumbing, but newer browser tracking may need OffscreenCanvas.
  console.info('[Body Dodge] El dispositivo usa un navegador compatible con procesamiento de video local.');
}

createStars();
renderLives();
updateHUD();
requestAnimationFrame(updateFrame);

