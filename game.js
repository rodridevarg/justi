import { loadPoseDetector } from './pose-detector.mjs?v=0.1.1';

const WORLD = { width: 960, height: 600, horizon: 155, finishLine: 0.96 };
const LANE_OFFSET = [-1, 0, 1];
const ELEMENTS = [
  'gameCanvas', 'gameFrame', 'gameWave', 'scoreValue', 'timerValue', 'timerFill', 'hearts',
  'startOverlay', 'calibrationOverlay', 'pauseOverlay', 'gameOverOverlay', 'countdownOverlay',
  'calibrationIcon', 'calibrationLabel', 'calibrationTitle', 'calibrationHint', 'calibrationProgress', 'calibrationFootnote',
  'calibrationCancel', 'pauseEyebrow', 'pauseTitle', 'pauseHint', 'resumeButton', 'pauseQuit',
  'gameOverEyebrow', 'gameOverTitle', 'gameOverText', 'finalScore', 'restartButton', 'gameOverHome',
  'countdownNumber', 'cameraStart', 'manualStart', 'cameraVideo', 'poseCanvas', 'cameraPlaceholder',
  'cameraRec', 'trackingIndicator', 'trackingLabel', 'cameraCard', 'cameraState', 'controlStatus',
  'lanePip', 'pauseButton', 'manualPanel', 'leftControl', 'rightControl', 'duckControl',
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
  lives: 3, score: 0, combo: 0, dodges: 0, obstacles: [], nextObstacleAt: 0,
  effects: [], stars: [], shake: 0, muted: true, audio: null,
  calibrationSamples: [], calibrationStarted: 0, calibrationWaitStarted: 0, baseline: null, calibrationHold: false,
  body: null, highStreak: 0, lowStreak: 0, lastLaneSignal: 0,
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

  if (state.targetLane !== state.playerLane && state.lastLaneSignal !== state.targetLane) {
    state.lastLaneSignal = state.targetLane;
    if (state.phase === 'playing') addPop(`CARRIL ${['IZQ', 'CENTRO', 'DER'][state.targetLane]}`, state.targetLane, '#c5f66a');
  }
  if (state.targetLane === state.playerLane) state.lastLaneSignal = state.playerLane;
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
    const y = horizon + ((star.y + time * star.speed) % 275);
    const fade = Math.sin((y - horizon) / 275 * Math.PI) * star.alpha;
    ctx.fillStyle = `rgba(220, 204, 255, ${Math.max(0, fade)})`;
    ctx.beginPath();
    ctx.arc(star.x, y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(239, 108, 167, .08)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 9; index += 1) {
    const x = index * 120 - 60;
    ctx.beginPath();
    ctx.moveTo(width / 2, horizon + 49);
    ctx.lineTo(x, height + 2);
    ctx.stroke();
  }
  for (let index = 1; index <= 11; index += 1) {
    const phase = ((index * 0.115 + time * 0.24) % 1);
    const progress = phase * phase;
    const y = horizon + progress * 400;
    const half = 72 + progress * 440;
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
  for (const obstacle of [...state.obstacles].sort((a, b) => a.depth - b.depth)) drawBlock(obstacle);
  drawRunner(time);
  drawEffects(dt);
}

function createStars() {
  state.stars = Array.from({ length: 60 }, () => ({
    x: rand(70, 890), y: rand(0, 275), speed: rand(8, 38), radius: rand(0.5, 1.35), alpha: rand(0.18, 0.62),
  }));
}

function addPop(text, lane, color) {
  const projection = getProjection(LANE_OFFSET[lane], 0.93);
  state.effects.push({ text, x: projection.x, y: projection.y - 78, color, life: 0.7, duration: 0.7 });
}

function addObstacle() {
  if (state.obstacles.length > 3) return;
  const level = Math.floor(state.gameTime / 12);
  const difficulty = Math.min(0.45, level * 0.13);
  const random = Math.random();
  let kind = random < 0.32 + difficulty * 0.3 ? 'beam' : 'crate';
  if (state.gameTime < 5) kind = 'crate';
  state.obstacles.push({ kind, lane: Math.floor(Math.random() * 3), depth: 0, resolved: false, seed: Math.random() });
  state.nextObstacleAt = state.clock + Math.max(1.25, 1.76 - level * 0.08 + rand(-0.16, 0.16));
}

function updateHUD() {
  const remaining = Math.max(0, 30 - state.gameTime);
  const totalSeconds = Math.ceil(remaining);
  ui.scoreValue.textContent = padScore(state.score);
  ui.timerValue.textContent = `00:${String(totalSeconds).padStart(2, '0')}`;
  ui.timerFill.style.width = `${(remaining / 30) * 100}%`;
  ui.timerFill.classList.toggle('is-low', remaining <= 8);
  ui.gameWave.innerHTML = `RONDA <b>${String(Math.floor(state.gameTime / 10) + 1).padStart(2, '0')}</b>`;
}

function handleCollision(obstacle) {
  if (obstacle.resolved) return;
  obstacle.resolved = true;
  const currentlyInLane = Math.abs(state.playerPosition - LANE_OFFSET[obstacle.lane]) < 0.44;
  const duckedInTime = obstacle.kind === 'beam' && state.isDucking;
  if (!currentlyInLane || duckedInTime) {
    state.dodges += 1;
    state.combo += 1;
    state.score += 100 + Math.min(200, Math.max(0, state.combo - 1) * 20);
    addPop(state.combo > 1 ? `+100 · ${state.combo}×` : '+100 · DODGE', obstacle.lane, '#c3f66b');
    if (!state.muted && state.combo % 4 === 0) playChime();
  } else {
    state.lives -= 1;
    state.combo = 0;
    state.shake = 0.35;
    ui.gameFrame.classList.remove('is-damaged');
    void ui.gameFrame.offsetWidth;
    ui.gameFrame.classList.add('is-damaged');
    addPop('¡AUCH!', obstacle.lane, '#ff607f');
    renderLives();
    if (!state.muted) playChime(true);
    if (state.lives <= 0) endGame(false);
  }
}

function updateGame(dt) {
  if (state.phase !== 'playing') return;
  state.gameTime = Math.min(30, state.gameTime + dt);
  state.score += dt * 8;
  const speed = 0.37 + Math.floor(state.gameTime / 10) * 0.025;
  state.playerPosition = mix(state.playerPosition, LANE_OFFSET[state.targetLane], Math.min(1, dt * 8));
  state.shake = Math.max(0, state.shake - dt);

  if (state.clock >= state.nextObstacleAt) addObstacle();
  for (const obstacle of state.obstacles) {
    obstacle.depth += speed * dt * (1 + obstacle.seed * 0.07);
    if (!obstacle.resolved && obstacle.depth >= WORLD.finishLine) handleCollision(obstacle);
  }
  state.obstacles = state.obstacles.filter((obstacle) => obstacle.depth < 1.09);
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

  if (state.mode === 'camera' && state.phase === 'playing' && state.lastBodyAt > 0 && now - state.lastBodyAt > 1300) {
    pauseGame(true);
  }

  if (state.shake > 0 && !MOTION_REDUCED.matches) ctx.setTransform(1, 0, 0, 1, rand(-4, 4) * state.shake / 0.35, rand(-4, 4) * state.shake / 0.35);
  else ctx.setTransform(1, 0, 0, 1, 0, 0);

  drawScene(state.clock, elapsed);
  requestAnimationFrame(updateFrame);
}

function startCalibration() {
  state.phase = 'calibrating';
  state.calibrationSamples = [];
  state.calibrationStarted = 0;
  state.calibrationWaitStarted = performance.now();
  state.calibrationHold = true;
  state.body = null;
  ui.calibrationIcon.textContent = '◉';
  ui.calibrationLabel.textContent = 'CÁMARA CONECTADA';
  ui.calibrationTitle.innerHTML = 'BUSCANDO<br /><span>TU POSE.</span>';
  ui.calibrationHint.textContent = 'Parate frente a la cámara, con los hombros y las caderas a la vista.';
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
    ? Math.min(1, state.calibrationSamples.length / 14, (now - state.calibrationStarted) / 1350)
    : 0;
  ui.calibrationProgress.style.width = `${Math.min(96, fraction * 100)}%`;
  const enoughSamples = state.calibrationSamples.length >= 14;

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
    setControlStatus('CÁMARA LISTA · MOVETE PARA ESQUIVAR', 'active');
    setOverlay('startOverlay');
    ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">✳</span> YA ESTÁS EN LA PISTA';
    ui.startOverlay.querySelector('h2').innerHTML = 'TU CUERPO.<br /><span>TU JUEGO.</span>';
    ui.startOverlay.querySelector('p').textContent = 'La cámara te sigue. Arrancá cuando estés listo.';
    ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> EMPEZAR PARTIDA <span class="button-arrow">→</span>';
    ui.manualStart.textContent = 'CAMBIAR A CONTROLES MANUALES';
  } else if (now - state.calibrationWaitStarted > 10000 && !enoughSamples) {
    ui.calibrationIcon.textContent = '↗';
    ui.calibrationLabel.textContent = 'NO ENCONTRAMOS TU POSE';
    ui.calibrationTitle.innerHTML = 'DALE, UN<br /><span>ÚLTIMO INTENTO.</span>';
    ui.calibrationHint.textContent = 'Alejá un poco la cámara, mejorá la luz y asegurate de que tus hombros y caderas aparezcan en pantalla.';
    ui.calibrationFootnote.textContent = 'CANCELÁ PARA CAMBIAR A LOS CONTROLES MANUALES';
    ui.calibrationProgress.style.width = '0%';
  } else if (enoughSamples && fraction < 1) {
    ui.calibrationHint.textContent = `Perfecto. Quedate quieto un momento… ${Math.ceil((1 - fraction) * 1.35)} s`;
  }
}

