/**
 * HandFlow — Persistent Background Offscreen Tracker (offscreen.js)
 * Runs MediaPipe HandLandmarker continuously in the background so the live pointer
 * stays active across EVERY tab switch and window in Chrome without re-initializing.
 */

import { FilesetResolver, HandLandmarker } from './lib/mediapipe/vision_bundle.mjs';
import { GestureEngine, DEFAULT_SETTINGS } from './gesture_engine.js';

const video = document.getElementById('webcam');
let settings = { ...DEFAULT_SETTINGS };
const engine = new GestureEngine(settings);

let handLandmarker = null;
let stream = null;
let isRunning = false;
let loopTimer = null;
let lastVideoTime = -1;
let port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'handflow-offscreen' });
    port.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'UPDATE_SETTINGS') {
        settings = { ...settings, ...msg.settings };
        engine.updateSettings(settings);
        if (!settings.enabled) {
          stopCamera();
        } else if (!isRunning) {
          startCamera();
        }
      } else if (msg.type === 'PAUSE_OFFSCREEN') {
        stopCamera();
      } else if (msg.type === 'RESUME_OFFSCREEN') {
        if (settings.enabled && !isRunning) {
          startCamera();
        }
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 500);
    });
  } catch (_) {}
}

connectPort();

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
      minHandDetectionConfidence: 0.52,
      minHandPresenceConfidence: 0.52,
      minTrackingConfidence: 0.52
    });
  } catch (_) {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.52,
      minHandPresenceConfidence: 0.52,
      minTrackingConfidence: 0.52
    });
  }
  return handLandmarker;
}

async function startCamera() {
  if (isRunning || !settings.enabled) return;
  isRunning = true;

  try {
    await initMediaPipe();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;

    if (port) {
      port.postMessage({ type: 'OFFSCREEN_STATUS', status: 'TRACKING' });
    }
    scheduleNextTick();
  } catch (err) {
    isRunning = false;
    if (port) {
      port.postMessage({
        type: 'OFFSCREEN_STATUS',
        status: 'ERROR',
        errorName: err?.name || 'Error',
        errorMessage: err?.message || 'Camera failed'
      });
    }
  }
}

function stopCamera() {
  isRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

function scheduleNextTick() {
  if (!isRunning) return;
  loopTimer = setTimeout(tick, 24); // ~42 FPS unthrottled background loop
}

function tick() {
  if (!isRunning) return;
  const now = performance.now();

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime && handLandmarker) {
    lastVideoTime = video.currentTime;
    try {
      const detections = handLandmarker.detectForVideo(video, now);
      const hand = detections.landmarks?.[0] || null;

      if (hand) {
        const result = engine.processLandmarks(hand, now);
        // Handle browser-level actions directly so they work even if active tab is chrome://
        const browserActions = [];
        const contentEvents = [];

        for (const evt of result.events || []) {
          if (
            evt.type === 'TAB_NEXT' ||
            evt.type === 'TAB_PREV' ||
            evt.type === 'ZOOM_IN' ||
            evt.type === 'ZOOM_OUT'
          ) {
            browserActions.push(evt.type);
          } else {
            contentEvents.push(evt);
          }
        }

        if (port) {
          for (const act of browserActions) {
            port.postMessage({ type: 'BROWSER_ACTION', action: act });
          }
          // Include compact landmark points for mini HUD skeleton rendering in content.js!
          const compactLandmarks = settings.showSkeleton
            ? hand.map((pt) => ({
                x: +pt.x.toFixed(3),
                y: +pt.y.toFixed(3)
              }))
            : null;

          port.postMessage({
            type: 'HAND_FRAME',
            payload: {
              ...result,
              events: contentEvents,
              landmarks: compactLandmarks
            }
          });
        }
      } else if (port) {
        port.postMessage({ type: 'HAND_LOST' });
      }
    } catch (_) {}
  }

  scheduleNextTick();
}

// Start immediately
startCamera();
