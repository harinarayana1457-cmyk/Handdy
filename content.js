/**
 * Handdy — Universal Cross-Tab Live Pointer & Gesture Content Script (content.js)
 * Renders an always-on, high-visibility Live Pointer + Trail + Camera HUD on ANY Chrome tab,
 * with instant webcam handoff and cursor position continuity across tab switches.
 */

(() => {
  if (window.__HANDDY_RUNNING__) {
    try {
      if (typeof window.__HANDDY_CLEANUP__ === 'function') {
        window.__HANDDY_CLEANUP__();
      }
    } catch (_) {}
  }
  window.__HANDDY_RUNNING__ = true;
  let isDestroyed = false;
  const instanceId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (document.documentElement) {
    document.documentElement.dataset.handdyInstanceId = instanceId;
  }

  // Remove any stale host left over from a previous extension reload
  document.querySelectorAll("#handflow-extension-host, #handdy-extension-host, #handdy-extension-host").forEach(el => el.remove());

  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'label',
    'video',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  let settings = {
    enabled: true,
    sensitivity: 1.35,
    smoothing: 0.65,
    pinchThreshold: 0.28,
    scrollSpeed: 1.25,
    invertScroll: false,
    mirrorCamera: true,
    magneticSnap: true,
    dwellClick: false,
    dwellTimeMs: 1000,
    showCameraHud: true,
    showSkeleton: true,
    hudPosition: 'bottom-right'
  };

  let sidePanelActive = false;
  let hudMinimized = false;
  let radialMenuOpen = false;
  let radialMenuCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  // Live Pointer state in normalized [0..1] and viewport [px] coordinates
  let normX = 0.5;
  let normY = 0.5;
  let screenX = window.innerWidth * 0.5;
  let screenY = window.innerHeight * 0.5;
  let lastSyncTime = 0;

  let currentSnapTarget = null;
  let lastHoveredElement = null;
  let dragTarget = null;
  let toastTimeout = null;
  let trailPoints = [];

  // Create isolated Shadow DOM host
  const host = document.createElement('div');
  host.id = 'handdy-extension-host';
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '2147483647',
    overflow: 'hidden'
  });

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        user-select: none;
      }

      #trailCanvas {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 88;
      }

      /* Always-Visible High-Contrast Live Pointer */
      .hf-cursor {
        position: fixed;
        top: 0;
        left: 0;
        width: 44px;
        height: 44px;
        pointer-events: none;
        z-index: 100;
        will-change: transform;
        display: block;
      }
      .hf-cursor.disabled {
        display: none !important;
      }

      .hf-cursor-ring {
        position: absolute;
        top: -18px;
        left: -18px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 2.5px solid #22d3ee;
        background: rgba(34, 211, 238, 0.15);
        box-shadow: 0 0 18px rgba(34, 211, 238, 0.7), inset 0 0 8px rgba(34, 211, 238, 0.35);
        transition: transform 0.1s ease, border-color 0.12s ease, background 0.12s ease;
      }

      .hf-cursor-arrow {
        position: absolute;
        top: -2px;
        left: -2px;
        width: 28px;
        height: 28px;
        filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.85)) drop-shadow(0 0 8px rgba(34, 211, 238, 0.6));
        transition: transform 0.1s ease;
      }

      .hf-cursor.idle .hf-cursor-ring {
        border-color: rgba(56, 189, 248, 0.75);
        background: rgba(15, 23, 42, 0.35);
        box-shadow: 0 0 14px rgba(56, 189, 248, 0.45);
        animation: hf-idle-pulse 1.8s infinite ease-in-out;
      }
      @keyframes hf-idle-pulse {
        0%, 100% { transform: scale(0.95); opacity: 0.8; }
        50% { transform: scale(1.12); opacity: 1; }
      }

      .hf-cursor.pinching .hf-cursor-ring {
        transform: scale(0.68);
        border-color: #10b981;
        background: rgba(16, 185, 129, 0.45);
        box-shadow: 0 0 24px rgba(16, 185, 129, 0.95);
      }
      .hf-cursor.pinching .hf-cursor-arrow {
        transform: scale(0.88);
      }

      .hf-cursor.dragging .hf-cursor-ring {
        border-color: #f43f5e;
        background: rgba(244, 63, 94, 0.38);
        box-shadow: 0 0 24px rgba(244, 63, 94, 0.85);
      }

      .hf-cursor.scrolling .hf-cursor-ring {
        border-color: #a855f7;
        background: rgba(168, 85, 247, 0.3);
        box-shadow: 0 0 22px rgba(168, 85, 247, 0.8);
      }

      .hf-cursor.clutch .hf-cursor-ring {
        border-color: #f59e0b;
        border-style: dashed;
        background: rgba(245, 158, 11, 0.22);
      }

      .hf-cursor-label {
        position: absolute;
        left: 24px;
        top: 18px;
        background: rgba(15, 23, 42, 0.9);
        color: #f8fafc;
        font-size: 10px;
        font-weight: 800;
        padding: 3px 8px;
        border-radius: 999px;
        letter-spacing: 0.04em;
        white-space: nowrap;
        border: 1px solid rgba(56, 189, 248, 0.4);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      }

      .hf-progress-svg {
        position: absolute;
        top: -22px;
        left: -22px;
        width: 44px;
        height: 44px;
        transform: rotate(-90deg);
        pointer-events: none;
      }
      .hf-progress-circle {
        fill: none;
        stroke: #10b981;
        stroke-width: 3;
        stroke-dasharray: 113;
        stroke-dashoffset: 113;
        stroke-linecap: round;
      }

      .hf-snap-highlight {
        position: fixed;
        pointer-events: none;
        border: 2px solid rgba(34, 211, 238, 0.9);
        background: rgba(34, 211, 238, 0.1);
        border-radius: 8px;
        box-shadow: 0 0 16px rgba(34, 211, 238, 0.4);
        transition: all 0.08s ease-out;
        z-index: 90;
        display: none;
      }
      .hf-snap-highlight.visible {
        display: block;
      }

      .hf-ripple {
        position: fixed;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        margin-top: -9px;
        border-radius: 50%;
        border: 3px solid #10b981;
        pointer-events: none;
        z-index: 95;
        animation: hf-ripple-anim 0.48s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      @keyframes hf-ripple-anim {
        0% { transform: scale(0.5); opacity: 1; }
        100% { transform: scale(3.6); opacity: 0; }
      }

      .hf-scroll-anchor {
        position: fixed;
        width: 48px;
        height: 48px;
        margin-left: -24px;
        margin-top: -24px;
        border-radius: 50%;
        border: 2px dashed rgba(168, 85, 247, 0.85);
        background: rgba(168, 85, 247, 0.14);
        display: none;
        align-items: center;
        justify-content: center;
        color: #e9d5ff;
        font-size: 15px;
        font-weight: 700;
        pointer-events: none;
        z-index: 92;
      }
      .hf-scroll-anchor.visible {
        display: flex;
      }

      .hf-toast {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%) translateY(-16px);
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(56, 189, 248, 0.45);
        color: #f8fafc;
        padding: 8px 18px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: none;
        z-index: 110;
      }
      .hf-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      .hf-radial-menu {
        position: fixed;
        width: 280px;
        height: 280px;
        margin-left: -140px;
        margin-top: -140px;
        border-radius: 50%;
        background: rgba(15, 23, 42, 0.86);
        backdrop-filter: blur(12px);
        border: 1.5px solid rgba(99, 102, 241, 0.55);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
        display: none;
        pointer-events: auto;
        z-index: 98;
      }
      .hf-radial-menu.visible {
        display: block;
      }
      .hf-radial-center {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 68px;
        height: 68px;
        margin-left: -34px;
        margin-top: -34px;
        border-radius: 50%;
        background: rgba(30, 41, 59, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #94a3b8;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        text-align: center;
      }
      .hf-radial-item {
        position: absolute;
        width: 74px;
        height: 44px;
        margin-left: -37px;
        margin-top: -22px;
        border-radius: 12px;
        background: rgba(30, 41, 59, 0.94);
        border: 1px solid rgba(148, 163, 184, 0.3);
        color: #f8fafc;
        font-size: 11px;
        font-weight: 600;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 0.12s ease, background 0.12s ease;
      }
      .hf-radial-item:hover,
      .hf-radial-item.hovered {
        transform: scale(1.12);
        background: linear-gradient(135deg, #4f46e5, #06b6d4);
        border-color: #fff;
      }

      /* Mini Camera / Skeleton HUD Dock */
      .hf-camera-dock {
        position: fixed;
        width: 210px;
        height: 168px;
        background: #0f172a;
        border-radius: 14px;
        border: 1.5px solid rgba(56, 189, 248, 0.45);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
        overflow: hidden;
        pointer-events: auto;
        z-index: 95;
        display: flex;
        flex-direction: column;
        transition: width 0.2s ease, height 0.2s ease, opacity 0.2s ease;
      }
      .hf-camera-dock.pos-bottom-right { bottom: 16px; right: 16px; }
      .hf-camera-dock.pos-bottom-left { bottom: 16px; left: 16px; }
      .hf-camera-dock.pos-top-right { top: 16px; right: 16px; }
      .hf-camera-dock.pos-top-left { top: 16px; left: 16px; }
      .hf-camera-dock.minimized {
        width: 154px;
        height: 28px;
      }
      .hf-camera-dock.hidden {
        opacity: 0;
        pointer-events: none;
        width: 1px;
        height: 1px;
      }
      .hf-dock-header {
        height: 28px;
        background: rgba(15, 23, 42, 0.96);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 700;
        color: #e2e8f0;
      }
      .hf-dock-title {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .hf-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
      }
      .hf-dock-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .hf-dock-btn {
        background: rgba(255, 255, 255, 0.08);
        border: none;
        color: #cbd5e1;
        width: 20px;
        height: 20px;
        border-radius: 5px;
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hf-dock-btn:hover {
        background: rgba(56, 189, 248, 0.5);
        color: #fff;
      }
      .hf-dock-body {
        position: relative;
        flex: 1;
        width: 100%;
        background: radial-gradient(circle at center, #1e293b, #090d16);
      }
      #hudSkeletonCanvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: none;
      }
      #hudSkeletonCanvas.active {
        display: block;
      }
      .hf-camera-iframe {
        width: 100%;
        height: 100%;
        border: none;
        display: block;
        background: #090d16;
      }
      .hf-camera-iframe.hidden-iframe {
        display: none;
      }
    </style>

    <canvas id="trailCanvas"></canvas>
    <div id="snapHighlight" class="hf-snap-highlight"></div>
    <div id="scrollAnchor" class="hf-scroll-anchor">⇅</div>

    <div id="radialMenu" class="hf-radial-menu">
      <div id="radialClose" class="hf-radial-center" data-radial-action="CLOSE_MENU">Close<br/>✕</div>
    </div>

    <div id="cursor" class="hf-cursor idle">
      <div class="hf-cursor-ring"></div>
      <svg class="hf-progress-svg" viewBox="0 0 42 42">
        <circle id="progressCircle" class="hf-progress-circle" cx="21" cy="21" r="18"></circle>
      </svg>
      <svg class="hf-cursor-arrow" viewBox="0 0 28 28" fill="none">
        <path d="M2 2L11.5 24L15.2 15.2L24 11.5L2 2Z" fill="#22d3ee" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      </svg>
      <div id="cursorLabel" class="hf-cursor-label">SHOW HAND 🖐️</div>
    </div>

    <div id="toast" class="hf-toast"></div>

    <div id="cameraDock" class="hf-camera-dock pos-bottom-right">
      <div class="hf-dock-header">
        <div class="hf-dock-title">
          <span class="hf-live-dot"></span>
          <span>Handdy Live</span>
        </div>
        <div class="hf-dock-actions">
          <button id="cornerBtn" class="hf-dock-btn" title="Move Corner">✥</button>
          <button id="sidePanelBtn" class="hf-dock-btn" title="Open Persistent Side Panel">◧</button>
          <button id="minimizeBtn" class="hf-dock-btn" title="Minimize Preview">—</button>
        </div>
      </div>
      <div class="hf-dock-body">
        <canvas id="hudSkeletonCanvas" width="210" height="140"></canvas>
        <iframe id="cameraIframe" class="hf-camera-iframe" allow="camera; microphone"></iframe>
      </div>
    </div>
  `;

  function isContextValid() {
    if (isDestroyed) return false;
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return false;
      if (
        document.documentElement &&
        document.documentElement.dataset.handdyInstanceId &&
        document.documentElement.dataset.handdyInstanceId !== instanceId
      ) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function selfDestruct() {
    if (isDestroyed) return;
    isDestroyed = true;
    window.__HANDDY_RUNNING__ = false;
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
    window.removeEventListener('message', onWindowMessage);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('fullscreenchange', mountHost);
    window.removeEventListener('resize', resizeTrailCanvas);
    try {
      cameraIframe.src = 'about:blank';
    } catch (_) {}
    try {
      host.remove();
    } catch (_) {}
  }

  function safeSendMessage(payload, callback) {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    try {
      if (typeof callback === 'function') {
        chrome.runtime.sendMessage(payload, (res) => {
          try {
            if (!isContextValid() || chrome.runtime.lastError) return;
            callback(res);
          } catch (_) {
            selfDestruct();
          }
        });
      } else {
        const p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      }
    } catch (_) {
      selfDestruct();
    }
  }

  function safeGetURL(path) {
    if (!isContextValid()) {
      selfDestruct();
      return 'about:blank';
    }
    try {
      return chrome.runtime.getURL(path);
    } catch (_) {
      selfDestruct();
      return 'about:blank';
    }
  }

  function safeStorageSet(data) {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    try {
      const p = chrome.storage.local.set(data);
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (_) {
      selfDestruct();
    }
  }

  function mountHost() {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    document.querySelectorAll("#handflow-extension-host, #Handdy-extension-host, #handdy-extension-host").forEach((el) => {
      if (el !== host) el.remove();
    });
    const container = document.fullscreenElement || document.documentElement;
    if (container && !container.contains(host)) {
      container.appendChild(host);
    }
  }
  mountHost();
  document.addEventListener("fullscreenchange", mountHost);

  const trailCanvas = shadow.getElementById('trailCanvas');
  const trailCtx = trailCanvas.getContext('2d');
  const cursorEl = shadow.getElementById('cursor');
  const cursorLabelEl = shadow.getElementById('cursorLabel');
  const progressCircle = shadow.getElementById('progressCircle');
  const snapHighlightEl = shadow.getElementById('snapHighlight');
  const scrollAnchorEl = shadow.getElementById('scrollAnchor');
  const radialMenuEl = shadow.getElementById('radialMenu');
  const toastEl = shadow.getElementById('toast');
  const cameraDockEl = shadow.getElementById('cameraDock');
  const cameraIframe = shadow.getElementById('cameraIframe');
  const hudSkeletonCanvas = shadow.getElementById('hudSkeletonCanvas');
  const hudSkeletonCtx = hudSkeletonCanvas.getContext('2d');
  const minimizeBtn = shadow.getElementById('minimizeBtn');
  const cornerBtn = shadow.getElementById('cornerBtn');
  const sidePanelBtn = shadow.getElementById('sidePanelBtn');

  function resizeTrailCanvas() {
    trailCanvas.width = window.innerWidth;
    trailCanvas.height = window.innerHeight;
  }
  resizeTrailCanvas();
  window.addEventListener('resize', resizeTrailCanvas);

  function setCursorFromNormalized(nx, ny) {
    normX = nx;
    normY = ny;
    screenX = normX * window.innerWidth;
    screenY = normY * window.innerHeight;
    cursorEl.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;
  }

  setCursorFromNormalized(0.5, 0.5);

  const RADIAL_ACTIONS = [
    { id: 'BACK', label: '← Back', angle: 180 },
    { id: 'TAB_PREV', label: '⏮ Prev Tab', angle: 225 },
    { id: 'PLAY_PAUSE', label: '⏯ Media', angle: 270 },
    { id: 'TAB_NEXT', label: 'Next Tab ⏭', angle: 315 },
    { id: 'FORWARD', label: 'Forward →', angle: 0 },
    { id: 'NEW_TAB', label: '➕ New Tab', angle: 45 },
    { id: 'RELOAD', label: '🔄 Reload', angle: 90 },
    { id: 'SCROLL_TOP', label: '⏫ Top', angle: 135 }
  ];

  RADIAL_ACTIONS.forEach((item) => {
    const btn = document.createElement('div');
    btn.className = 'hf-radial-item';
    btn.dataset.radialAction = item.id;
    const rad = (item.angle * Math.PI) / 180;
    const radius = 96;
    btn.style.left = `${140 + Math.cos(rad) * radius}px`;
    btn.style.top = `${140 + Math.sin(rad) * radius}px`;
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeRadialAction(item.id);
    });
    radialMenuEl.appendChild(btn);
  });

  shadow.getElementById('radialClose').addEventListener('click', closeRadialMenu);

  minimizeBtn.addEventListener('click', () => {
    hudMinimized = !hudMinimized;
    cameraDockEl.classList.toggle('minimized', hudMinimized);
    minimizeBtn.textContent = hudMinimized ? '▢' : '—';
  });

  const CORNERS = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
  cornerBtn.addEventListener('click', () => {
    const idx = CORNERS.indexOf(settings.hudPosition || 'bottom-right');
    settings.hudPosition = CORNERS[(idx + 1) % CORNERS.length];
    updateDockAppearance();
    safeStorageSet({ settings });
  });

  sidePanelBtn.addEventListener('click', () => {
    safeSendMessage({ type: 'OPEN_SIDE_PANEL' });
  });

  function updateDockAppearance() {
    CORNERS.forEach((c) => cameraDockEl.classList.remove(`pos-${c}`));
    cameraDockEl.classList.add(`pos-${settings.hudPosition || 'bottom-right'}`);

    cursorEl.classList.toggle('disabled', !settings.enabled);

    if (!settings.enabled || !settings.showCameraHud) {
      cameraDockEl.classList.add('hidden');
    } else {
      cameraDockEl.classList.remove('hidden');
    }

    hudSkeletonCanvas.classList.toggle('active', sidePanelActive);
    cameraIframe.classList.toggle('hidden-iframe', sidePanelActive);
  }

  function drawHudSkeleton(landmarks, frame) {
    const w = hudSkeletonCanvas.width;
    const h = hudSkeletonCanvas.height;
    hudSkeletonCtx.clearRect(0, 0, w, h);

    if (!landmarks || landmarks.length < 21) {
      hudSkeletonCtx.fillStyle = '#94a3b8';
      hudSkeletonCtx.font = '600 11px sans-serif';
      hudSkeletonCtx.textAlign = 'center';
      hudSkeletonCtx.fillText('Side Panel Tracking Active', w / 2, h / 2);
      return;
    }

    const mapX = (x) => (settings.mirrorCamera ? (1.0 - x) * w : x * w);
    const mapY = (y) => y * h;

    hudSkeletonCtx.strokeStyle = frame.isPinching
      ? '#10b981'
      : frame.isScrolling
      ? '#a855f7'
      : '#22d3ee';
    hudSkeletonCtx.lineWidth = 2;
    hudSkeletonCtx.beginPath();
    for (const [i, j] of HAND_CONNECTIONS) {
      hudSkeletonCtx.moveTo(mapX(landmarks[i].x), mapY(landmarks[i].y));
      hudSkeletonCtx.lineTo(mapX(landmarks[j].x), mapY(landmarks[j].y));
    }
    hudSkeletonCtx.stroke();

    for (let i = 0; i < landmarks.length; i++) {
      hudSkeletonCtx.beginPath();
      hudSkeletonCtx.arc(
        mapX(landmarks[i].x),
        mapY(landmarks[i].y),
        i === 8 || i === 4 ? 4 : 2.2,
        0,
        Math.PI * 2
      );
      hudSkeletonCtx.fillStyle = i === 8 ? '#22d3ee' : i === 4 ? '#f43f5e' : '#f8fafc';
      hudSkeletonCtx.fill();
    }
  }

  function drawTrail() {
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    const now = performance.now();
    trailPoints = trailPoints.filter((p) => now - p.t < 180);
    if (trailPoints.length < 2) return;

    for (let i = 1; i < trailPoints.length; i++) {
      const p0 = trailPoints[i - 1];
      const p1 = trailPoints[i];
      const alpha = (1 - (now - p1.t) / 180) * 0.45;
      trailCtx.strokeStyle = `rgba(34, 211, 238, ${alpha})`;
      trailCtx.lineWidth = (i / trailPoints.length) * 5;
      trailCtx.lineCap = 'round';
      trailCtx.beginPath();
      trailCtx.moveTo(p0.x, p0.y);
      trailCtx.lineTo(p1.x, p1.y);
      trailCtx.stroke();
    }
  }

  function showToast(text, duration = 1600) {
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, duration);
  }

  function spawnRipple(x, y, color = '#10b981') {
    const ripple = document.createElement('div');
    ripple.className = 'hf-ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.borderColor = color;
    shadow.appendChild(ripple);
    setTimeout(() => ripple.remove(), 500);
  }

  function sendCameraCommand(command, extra = {}) {
    if (!cameraIframe.contentWindow) return;
    cameraIframe.contentWindow.postMessage(
      {
        target: 'HANDDY_CAMERA_FRAME',
        command,
        ...extra
      },
      '*'
    );
  }

  function syncCameraFrameState() {
    const shouldPause = !settings.enabled || sidePanelActive || document.hidden;
    sendCameraCommand(shouldPause ? 'PAUSE_CAMERA' : 'RESUME_CAMERA', {
      lastCursor: { x: normX, y: normY }
    });
  }

  // Load camera_frame.html inside the dock
  if (!window.location.href.includes('permission.html')) {
    cameraIframe.addEventListener('load', () => {
      syncCameraFrameState();
    });
    cameraIframe.src = safeGetURL('camera_frame.html');
  }

  safeSendMessage({ type: 'GET_STATUS' }, (res) => {
    if (!res) return;
    settings = { ...settings, ...(res.settings || {}) };
    sidePanelActive = Boolean(res.sidePanelActive);
    if (res.lastCursor && typeof res.lastCursor.x === 'number') {
      setCursorFromNormalized(res.lastCursor.x, res.lastCursor.y);
    }
    updateDockAppearance();
    syncCameraFrameState();
  });

  function onVisibilityChange() {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    syncCameraFrameState();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Listen for tab handoff & frame messages from Background / SidePanel
  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!isContextValid()) {
      selfDestruct();
      return false;
    }
    if (!msg || !msg.type) return false;

    if (msg.type === 'PING_HANDDY') {
      sendResponse({ alive: true });
      return false;
    }

    if (msg.type === 'RELEASE_CAMERA_NOW') {
      sendCameraCommand('PAUSE_CAMERA');
      return false;
    }

    if (msg.type === 'ACTIVATE_TAB_CAMERA') {
      mountHost();
      if (typeof msg.sidePanelActive === 'boolean') {
        sidePanelActive = msg.sidePanelActive;
      }
      if (msg.lastCursor && typeof msg.lastCursor.x === 'number') {
        setCursorFromNormalized(msg.lastCursor.x, msg.lastCursor.y);
      }
      if (msg.toast) {
        showToast(`${msg.toast.direction} (${msg.toast.index}/${msg.toast.total})`);
      }
      updateDockAppearance();
      sendCameraCommand(sidePanelActive || !settings.enabled ? 'PAUSE_CAMERA' : 'RESUME_CAMERA', {
        lastCursor: { x: normX, y: normY }
      });
      return false;
    }

    if (msg.type === 'SETTINGS_UPDATED') {
      settings = { ...settings, ...msg.settings };
      if (typeof msg.sidePanelActive === 'boolean') {
        sidePanelActive = msg.sidePanelActive;
      }
      updateDockAppearance();
      syncCameraFrameState();
    } else if (msg.type === 'SIDEPANEL_STATUS') {
      sidePanelActive = Boolean(msg.active);
      updateDockAppearance();
      syncCameraFrameState();
    } else if (msg.type === 'CAMERA_PERMISSION_READY') {
      if (!window.location.href.includes('permission.html')) {
        cameraIframe.src = safeGetURL('camera_frame.html');
      }
      showToast('📷 Live Hand Pointer Connected!');
    } else if (msg.type === 'HAND_FRAME' && msg.payload) {
      if (msg.payload.landmarks) {
        drawHudSkeleton(msg.payload.landmarks, msg.payload);
      }
      handleHandFrame(msg.payload);
    } else if (msg.type === 'HAND_LOST') {
      drawHudSkeleton(null, {});
      setPointerIdle();
    } else if (msg.type === 'TAB_SWITCHED_TOAST') {
      showToast(`${msg.direction} (${msg.index}/${msg.total})`);
    }
    return false;
  }
  try {
    if (isContextValid()) {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    }
  } catch (_) {
    selfDestruct();
  }

  // Listen for direct postMessage from embedded camera_frame.html
  function onWindowMessage(event) {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    const data = event.data;
    if (!data || data.source !== 'HANDDY_CAMERA_FRAME') return;
    if (sidePanelActive) return;

    if (data.type === 'HAND_FRAME' && data.payload) {
      handleHandFrame(data.payload);
    } else if (data.type === 'HAND_LOST') {
      setPointerIdle();
    }
  }
  window.addEventListener('message', onWindowMessage);

  window.__HANDDY_CLEANUP__ = selfDestruct;

  function setPointerIdle() {
    cursorEl.classList.add('idle');
    cursorEl.classList.remove('pinching', 'dragging', 'scrolling', 'clutch');
    cursorLabelEl.textContent = 'SHOW HAND 🖐️';
    snapHighlightEl.classList.remove('visible');
    scrollAnchorEl.classList.remove('visible');
  }

  function findInteractiveTarget(x, y) {
    if (radialMenuOpen) {
      const radialEl = shadow.elementFromPoint(x, y);
      const radialBtn = radialEl?.closest?.('[data-radial-action]');
      shadow.querySelectorAll('.hf-radial-item').forEach((el) => {
        el.classList.toggle('hovered', el === radialBtn);
      });
      if (radialBtn) return { element: radialBtn, isRadial: true };
    }

    const directEl = document.elementFromPoint(x, y);
    if (!directEl) return null;

    const closestInteractive = directEl.closest(INTERACTIVE_SELECTOR);
    if (closestInteractive) {
      return { element: closestInteractive, isRadial: false };
    }

    if (!settings.magneticSnap) {
      return { element: directEl, isRadial: false };
    }

    const offsets = [
      [18, 0], [-18, 0], [0, 18], [0, -18],
      [14, 14], [-14, 14], [14, -14], [-14, -14]
    ];
    for (const [dx, dy] of offsets) {
      const neighbor = document.elementFromPoint(x + dx, y + dy);
      const interactive = neighbor?.closest?.(INTERACTIVE_SELECTOR);
      if (interactive) {
        return { element: interactive, isRadial: false };
      }
    }

    return { element: directEl, isRadial: false };
  }

  function updateHoverAndHighlight(x, y) {
    const found = findInteractiveTarget(x, y);
    const targetEl = found?.element || null;

    if (targetEl && !found.isRadial && targetEl.matches?.(INTERACTIVE_SELECTOR)) {
      currentSnapTarget = targetEl;
      const rect = targetEl.getBoundingClientRect();
      if (rect.width > 4 && rect.height > 4 && rect.width < window.innerWidth * 0.9) {
        snapHighlightEl.style.left = `${rect.left - 4}px`;
        snapHighlightEl.style.top = `${rect.top - 4}px`;
        snapHighlightEl.style.width = `${rect.width + 8}px`;
        snapHighlightEl.style.height = `${rect.height + 8}px`;
        snapHighlightEl.classList.add('visible');
      } else {
        snapHighlightEl.classList.remove('visible');
      }
    } else {
      currentSnapTarget = found?.isRadial ? targetEl : null;
      snapHighlightEl.classList.remove('visible');
    }

    if (targetEl && !found?.isRadial) {
      if (targetEl !== lastHoveredElement) {
        if (lastHoveredElement) {
          dispatchMouseEvent(lastHoveredElement, 'mouseout', x, y);
          dispatchMouseEvent(lastHoveredElement, 'mouseleave', x, y);
        }
        dispatchMouseEvent(targetEl, 'mouseover', x, y);
        dispatchMouseEvent(targetEl, 'mouseenter', x, y);
        lastHoveredElement = targetEl;
      }
      dispatchMouseEvent(targetEl, 'pointermove', x, y);
      dispatchMouseEvent(targetEl, 'mousemove', x, y);
    }
  }

  function dispatchMouseEvent(target, type, clientX, clientY, extra = {}) {
    if (!target) return;
    const evtInit = {
      bubbles: type !== 'mouseenter' && type !== 'mouseleave',
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: extra.button || 0,
      buttons: extra.buttons || 0,
      ...extra
    };
    const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new EventCtor(type, evtInit));
  }

  function performClickAt(x, y, isDouble = false) {
    if (radialMenuOpen) {
      const radialEl = shadow.elementFromPoint(x, y);
      const radialBtn = radialEl?.closest?.('[data-radial-action]');
      if (radialBtn) {
        executeRadialAction(radialBtn.dataset.radialAction);
        spawnRipple(x, y, '#06b6d4');
        return;
      } else {
        closeRadialMenu();
      }
    }

    const found = findInteractiveTarget(x, y);
    const target = currentSnapTarget || found?.element || document.elementFromPoint(x, y);
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const clickX = Math.max(rect.left + 2, Math.min(rect.right - 2, x));
    const clickY = Math.max(rect.top + 2, Math.min(rect.bottom - 2, y));

    spawnRipple(clickX, clickY, isDouble ? '#06b6d4' : '#10b981');

    dispatchMouseEvent(target, 'pointerdown', clickX, clickY, { buttons: 1 });
    dispatchMouseEvent(target, 'mousedown', clickX, clickY, { buttons: 1 });
    dispatchMouseEvent(target, 'pointerup', clickX, clickY, { buttons: 0 });
    dispatchMouseEvent(target, 'mouseup', clickX, clickY, { buttons: 0 });

    if (isDouble) {
      dispatchMouseEvent(target, 'dblclick', clickX, clickY);
      showToast('🖱️ Double Click');
      return;
    }

    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    ) {
      target.focus();
    }

    if (typeof target.click === 'function') {
      target.click();
    } else {
      dispatchMouseEvent(target, 'click', clickX, clickY);
    }

    showToast('🖱️ Click');
  }

  function findScrollableContainer(startEl, deltaX, deltaY) {
    let el = startEl;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;

      if (Math.abs(deltaY) >= Math.abs(deltaX)) {
        const canScrollY =
          (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
          el.scrollHeight > el.clientHeight + 2;
        if (canScrollY) {
          const atTop = deltaY < 0 && el.scrollTop <= 0;
          const atBottom =
            deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if (!atTop && !atBottom) return el;
        }
      } else {
        const canScrollX =
          (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
          el.scrollWidth > el.clientWidth + 2;
        if (canScrollX) return el;
      }
      el = el.parentElement;
    }
    return window;
  }

  function performScroll(deltaX, deltaY, x, y) {
    const startEl = document.elementFromPoint(x, y);
    const scrollTarget = findScrollableContainer(startEl, deltaX, deltaY);
    if (scrollTarget === window) {
      window.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    } else {
      scrollTarget.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    }
  }

  function togglePageMedia() {
    const mediaElements = Array.from(document.querySelectorAll('video, audio'));
    if (mediaElements.length > 0) {
      const media =
        mediaElements.find((m) => !m.paused) ||
        mediaElements.sort((a, b) => (b.clientWidth || 0) - (a.clientWidth || 0))[0];
      if (media) {
        if (media.paused) {
          media.play().catch(() => {});
          showToast('▶️ Media Playing');
        } else {
          media.pause();
          showToast('⏸️ Media Paused');
        }
        return;
      }
    }
    showToast('⏯️ No active video/audio on this page');
  }

  function openRadialMenuAt(x, y) {
    const pad = 150;
    radialMenuCenter = {
      x: Math.max(pad, Math.min(window.innerWidth - pad, x)),
      y: Math.max(pad, Math.min(window.innerHeight - pad, y))
    };
    radialMenuEl.style.left = `${radialMenuCenter.x}px`;
    radialMenuEl.style.top = `${radialMenuCenter.y}px`;
    radialMenuEl.classList.add('visible');
    radialMenuOpen = true;
    showToast('🎯 Quick Action Wheel (Pinch an action)');
  }

  function closeRadialMenu() {
    radialMenuEl.classList.remove('visible');
    radialMenuOpen = false;
  }

  function executeRadialAction(actionId) {
    closeRadialMenu();
    switch (actionId) {
      case 'BACK':
        showToast('← History Back');
        window.history.back();
        break;
      case 'FORWARD':
        showToast('History Forward →');
        window.history.forward();
        break;
      case 'TAB_PREV':
        sendCameraCommand('PAUSE_CAMERA');
        safeSendMessage({
          type: 'BROWSER_ACTION',
          action: 'TAB_PREV',
          lastCursor: { x: normX, y: normY }
        });
        break;
      case 'TAB_NEXT':
        sendCameraCommand('PAUSE_CAMERA');
        safeSendMessage({
          type: 'BROWSER_ACTION',
          action: 'TAB_NEXT',
          lastCursor: { x: normX, y: normY }
        });
        break;
      case 'PLAY_PAUSE':
        togglePageMedia();
        break;
      case 'NEW_TAB':
        showToast('➕ Opening New Tab');
        sendCameraCommand('PAUSE_CAMERA');
        safeSendMessage({
          type: 'BROWSER_ACTION',
          action: 'NEW_TAB',
          lastCursor: { x: normX, y: normY }
        });
        break;
      case 'RELOAD':
        showToast('🔄 Reloading Page');
        window.location.reload();
        break;
      case 'SCROLL_TOP':
        showToast('⏫ Scrolled to Top');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      default:
        break;
    }
  }

  function handleHandFrame(frame) {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    if (!settings.enabled || !frame.detected) {
      setPointerIdle();
      return;
    }

    mountHost();
    setCursorFromNormalized(frame.cursor.x, frame.cursor.y);

    const now = performance.now();
    if (now - lastSyncTime > 250) {
      lastSyncTime = now;
      safeSendMessage({
        type: 'SYNC_CURSOR_POS',
        cursor: { x: normX, y: normY }
      });
    }

    trailPoints.push({ x: screenX, y: screenY, t: now });
    drawTrail();

    cursorEl.classList.remove('idle', 'disabled');
    cursorEl.classList.toggle('pinching', Boolean(frame.isPinching));
    cursorEl.classList.toggle('dragging', Boolean(frame.isDragging));
    cursorEl.classList.toggle('scrolling', Boolean(frame.isScrolling));
    cursorEl.classList.toggle('clutch', frame.posture === 'CLUTCH');

    cursorLabelEl.textContent = frame.posture;

    const prog = Math.max(frame.dwellProgress || 0, frame.fistProgress || 0);
    progressCircle.style.strokeDashoffset = `${113 * (1 - prog)}`;

    if (!frame.isScrolling) {
      updateHoverAndHighlight(screenX, screenY);
    }

    if (Array.isArray(frame.events)) {
      for (const evt of frame.events) {
        switch (evt.type) {
          case 'CLICK':
          case 'DWELL_CLICK': {
            performClickAt(evt.x * window.innerWidth, evt.y * window.innerHeight, false);
            break;
          }
          case 'DOUBLE_CLICK': {
            performClickAt(evt.x * window.innerWidth, evt.y * window.innerHeight, true);
            break;
          }
          case 'RIGHT_CLICK':
          case 'TOGGLE_RADIAL_MENU': {
            const cx = evt.x * window.innerWidth;
            const cy = evt.y * window.innerHeight;
            const target = document.elementFromPoint(cx, cy);
            if (target && evt.type === 'RIGHT_CLICK') {
              dispatchMouseEvent(target, 'contextmenu', cx, cy, { button: 2, buttons: 2 });
            }
            if (radialMenuOpen) closeRadialMenu();
            else openRadialMenuAt(cx, cy);
            spawnRipple(cx, cy, '#a855f7');
            break;
          }
          case 'DRAG_START': {
            const cx = evt.x * window.innerWidth;
            const cy = evt.y * window.innerHeight;
            dragTarget = currentSnapTarget || document.elementFromPoint(cx, cy);
            if (dragTarget) {
              dispatchMouseEvent(dragTarget, 'pointerdown', cx, cy, { buttons: 1 });
              dispatchMouseEvent(dragTarget, 'mousedown', cx, cy, { buttons: 1 });
            }
            showToast('✊ Dragging Started');
            break;
          }
          case 'DRAG_MOVE': {
            const cx = evt.x * window.innerWidth;
            const cy = evt.y * window.innerHeight;
            const target = dragTarget || document.elementFromPoint(cx, cy);
            if (target) {
              if (target.tagName === 'INPUT' && target.type === 'range') {
                const rect = target.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (cx - rect.left) / Math.max(1, rect.width)));
                const min = parseFloat(target.min || '0');
                const max = parseFloat(target.max || '100');
                target.value = String(min + ratio * (max - min));
                target.dispatchEvent(new Event('input', { bubbles: true }));
              }
              dispatchMouseEvent(target, 'pointermove', cx, cy, { buttons: 1 });
              dispatchMouseEvent(target, 'mousemove', cx, cy, { buttons: 1 });
            }
            break;
          }
          case 'DRAG_END': {
            const cx = evt.x * window.innerWidth;
            const cy = evt.y * window.innerHeight;
            const target = dragTarget || document.elementFromPoint(cx, cy);
            if (target) {
              dispatchMouseEvent(target, 'pointerup', cx, cy, { buttons: 0 });
              dispatchMouseEvent(target, 'mouseup', cx, cy, { buttons: 0 });
              if (target.tagName === 'INPUT' && target.type === 'range') {
                target.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            dragTarget = null;
            showToast('🖐️ Drag Released');
            break;
          }
          case 'SCROLL_START': {
            scrollAnchorEl.style.left = `${evt.anchorX * window.innerWidth}px`;
            scrollAnchorEl.style.top = `${evt.anchorY * window.innerHeight}px`;
            scrollAnchorEl.classList.add('visible');
            break;
          }
          case 'SCROLL_MOVE': {
            performScroll(
              evt.deltaX,
              evt.deltaY,
              evt.x * window.innerWidth,
              evt.y * window.innerHeight
            );
            break;
          }
          case 'SCROLL_END': {
            scrollAnchorEl.classList.remove('visible');
            break;
          }
          case 'TAB_NEXT': {
            showToast('⏭ Switching to Next Tab...');
            sendCameraCommand('PAUSE_CAMERA');
            safeSendMessage({
              type: 'BROWSER_ACTION',
              action: 'TAB_NEXT',
              lastCursor: { x: normX, y: normY }
            });
            break;
          }
          case 'TAB_PREV': {
            showToast('⏮ Switching to Previous Tab...');
            sendCameraCommand('PAUSE_CAMERA');
            safeSendMessage({
              type: 'BROWSER_ACTION',
              action: 'TAB_PREV',
              lastCursor: { x: normX, y: normY }
            });
            break;
          }
          case 'ZOOM_IN':
          case 'ZOOM_OUT': {
            safeSendMessage(
              { type: 'BROWSER_ACTION', action: evt.type },
              (res) => {
                if (res?.zoom) showToast(`🔍 Page Zoom: ${res.zoom}%`);
              }
            );
            break;
          }
          case 'MEDIA_TOGGLE': {
            togglePageMedia();
            break;
          }
          default:
            break;
        }
      }
    }
  }
})();