function handlePose(body) {
  if (body) {
    state.body = body;
    state.lastBodyAt = performance.now();
    if (state.phase === 'calibrating') {
      if (!state.calibrationSamples.length) state.calibrationStarted = performance.now();
      state.calibrationSamples.push(body);
      if (state.calibrationSamples.length > 45) state.calibrationSamples.shift();
    }
    setTracking(true);
    paintPosePreview(body);
    updatePlayerFromPose(body);
    if (state.phase === 'paused' && ui.pauseEyebrow.textContent === 'TE PERDIMOS DE VISTA') {
      ui.pauseEyebrow.textContent = 'CÁMARA ACTIVA';
      ui.pauseTitle.innerHTML = 'YA VOLVISTE.<br /><span>¡SEGUÍ!</span>';
      ui.pauseHint.textContent = 'Te encontramos de nuevo. Tocá el botón y esquivá el próximo obstáculo.';
      ui.resumeButton.disabled = false;
      ui.resumeButton.style.opacity = '';
      setControlStatus('CÁMARA ACTIVA · PODÉS SEGUIR', 'active');
    }
  } else {
    state.body = null;
    state.calibrationSamples = [];
    state.calibrationStarted = 0;
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
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">↔</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = 'UN PASO.<br /><span>UN DODGE.</span>';
  ui.startOverlay.querySelector('p').textContent = 'Movete para cambiar de carril. Agachate para pasar debajo. ¿Cuánto aguantás?';
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
      video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
    });
    if (session !== state.cameraSession) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    state.stream = stream;
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
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">↔</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = 'UN PASO.<br /><span>UN DODGE.</span>';
  ui.startOverlay.querySelector('p').textContent = message;
  ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> INTENTAR DE NUEVO <span class="button-arrow">→</span>';
  ui.manualStart.innerHTML = '<span aria-hidden="true">⌨</span> PROBAR CON TECLADO';
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
  state.cameraSession += 1;
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
    setControlStatus('FLECHAS O A · D · ESPACIO', 'active');
  } else {
    if (!['ready', 'over'].includes(state.phase) || !state.detectorReady || !state.baseline) return;
    if (!state.body || performance.now() - state.lastBodyAt > 1000) {
      startCalibration();
      return;
    }
    state.calibrationHold = false;
    ui.manualPanel.classList.add('hidden');
    setControlStatus('CÁMARA LISTA · MOVETE PARA ESQUIVAR', 'active');
  }

  state.gameTime = 0;
  state.lives = 3;
  state.combo = 0;
  state.dodges = 0;
  state.score = 0;
  state.nextObstacleAt = state.clock + 1.2;
  state.obstacles = [];
  state.effects = [];
  state.playerLane = 1;
  state.targetLane = 1;
  state.playerPosition = 0;
  state.isDucking = false;
  state.finishedByTime = false;
  ui.gameHud.classList.remove('hidden');
  ui.pauseButton.disabled = false;
  ui.gameFrame.classList.add('is-playing');
  renderLives();
  updateHUD();
  startCountdown();
}

