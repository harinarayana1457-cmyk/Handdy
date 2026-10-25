/**
 * Handdy — Onboarding, Camera Permission & Interactive Sandbox (permission.js)
 * Renders ONLY the traced 21-point hand skeleton on a dark cyber grid (never shows webcam video).
 */

import { FilesetResolver, HandLandmarker } from './lib/mediapipe/vision_bundle.mjs';
import { GestureEngine, DEFAULT_SETTINGS } from './gesture_engine.js';

const grantAccessBtn = document.getElementById('grantAccessBtn');
const openSidePanelBtn = document.getElementById('openSidePanelBtn');
const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const postureBadge = document.getElementById('postureBadge');
const statusMsg = document.getElementById('statusMsg');
const lastActionPill = document.getElementById('lastActionPill');
const sandboxCursor = document.getElementById('sandboxCursor');

const clickCounterBtn = document.getElementById('clickCounterBtn');
const dblClickBtn = document.getElementById('dblClickBtn');
const dragSlider = document.getElementById('dragSlider');
const sliderValueText = document.getElementById('sliderValueText');
const scrollBox = document.getElementById('scrollBox');

let clickCount = 0;
let dblClickCount = 0;

clickCounterBtn.addEventListener('click', () => {
  clickCount++;
  clickCounterBtn.textContent = `Pinch Click Me! (Count: ${clickCount})`;
  clickCounterBtn.style.background = '#059669';
  setTimeout(() => {
    clickCounterBtn.style.background = '';
  }, 220);
});

dblClickBtn.addEventListener('dblclick', () => {
  dblClickCount++;
  dblClickBtn.textContent = `Double-Pinch Target (${dblClickCount})`;
  dblClickBtn.style.background = '#7c3aed';
  setTimeout(() => {
    dblClickBtn.style.background = '';
  }, 250);
});

dragSlider.addEventListener('input', () => {
  sliderValueText.textContent = `Value: ${dragSlider.value}%`;
});

openSidePanelBtn.addEventListener('click', async () => {
  stopSandboxCamera();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (chrome.sidePanel && chrome.sidePanel.open && tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } else {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
  }
});

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

let settings = { ...DEFAULT_SETTINGS };
const engine = new GestureEngine(settings);
let handLandmarker = null;
let stream = null;
let animFrameId = null;
let retryTimer = null;
let lastVideoTime = -1;
let isRunning = false;
let permissionGranted = false;

chrome.storage.local.get('settings').then((data) => {
  if (data.settings) {
    settings = { ...DEFAULT_SETTINGS, ...data.settings };
    engine.updateSettings(settings);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    engine.updateSettings(settings);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSandboxCamera();
  } else if (permissionGranted && settings.enabled) {
    startSandboxCamera(0);
  }
});

window.addEventListener('pagehide', stopSandboxCamera);
window.addEventListener('beforeunload', stopSandboxCamera);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RELEASE_CAMERA_NOW') {
    stopSandboxCamera();
  }
});

async function initMediaPipe() {
  if (handLandmarker) return handLandmarker;
  const wasmPath = chrome.runtime.getURL('lib/mediapipe/wasm');
  const modelPath = chrome.runtime.getURL('models/hand_landmarker.task');
  const vision = await FilesetResolver.forVisionTasks(wasmPath);

  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4
    });
  } catch (_) {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4
    });
  }
  return handLandmarker;
}

async function startSandboxCamera(retryCount = 0) {
  if (isRunning || document.hidden) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  try {
    statusMsg.textContent = 'Starting hand tracer...';
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false
    });

    if (document.hidden) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }

    stream = newStream;
    permissionGranted = true;
    try {
      chrome.runtime.sendMessage({ type: 'CAMERA_PERMISSION_GRANTED' }).catch(() => {});
    } catch (_) {}

    grantAccessBtn.textContent = '✅ Hand Tracer Active — Works Across All Tabs!';
    grantAccessBtn.classList.add('granted');
    statusMsg.textContent =
      'Camera permission granted! Only your 3D hand skeleton is traced (video feed is never shown).';
    statusMsg.style.color = '#10b981';

    video.srcObject = stream;
    await video.play();
    await initMediaPipe();

    isRunning = true;
    lastVideoTime = -1;
    drawHandTraceOnly(null, {});
    renderLoop();
  } catch (err) {
    isRunning = false;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusMsg.textContent =
        'Click "Grant Camera Access & Start" and click Allow in Chrome\'s top-left camera prompt.';
      statusMsg.style.color = '#f43f5e';
    } else if (retryCount < 15 && !document.hidden) {
      retryTimer = setTimeout(() => startSandboxCamera(retryCount + 1), 200);
    }
  }
}

