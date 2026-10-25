/**
 * HandFlow — In-Page Extension Camera Frame (camera_frame.js)
 * Runs MediaPipe HandLandmarker locally inside chrome-extension:// origin.
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
let stream = null;
let animFrameId = null;
let isRunning = false;
let isPausedByParent = false;
let lastVideoTime = -1;
let settings = { ...DEFAULT_SETTINGS };
const engine = new GestureEngine(settings);

grantBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
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
    } else if (!isPausedByParent && !isRunning) {
      startCamera();
    }
  }
});

// Listen for pause/resume signals from parent content.js (e.g. when tab is hidden or Side Panel is active)
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.target !== 'HANDFLOW_CAMERA_FRAME') return;

  if (msg.command === 'PAUSE_CAMERA') {
    isPausedByParent = true;
    stopCamera();
  } else if (msg.command === 'RESUME_CAMERA') {
    isPausedByParent = false;
    if (settings.enabled && !isRunning) {
      startCamera();
    }
  }
});

async function initMediaPipe() {
  if (handLandmarker) return handLandmarker;
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
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    });
  } catch (gpuErr) {
    // Fallback to CPU if GPU WebGL context fails
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    });
  }
  return handLandmarker;
}

async function startCamera() {
  if (isRunning || isPausedByParent || !settings.enabled) return;
  isRunning = true;

  try {
    await initMediaPipe();
    statusText.textContent = 'Opening Cam...';

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    permissionOverlay.classList.remove('visible');
    video.srcObject = stream;
    await video.play();

    statusDot.className = 'dot active';
    statusText.textContent = 'Tracking';
    lastVideoTime = -1;
    renderLoop();
  } catch (err) {
    isRunning = false;
    statusDot.className = 'dot error';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusText.textContent = 'Need Access';
      permissionOverlay.classList.add('visible');
      window.parent.postMessage(
        {
          source: 'HANDFLOW_CAMERA_FRAME',
          type: 'PERMISSION_REQUIRED'
        },
        '*'
      );
    } else {
      statusText.textContent = 'Cam Busy/Err';
    }
  }
}

function stopCamera() {
  isRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  statusDot.className = 'dot';
  statusText.textContent = 'Paused';
  posturePill.textContent = 'PAUSED';
}

function drawScene(landmarks, result) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Draw mirrored webcam feed
  ctx.save();
  if (settings.mirrorCamera) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, w, h);
  }
  ctx.restore();

  // Darken slightly for high-contrast skeleton visibility
  ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
  ctx.fillRect(0, 0, w, h);

  // Draw active sensitivity bounding box
  const sens = Math.max(0.6, Math.min(2.5, settings.sensitivity || 1.35));
  const span = Math.min(0.92, Math.max(0.32, 0.85 / sens));
  const bx = ((1.0 - span) / 2) * w;
  const by = ((1.0 - span) / 2) * h;
  const bw = span * w;
  const bh = span * h;

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  if (!landmarks || !settings.showSkeleton) return;

  const mapX = (x) => (settings.mirrorCamera ? (1.0 - x) * w : x * w);
  const mapY = (y) => y * h;

  // Draw skeleton connections
  ctx.strokeStyle = result.isPinching ? '#f43f5e' : result.isScrolling ? '#06b6d4' : '#6366f1';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (const [i, j] of HAND_CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    ctx.moveTo(mapX(a.x), mapY(a.y));
    ctx.lineTo(mapX(b.x), mapY(b.y));
  }
  ctx.stroke();

  // Draw joints
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    const px = mapX(pt.x);
    const py = mapY(pt.y);
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;

    ctx.beginPath();
    ctx.arc(px, py, isTip ? 4.2 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle =
      i === 8
        ? '#22d3ee'
        : i === 4
        ? '#f43f5e'
        : isTip
        ? '#a855f7'
        : '#f8fafc';
    ctx.fill();
  }

  // Draw pinch line between thumb tip [4] and index tip [8]
  if (result.pinchRatio < 1.35) {
    ctx.beginPath();
    ctx.moveTo(mapX(landmarks[4].x), mapY(landmarks[4].y));
    ctx.lineTo(mapX(landmarks[8].x), mapY(landmarks[8].y));
    ctx.strokeStyle = result.isPinching ? '#10b981' : '#f59e0b';
    ctx.lineWidth = result.isPinching ? 3.5 : 1.8;
    ctx.stroke();
  }
}

function renderLoop() {
  if (!isRunning) return;

  const now = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const detections = handLandmarker.detectForVideo(video, now);
      const hand = detections.landmarks?.[0] || null;

      if (hand) {
        const result = engine.processLandmarks(hand, now);
        posturePill.textContent = result.posture;
        drawScene(hand, result);

        // Send frame to parent content script
        window.parent.postMessage(
          {
            source: 'HANDFLOW_CAMERA_FRAME',
            type: 'HAND_FRAME',
            payload: result
          },
          '*'
        );
      } else {
        posturePill.textContent = 'NO HAND';
        drawScene(null, { isPinching: false, isScrolling: false });
        window.parent.postMessage(
          {
            source: 'HANDFLOW_CAMERA_FRAME',
            type: 'HAND_LOST'
          },
          '*'
        );
      }
    } catch (_) {}
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

// Initialize
loadSettings().then(() => {
  if (settings.enabled && !isPausedByParent) {
    startCamera();
  }
});
