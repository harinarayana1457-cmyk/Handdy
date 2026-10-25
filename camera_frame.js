/**
 * Handdy — In-Page Hand Tracer Frame (camera_frame.js)
 * Processes webcam frames locally in the background and renders ONLY the traced
 * 21-point 3D hand skeleton on a dark cyber grid (never shows webcam video of face/room).
 */

import { FilesetResolver, HandLandmarker } from './lib/mediapipe/vision_bundle.mjs';
import { GestureEngine, DEFAULT_SETTINGS } from './gesture_engine.js';

const video = document.getElementById('webcam');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const posturePill = document.getElementById('posturePill');
const permissionOverlay = document.getElementById('permissionOverlay');
const grantBtn = document.getElementById('grantBtn');

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // Index
  [5, 9], [9, 10], [10, 11], [11, 12],  // Middle
  [9, 13], [13, 14], [14, 15], [15, 16],// Ring
  [13, 17], [17, 18], [18, 19], [19, 20], // Pinky
  [0, 17]                                // Palm base
];

let handLandmarker = null;
let initPromise = null;
let stream = null;
let animFrameId = null;
let retryTimer = null;
let isRunning = false;
let isStarting = false;
let isPausedByParent = document.hidden;
let lastVideoTime = -1;
let settings = { ...DEFAULT_SETTINGS };
const engine = new GestureEngine(settings);

grantBtn.addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' }).catch(() => {});
  } catch (_) {}
});

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get('settings');
    if (data.settings) {
      settings = { ...DEFAULT_SETTINGS, ...data.settings };
      engine.updateSettings(settings);
    }
  } catch (_) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    engine.updateSettings(settings);
    if (!settings.enabled) {
      stopCamera();
    } else if (!isPausedByParent && !document.hidden && !isRunning) {
      startCamera(0);
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
  } else if (!isPausedByParent && settings.enabled) {
    startCamera(0);
  }
});

window.addEventListener('pagehide', stopCamera);
window.addEventListener('beforeunload', stopCamera);

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.target !== 'HANDDY_CAMERA_FRAME') return;

  if (msg.command === 'PAUSE_CAMERA') {
    isPausedByParent = true;
    stopCamera();
  } else if (msg.command === 'RESUME_CAMERA') {
    isPausedByParent = false;
    if (msg.lastCursor && typeof msg.lastCursor.x === 'number') {
      engine.cursorX = msg.lastCursor.x;
      engine.cursorY = msg.lastCursor.y;
    }
    if (settings.enabled && !isRunning) {
      startCamera(0);
    }
  } else if (msg.command === 'SYNC_CURSOR' && msg.lastCursor) {
    engine.cursorX = msg.lastCursor.x;
    engine.cursorY = msg.lastCursor.y;
  }
});

async function initMediaPipe() {
  if (handLandmarker) return handLandmarker;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    statusText.textContent = 'Loading AI...';
    const wasmPath = chrome.runtime.getURL('lib/mediapipe/wasm');
    const modelPath = chrome.runtime.getURL('models/hand_landmarker.task');

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      });
    } catch (_) {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      });
    }
    return handLandmarker;
  })();

  return initPromise;
}

async function startCamera(retryCount = 0) {
  if (isRunning || isStarting || isPausedByParent || document.hidden || !settings.enabled) {
    return;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  isStarting = true;

  try {
    await initMediaPipe();

    if (isPausedByParent || document.hidden || !settings.enabled) {
      isStarting = false;
      return;
    }

    statusText.textContent = retryCount > 0 ? `Connecting (${retryCount})...` : 'Starting...';

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    if (isPausedByParent || document.hidden || !settings.enabled) {
      newStream.getTracks().forEach((t) => t.stop());
      isStarting = false;
      return;
    }

    stream = newStream;
    permissionOverlay.classList.remove('visible');
    video.srcObject = stream;
    await video.play();

    isStarting = false;
    isRunning = true;
    statusDot.className = 'dot active';
    statusText.textContent = 'Hand Tracer';
    lastVideoTime = -1;
    drawHandTraceOnly(null, {});
    renderLoop();
  } catch (err) {
    isStarting = false;
    isRunning = false;

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusDot.className = 'dot error';
      statusText.textContent = 'Need Access';
      permissionOverlay.classList.add('visible');
      window.parent.postMessage(
        {
          source: 'HANDDY_CAMERA_FRAME',
          type: 'PERMISSION_REQUIRED'
        },
        '*'
      );
    } else if (retryCount < 25 && !isPausedByParent && !document.hidden && settings.enabled) {
      statusDot.className = 'dot';
      statusText.textContent = 'Switching Tab...';
      retryTimer = setTimeout(() => startCamera(retryCount + 1), 180);
    } else {
      statusDot.className = 'dot error';
      statusText.textContent = 'Cam Busy';
    }
  }
}

function stopCamera() {
  isRunning = false;
  isStarting = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (stream) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    stream = null;
  }
  if (video.srcObject) {
    video.srcObject = null;
  }
  statusDot.className = 'dot';
  statusText.textContent = 'Standby';
  posturePill.textContent = 'STANDBY';
}

