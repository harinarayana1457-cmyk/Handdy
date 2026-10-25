/**
 * Handdy — Persistent Side Panel Controller (sidepanel.js)
 * Keeps camera & MediaPipe running uninterrupted across all tab switches and URLs.
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
const port = chrome.runtime.connect({ name: 'Handdy-sidepanel' });

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
    fpsBadge.textContent = 'Loading Model...';
    const wasmPath = chrome.runtime.getURL('lib/mediapipe/wasm');
    const modelPath = chrome.runtime.getURL('models/hand_landmarker.task');

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55
      });
    } catch (_) {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 400 }, height: { ideal: 300 }, frameRate: { ideal: 30 } },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    requestAnimationFrame(loop);
  } catch (err) {
    fpsBadge.textContent = 'Camera Needed';
    lastEventText.textContent = 'Click here to grant camera permission';
    lastEventText.style.cursor = 'pointer';
    lastEventText.style.color = '#38bdf8';
    lastEventText.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
    });
  }
}

function drawCanvas(landmarks, result) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.save();
  if (settings.mirrorCamera) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, w, h);
  }
  ctx.restore();

  if (!landmarks) return;

  const mapX = (x) => (settings.mirrorCamera ? (1.0 - x) * w : x * w);
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
    ctx.fillStyle = i === 8 ? '#22d3ee' : i === 4 ? '#f43f5e' : '#ffffff';
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
      drawCanvas(hand, result);

      // Handle browser-level tab/zoom events directly in Side Panel so they even work on chrome:// tabs!
      if (Array.isArray(result.events)) {
        for (const evt of result.events) {
          lastEventText.textContent = `⚡ ${evt.type}`;
          if (evt.type === 'TAB_NEXT' || evt.type === 'TAB_PREV' || evt.type === 'ZOOM_IN' || evt.type === 'ZOOM_OUT') {
            port.postMessage({ type: 'BROWSER_ACTION', action: evt.type });
          }
        }
      }

      // Filter out TAB_NEXT/TAB_PREV/ZOOM from content script payload so they aren't double-triggered
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
      drawCanvas(null, {});
      port.postMessage({ type: 'HAND_LOST' });
    }
  }

  requestAnimationFrame(loop);
}

startSidePanelTracker();