let countdownTimer = 0;
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
      setControlStatus(state.mode === 'camera' ? 'CÁMARA ACTIVA · MOVETE PARA ESQUIVAR' : 'EN PARTIDA · ESQUIVÁ LOS OBSTÁCULOS', 'active');
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
  ui.gameOverEyebrow.textContent = survived ? '¡LO LOGRASTE!' : 'FIN DE LA PARTIDA';
  ui.gameOverTitle.innerHTML = survived ? '¡30 SEGUNDOS!<br /><span>LO ESQUIVASTE.</span>' : 'BUEN<br /><span>INTENTO.</span>';
  ui.gameOverText.textContent = survived
    ? `Esquivaste ${state.dodges} obstáculo${state.dodges === 1 ? '' : 's'}. ¡Tu cuerpo ya es todo un joystick!`
    : state.dodges >= 4 ? `Esquivaste ${state.dodges} obstáculos. Cada partida te hace más rápido.` : 'Los reflejos se entrenan. ¡Dale otra oportunidad!';
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
  state.obstacles = [];
  state.effects = [];
  state.targetLane = 1;
  state.playerLane = 1;
  state.playerPosition = 0;
  state.isDucking = false;
  state.calibrationHold = false;
  ui.pauseButton.disabled = true;
  ui.manualPanel.classList.add('hidden');
  ui.gameFrame.classList.remove('is-playing', 'is-damaged');
  ui.cameraPlaceholder.classList.remove('hidden');
  ui.cameraRec.classList.add('hidden');
  video.classList.remove('is-active');
  ui.gameHud.classList.remove('hidden');
  ui.cameraStart.style.display = '';
  ui.cameraStart.innerHTML = '<span class="camera-icon" aria-hidden="true">◎</span> JUGAR CON CÁMARA <span class="button-arrow">→</span>';
  ui.manualStart.innerHTML = '<span aria-hidden="true">⌨</span> PROBAR CON TECLADO';
  ui.startOverlay.querySelector('.pretitle').innerHTML = '<span class="pill-icon">↔</span> TU CUERPO ES EL JOYSTICK';
  ui.startOverlay.querySelector('h2').innerHTML = 'UN PASO.<br /><span>UN DODGE.</span>';
  ui.startOverlay.querySelector('p').textContent = 'Movete para cambiar de carril. Agachate para pasar debajo. ¿Cuánto aguantás?';
  renderLives();
  updateHUD();
  setCameraState('EN ESPERA');
  setTracking(false);
  setControlStatus('ELEGÍ UN MODO PARA EMPEZAR');
  setOverlay('startOverlay');
}

function setDucking(pressed) {
  state.isDucking = pressed;
  ui.duckControl.classList.toggle('pressed', pressed);
}

function moveLane(direction) {
  if (state.phase !== 'playing') return;
  state.targetLane = clamp(state.targetLane + direction, 0, 2);
  state.playerLane = state.targetLane;
  addPop(`CARRIL ${['IZQ', 'CENTRO', 'DER'][state.targetLane]}`, state.targetLane, '#c5f66a');
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

function initializeAudio() {
  if (state.audio) {
    state.audio.resume?.().catch(() => {});
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    state.audio = new AudioContextClass();
    state.audio.resume?.().catch(() => {});
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


