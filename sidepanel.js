/**
 * Handdy — Persistent Side Panel Controller (sidepanel.js)
 * Keeps hand tracking running uninterrupted across all tab switches and renders
 * ONLY the traced 21-point hand skeleton on a dark cyber grid (no webcam video).
 */

import { FilesetResolver, HandLandmarker } from './lib/mediapipe/vision_bundle.mjs';
import { GestureEngine, DEFAULT_SETTINGS } from './gesture_engine.js';

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const fpsBadge = document.getElementById('fpsBadge');
const postureTag = document.getElementById('postureTag');
const lastEventText = document.getElementById('lastEventText');

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
const port = chrome.runtime.connect({ name: 'handdy-sidepanel' });

let handLandmarker = null;
let lastVideoTime = -1;
let frameCount = 0;
let lastFpsTime = performance.now();

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

async function startSidePanelTracker() {
  try {
    fpsBadge.textContent = 'Loading AI...';
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

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    drawHandTraceOnly(null, {});
    requestAnimationFrame(loop);
  } catch (_) {
    fpsBadge.textContent = 'Camera Needed';
    lastEventText.textContent = 'Click here to grant camera permission';
    lastEventText.style.cursor = 'pointer';
    lastEventText.style.color = '#38bdf8';
    lastEventText.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
    });
  }
}

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
    ctx.fillText('🖐️ Raise hand to trace', w / 2, h / 2);
    return;
  }

  const mapX = (x) => (settings.mirrorCamera ? (1.0 - x) * w : x * w);
  const mapY = (y) => y * h;

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
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    ctx.beginPath();
    ctx.arc(mapX(landmarks[i].x), mapY(landmarks[i].y), isTip ? 5.5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = i === 8 ? '#22d3ee' : i === 4 ? '#f43f5e' : isTip ? '#a855f7' : '#ffffff';
    ctx.fill();
  }
}

function loop() {
  const now = performance.now();
  frameCount++;
  if (now - lastFpsTime >= 1000) {
    fpsBadge.textContent = `${frameCount} FPS`;
    frameCount = 0;
    lastFpsTime = now;
  }

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const detections = handLandmarker.detectForVideo(video, now);
    const hand = detections.landmarks?.[0] || null;

    if (hand) {
      const result = engine.processLandmarks(hand, now);
      postureTag.textContent = result.posture;
      drawHandTraceOnly(hand, result);

      if (Array.isArray(result.events)) {
        for (const evt of result.events) {
          lastEventText.textContent = `⚡ ${evt.type}`;
          if (evt.type === 'TAB_NEXT' || evt.type === 'TAB_PREV' || evt.type === 'ZOOM_IN' || evt.type === 'ZOOM_OUT') {
            port.postMessage({ type: 'BROWSER_ACTION', action: evt.type });
          }
        }
      }

      const contentEvents = (result.events || []).filter(
        (e) => e.type !== 'TAB_NEXT' && e.type !== 'TAB_PREV' && e.type !== 'ZOOM_IN' && e.type !== 'ZOOM_OUT'
      );

      const compactLandmarks = settings.showSkeleton
        ? hand.map((pt) => ({
            x: +pt.x.toFixed(3),
            y: +pt.y.toFixed(3)
          }))
        : null;

      port.postMessage({
        type: 'HAND_FRAME',
        payload: { ...result, events: contentEvents, landmarks: compactLandmarks }
      });
    } else {
      postureTag.textContent = 'NO HAND DETECTED';
      drawHandTraceOnly(null, {});
      port.postMessage({ type: 'HAND_LOST' });
    }
  }

  requestAnimationFrame(loop);
}

drawHandTraceOnly(null, {});
startSidePanelTracker();