/**
 * Draws ONLY the traced 21-point hand skeleton on a dark cyber grid (no webcam video).
 */
function drawHandTraceOnly(landmarks, result) {
  const w = canvas.width;
  const h = canvas.height;

  // 1. Clean Dark Cyber Background (never draws video feed!)
  if (video.readyState >= 2) { ctx.drawImage(video, 0, 0, 1, 1); }
  ctx.fillStyle = "#090d16";
  ctx.fillRect(0, 0, w, h);

  // Subtle coordinate grid lines
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.07)';
  ctx.lineWidth = 1;
  const step = 32;
  ctx.beginPath();
  for (let x = step; x < w; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // Active tracking zone boundary
  const sens = Math.max(0.6, Math.min(2.5, settings.sensitivity || 1.35));
  const span = Math.min(0.92, Math.max(0.32, 0.85 / sens));
  const bx = ((1.0 - span) / 2) * w;
  const by = ((1.0 - span) / 2) * h;
  const bw = span * w;
  const bh = span * h;

  ctx.strokeStyle = 'rgba(99, 102, 241, 0.28)';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  if (!landmarks) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🖐️ Raise hand to trace', w / 2, h / 2 + 8);
    return;
  }

  const mapX = (x) => (settings.mirrorCamera ? (1.0 - x) * w : x * w);
  const mapY = (y) => y * h;

  // 2. Translucent Cyber Palm Fill ([0] -> [1] -> [5] -> [9] -> [13] -> [17])
  const palmIndices = [0, 1, 5, 9, 13, 17];
  ctx.beginPath();
  ctx.moveTo(mapX(landmarks[0].x), mapY(landmarks[0].y));
  for (let i = 1; i < palmIndices.length; i++) {
    const pt = landmarks[palmIndices[i]];
    ctx.lineTo(mapX(pt.x), mapY(pt.y));
  }
  ctx.closePath();
  ctx.fillStyle = result.isPinching
    ? 'rgba(16, 185, 129, 0.18)'
    : result.isScrolling
    ? 'rgba(168, 85, 247, 0.18)'
    : 'rgba(34, 211, 238, 0.14)';
  ctx.fill();

  // 3. Glowing Hand Skeleton Bones
  const boneColor = result.isPinching
    ? '#10b981'
    : result.isScrolling
    ? '#a855f7'
    : '#22d3ee';

  ctx.save();
  ctx.strokeStyle = boneColor;
  ctx.shadowColor = boneColor;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (const [i, j] of HAND_CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    ctx.moveTo(mapX(a.x), mapY(a.y));
    ctx.lineTo(mapX(b.x), mapY(b.y));
  }
  ctx.stroke();
  ctx.restore();

  // 4. Pinch Laser Line between Thumb Tip [4] and Index Tip [8]
  if (result.pinchRatio < 1.35) {
    ctx.beginPath();
    ctx.moveTo(mapX(landmarks[4].x), mapY(landmarks[4].y));
    ctx.lineTo(mapX(landmarks[8].x), mapY(landmarks[8].y));
    ctx.strokeStyle = result.isPinching ? '#10b981' : '#f59e0b';
    ctx.lineWidth = result.isPinching ? 3.5 : 1.8;
    ctx.stroke();
  }

  // 5. 21 Hand Joints & Glowing Fingertips
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    const px = mapX(pt.x);
    const py = mapY(pt.y);
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;

    ctx.beginPath();
    ctx.arc(px, py, isTip ? 5 : 2.8, 0, Math.PI * 2);
    ctx.fillStyle =
      i === 8
        ? '#22d3ee'
        : i === 4
        ? '#f43f5e'
        : isTip
        ? '#a855f7'
        : '#f8fafc';
    ctx.fill();

    // Extra target ring around Index Pointer Tip [8]
    if (i === 8) {
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.strokeStyle = result.isPinching ? '#10b981' : '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function renderLoop() {
  if (!isRunning) return;

  if (document.hidden || isPausedByParent) {
    stopCamera();
    return;
  }

  const now = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const detections = handLandmarker.detectForVideo(video, now);
      const hand = detections.landmarks?.[0] || null;

      if (hand) {
        const result = engine.processLandmarks(hand, now);
        posturePill.textContent = result.posture;
        drawHandTraceOnly(hand, result);

        const hasTabSwitch = (result.events || []).some(
          (e) => e.type === 'TAB_NEXT' || e.type === 'TAB_PREV'
        );

        window.parent.postMessage(
          {
            source: 'HANDDY_CAMERA_FRAME',
            type: 'HAND_FRAME',
            payload: result
          },
          '*'
        );

        if (hasTabSwitch) {
          stopCamera();
          return;
        }
      } else {
        posturePill.textContent = 'NO HAND';
        drawHandTraceOnly(null, {});
        window.parent.postMessage(
          {
            source: 'HANDDY_CAMERA_FRAME',
            type: 'HAND_LOST'
          },
          '*'
        );
      }
    } catch (_) {}
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

drawHandTraceOnly(null, {});
initMediaPipe();
loadSettings().then(() => {
  if (settings.enabled && !isPausedByParent && !document.hidden) {
    startCamera(0);
  }
});
