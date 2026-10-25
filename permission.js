/**
 * HandFlow — Onboarding, Camera Permission & Unthrottled Central Tracker (permission.js)
 * Keeps tracking active even when this tab is in the background so your live pointer
 * runs seamlessly across ANY tab in Chrome.
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
let lastVideoTime = -1;
let isRunning = false;
let trackerPort = null;
let keepAliveAudioCtx = null;

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

function enableBackgroundKeepAlive() {
  // 1. Hold a Web Lock so Chrome never freezes this tab when you switch to other tabs
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request('handflow_background_tracker_lock', () => new Promise(() => {})).catch(() => {});
  }
  // 2. Silent WebAudio oscillator prevents background timer throttling
  try {
    if (!keepAliveAudioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      keepAliveAudioCtx = new AudioContextClass();
      const osc = keepAliveAudioCtx.createOscillator();
      const gain = keepAliveAudioCtx.createGain();
      gain.gain.value = 0.00001; // Completely inaudible
      osc.connect(gain);
      gain.connect(keepAliveAudioCtx.destination);
      osc.start();
    } else if (keepAliveAudioCtx.state === 'suspended') {
      keepAliveAudioCtx.resume().catch(() => {});
    }
  } catch (_) {}
}

function connectTrackerPort() {
  if (trackerPort) return;
  try {
    trackerPort = chrome.runtime.connect({ name: 'handflow-permission-tracker' });
    trackerPort.onMessage.addListener((msg) => {
      if (msg?.type === 'UPDATE_SETTINGS' && msg.settings) {
        settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        engine.updateSettings(settings);
      }
    });
    trackerPort.onDisconnect.addListener(() => {
      trackerPort = null;
      if (isRunning) setTimeout(connectTrackerPort, 500);
    });
  } catch (_) {}
}

async function requestCameraAndStart() {
  if (isRunning) return;
  try {
    statusMsg.textContent = 'Requesting camera permission...';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
      audio: false
    });

    enableBackgroundKeepAlive();
    connectTrackerPort();

    chrome.runtime.sendMessage({ type: 'CAMERA_PERMISSION_GRANTED' });

    grantAccessBtn.textContent = '✅ Live Pointer Active Across All Tabs!';
    grantAccessBtn.classList.add('granted');
    statusMsg.textContent =
      'Live Pointer is now streaming to ALL tabs! Switch to any tab in Chrome to use your hand pointer.';
    statusMsg.style.color = '#10b981';

    video.srcObject = stream;
    await video.play();

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

    isRunning = true;
    scheduleNextFrame();
  } catch (err) {
    statusMsg.textContent = `Camera permission needed: Click "Grant Camera Access & Start" and allow camera in the top-left prompt.`;
    statusMsg.style.color = '#f43f5e';
  }
}

grantAccessBtn.addEventListener('click', requestCameraAndStart);

function drawPreview(landmarks, result) {
  if (document.hidden) return; // Skip local canvas redraw when user is on another tab to save GPU
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

function scheduleNextFrame() {
  if (!isRunning) return;
  // Use unthrottled setTimeout when hidden so tracking continues at 42 FPS while browsing other tabs!
  if (document.hidden) {
    setTimeout(renderLoop, 22);
  } else {
    requestAnimationFrame(renderLoop);
  }
}

function renderLoop() {
  if (!isRunning) return;
  const now = performance.now();

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime && handLandmarker) {
    lastVideoTime = video.currentTime;
    try {
      const detections = handLandmarker.detectForVideo(video, now);
      const hand = detections.landmarks?.[0] || null;

      if (hand) {
        const result = engine.processLandmarks(hand, now);
        drawPreview(hand, result);

        const compactLandmarks = settings.showSkeleton
          ? hand.map((pt) => ({ x: +pt.x.toFixed(3), y: +pt.y.toFixed(3) }))
          : null;

        // Separate browser-level actions from content-script events
        const contentEvents = [];
        for (const evt of result.events || []) {
          if (
            evt.type === 'TAB_NEXT' ||
            evt.type === 'TAB_PREV' ||
            evt.type === 'ZOOM_IN' ||
            evt.type === 'ZOOM_OUT'
          ) {
            trackerPort?.postMessage({ type: 'BROWSER_ACTION', action: evt.type });
          } else {
            contentEvents.push(evt);
          }
        }

        // Stream live pointer frame to whichever tab the user is currently viewing!
        trackerPort?.postMessage({
          type: 'HAND_FRAME',
          payload: {
            ...result,
            events: contentEvents,
            landmarks: compactLandmarks
          }
        });

        // If user is currently viewing this sandbox page, also update local sandbox widgets
        if (!document.hidden) {
          postureBadge.textContent = result.posture;
          const cx = result.cursor.x * window.innerWidth;
          const cy = result.cursor.y * window.innerHeight;
          sandboxCursor.style.display = 'block';
          sandboxCursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
          sandboxCursor.classList.toggle('pinching', Boolean(result.isPinching));

          for (const evt of result.events || []) {
            lastActionPill.textContent = `⚡ ${evt.type}`;
            if (evt.type === 'CLICK') {
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
        }
      } else {
        trackerPort?.postMessage({ type: 'HAND_LOST' });
        if (!document.hidden) {
          postureBadge.textContent = 'NO HAND';
          sandboxCursor.style.display = 'none';
          drawPreview(null, {});
        }
      }
    } catch (_) {}
  }

  scheduleNextFrame();
}

// Auto-start if camera permission was already granted
requestCameraAndStart();