function stopSandboxCamera() {
  isRunning = false;
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
  postureBadge.textContent = 'STANDBY (OTHER TAB)';
}

grantAccessBtn.addEventListener('click', () => startSandboxCamera(0));

function drawHandTraceOnly(landmarks, result) {
  const w = canvas.width;
  const h = canvas.height;

  // Clean Dark Cyber Grid Background (never draws video feed!)
  if (video.readyState >= 2) { ctx.drawImage(video, 0, 0, 1, 1); }
  ctx.fillStyle = "#090d16";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.07)';
  ctx.lineWidth = 1;
  const step = 36;
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

  if (!landmarks) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🖐️ Raise your hand in front of the camera to trace', w / 2, h / 2);
    return;
  }

  const mapX = (x) => (1.0 - x) * w;
  const mapY = (y) => y * h;

  // Translucent Palm Fill
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
    : 'rgba(34, 211, 238, 0.14)';
  ctx.fill();

  const boneColor = result.isPinching ? '#10b981' : '#38bdf8';
  ctx.save();
  ctx.strokeStyle = boneColor;
  ctx.shadowColor = boneColor;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const [i, j] of HAND_CONNECTIONS) {
    ctx.moveTo(mapX(landmarks[i].x), mapY(landmarks[i].y));
    ctx.lineTo(mapX(landmarks[j].x), mapY(landmarks[j].y));
  }
  ctx.stroke();
  ctx.restore();

  for (let i = 0; i < landmarks.length; i++) {
    const px = mapX(landmarks[i].x);
    const py = mapY(landmarks[i].y);
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    ctx.beginPath();
    ctx.arc(px, py, isTip ? 5.5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = i === 8 ? '#22d3ee' : i === 4 ? '#f43f5e' : isTip ? '#a855f7' : '#fff';
    ctx.fill();
  }
}

function renderLoop() {
  if (!isRunning || document.hidden) {
    stopSandboxCamera();
    return;
  }

  const now = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime && handLandmarker) {
    lastVideoTime = video.currentTime;
    try {
      const detections = handLandmarker.detectForVideo(video, now);
      const hand = detections.landmarks?.[0] || null;

      if (hand) {
        const result = engine.processLandmarks(hand, now);
        postureBadge.textContent = result.posture;
        drawHandTraceOnly(hand, result);

        const cx = result.cursor.x * window.innerWidth;
        const cy = result.cursor.y * window.innerHeight;
        sandboxCursor.style.display = 'block';
        sandboxCursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        sandboxCursor.classList.toggle('pinching', Boolean(result.isPinching));

        for (const evt of result.events || []) {
          lastActionPill.textContent = `⚡ ${evt.type}`;

          if (evt.type === 'TAB_NEXT' || evt.type === 'TAB_PREV') {
            stopSandboxCamera();
            try {
              chrome.runtime.sendMessage({
                type: 'BROWSER_ACTION',
                action: evt.type,
                lastCursor: result.cursor
              }).catch(() => {});
            } catch (_) {}
            return;
          } else if (evt.type === 'CLICK') {
            const el = document.elementFromPoint(cx, cy);
            el?.click?.();
          } else if (evt.type === 'DOUBLE_CLICK') {
            const el = document.elementFromPoint(cx, cy);
            el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          } else if (evt.type === 'DRAG_MOVE') {
            const rect = dragSlider.getBoundingClientRect();
            if (cy >= rect.top - 50 && cy <= rect.bottom + 50) {
              const pct = Math.max(0, Math.min(100, Math.round(((cx - rect.left) / rect.width) * 100)));
              dragSlider.value = String(pct);
              sliderValueText.textContent = `Value: ${pct}%`;
            }
          } else if (evt.type === 'SCROLL_MOVE') {
            scrollBox.scrollBy({ top: evt.deltaY });
            window.scrollBy({ top: evt.deltaY * 0.5 });
          }
        }
      } else {
        postureBadge.textContent = 'NO HAND';
        sandboxCursor.style.display = 'none';
        drawHandTraceOnly(null, {});
      }
    } catch (_) {}
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

drawHandTraceOnly(null, {});
startSandboxCamera(0);
