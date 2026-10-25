/**
 * Handdy — Onboarding, Camera Permission & Interactive Sandbox (permission.js)
 * Automatically releases the webcam the instant you switch to another tab so
 * every tab in Chrome gets immediate access to the camera and live pointer!
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

// CRITICAL: Release webcam immediately when switching to another tab so the new tab can grab it!
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
      numHands: 1
    });
  } catch (_) {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1
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
    statusMsg.textContent = 'Starting camera...';
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
      audio: false
    });

    if (document.hidden) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }

    stream = newStream;
    permissionGranted = true;
    chrome.runtime.sendMessage({ type: 'CAMERA_PERMISSION_GRANTED' });

    grantAccessBtn.textContent = '✅ Camera Ready — Works Across All Tabs!';
    grantAccessBtn.classList.add('granted');
    statusMsg.textContent =
      'Camera permission granted! Switch to ANY tab in Chrome to use your live hand pointer.';
    statusMsg.style.color = '#10b981';

    video.srcObject = stream;
    await video.play();
    await initMediaPipe();

    isRunning = true;
    lastVideoTime = -1;
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

function drawPreview(landmarks, result) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, w, h);
  }
  ctx.restore();

  if (!landmarks) return;

  const mapX = (x) => (1.0 - x) * w;
  const mapY = (y) => y * h;

  ctx.strokeStyle = result.isPinching ? '#10b981' : '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (const [i, j] of HAND_CONNECTIONS) {
    ctx.moveTo(mapX(landmarks[i].x), mapY(landmarks[i].y));
    ctx.lineTo(mapX(landmarks[j].x), mapY(landmarks[j].y));
  }
  ctx.stroke();

  for (let i = 0; i < landmarks.length; i++) {
    ctx.beginPath();
    ctx.arc(mapX(landmarks[i].x), mapY(landmarks[i].y), i === 8 || i === 4 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = i === 8 ? '#22d3ee' : i === 4 ? '#f43f5e' : '#fff';
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
        drawPreview(hand, result);

        const cx = result.cursor.x * window.innerWidth;
        const cy = result.cursor.y * window.innerHeight;
        sandboxCursor.style.display = 'block';
        sandboxCursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        sandboxCursor.classList.toggle('pinching', Boolean(result.isPinching));

        for (const evt of result.events || []) {
          lastActionPill.textContent = `⚡ ${evt.type}`;

          if (evt.type === 'TAB_NEXT' || evt.type === 'TAB_PREV') {
            stopSandboxCamera();
            chrome.runtime.sendMessage({
              type: 'BROWSER_ACTION',
              action: evt.type,
              lastCursor: result.cursor
            });
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
        drawPreview(null, {});
      }
    } catch (_) {}
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

startSandboxCamera(0);
