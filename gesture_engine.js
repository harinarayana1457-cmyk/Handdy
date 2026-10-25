/**
 * Handdy — Scale-Invariant Hand Gesture & Air-Mouse Engine
 * Uses 1-Euro adaptive filtering, palm-size normalization, and pre-pinch cursor stabilization.
 */

export class LowPassFilter {
  constructor(alpha, initVal = 0) {
    this.y = initVal;
    this.s = initVal;
    this.initialized = false;
    this.setAlpha(alpha);
  }

  setAlpha(alpha) {
    this.alpha = Math.max(0.0001, Math.min(1.0, alpha));
  }

  filter(value) {
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
    } else {
      this.s = this.alpha * value + (1.0 - this.alpha) * this.s;
    }
    this.y = value;
    return this.s;
  }

  lastValue() {
    return this.y;
  }
}

export class OneEuroFilter {
  constructor(freq = 60, minCutoff = 1.1, beta = 0.04, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPassFilter(this.alpha(minCutoff));
    this.dx = new LowPassFilter(this.alpha(dCutoff));
    this.lastTime = null;
  }

  alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(value, timestamp = performance.now()) {
    if (this.lastTime !== null && timestamp > this.lastTime) {
      const dt = (timestamp - this.lastTime) / 1000.0;
      if (dt > 0 && dt < 1.0) {
        this.freq = 1.0 / dt;
      }
    }
    this.lastTime = timestamp;

    const dValue = !this.x.initialized
      ? 0.0
      : (value - this.x.lastValue()) * this.freq;
    this.dx.setAlpha(this.alpha(this.dCutoff));
    const edValue = this.dx.filter(dValue);

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    this.x.setAlpha(this.alpha(cutoff));
    return this.x.filter(value);
  }
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivity: 1.35,       // Active region multiplier (higher = less hand movement needed)
  smoothing: 0.65,         // 0.1 (raw/fast) to 0.95 (ultra smooth)
  pinchThreshold: 0.28,    // Normalized by palm size
  scrollSpeed: 1.25,       // Scroll speed multiplier
  invertScroll: false,     // Natural vs standard scroll
  mirrorCamera: true,      // Mirror webcam horizontally
  magneticSnap: true,      // Snap cursor gently to nearby buttons/links
  dwellClick: false,       // Auto-click when hovering steady on interactive elements
  dwellTimeMs: 1000,       // Dwell duration in ms
  showCameraHud: true,     // Show mini PiP camera in corner of page
  showSkeleton: true,      // Draw 21 hand landmarks on camera preview
  hudPosition: 'bottom-right'
};

export class GestureEngine {
  constructor(customSettings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...customSettings };
    this.updateFilterParams();

    // State tracking
    this.cursorX = 0.5;
    this.cursorY = 0.5;
    this.lockedCursorX = 0.5;
    this.lockedCursorY = 0.5;

    // Pinch state (Index + Thumb)
    this.isPinching = false;
    this.pinchStartTime = 0;
    this.isDragging = false;
    this.lastClickTime = 0;

    // Right click pinch state (Middle + Thumb)
    this.isMiddlePinching = false;
    this.lastRightClickTime = 0;

    // Scroll state (Peace sign: Index + Middle up)
    this.isScrolling = false;
    this.scrollAnchorX = 0.5;
    this.scrollAnchorY = 0.5;
    this.lastScrollX = 0.5;
    this.lastScrollY = 0.5;

    // 3-Finger / Open-Palm Tab Swipe state
    this.swipeHistory = [];
    this.lastTabSwipeTime = 0;
    this.threeFingerAnchorX = null;

    // Fist / Clutch & Media toggle state
    this.fistStartTime = 0;
    this.fistMediaTriggered = false;

    // Rock sign (Radial Menu) state
    this.rockStartTime = 0;
    this.rockTriggered = false;

    // Shaka sign (Zoom) state
    this.zoomAnchorY = null;
    this.lastZoomTime = 0;

    // Dwell click state
    this.dwellAnchorX = 0.5;
    this.dwellAnchorY = 0.5;
    this.dwellStartTime = 0;
    this.dwellTriggered = false;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.updateFilterParams();
  }

  updateFilterParams() {
    // Convert smoothing [0.1 .. 0.95] to 1-Euro minCutoff & beta
    const s = Math.max(0.05, Math.min(0.95, this.settings.smoothing ?? 0.65));
    const minCutoff = 2.4 - s * 2.1; // 0.3 to 2.2
    const beta = 0.08 - s * 0.05;    // 0.03 to 0.075
    this.filterX = new OneEuroFilter(60, minCutoff, beta, 1.0);
    this.filterY = new OneEuroFilter(60, minCutoff, beta, 1.0);
  }

  static dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz * 0.25);
  }

  static dist2D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Process 21 MediaPipe hand landmarks and return high-level cursor & gesture events.
   * @param {Array<{x:number, y:number, z:number}>} landmarks
   * @param {number} now timestamp in ms
   */
  processLandmarks(landmarks, now = performance.now()) {
    if (!landmarks || landmarks.length < 21) {
      return { detected: false, events: [] };
    }

    const events = [];

    // 1. Compute scale-invariant reference length (Wrist [0] to Middle MCP [9])
    const wrist = landmarks[0];
    const indexMcp = landmarks[5];
    const middleMcp = landmarks[9];
    const ringMcp = landmarks[13];
    const pinkyMcp = landmarks[17];

    const palmSize = Math.max(0.04, GestureEngine.dist2D(wrist, middleMcp));

    // Finger tips & PIP joints
    const thumbTip = landmarks[4];
    const thumbIp = landmarks[3];
    const indexPip = landmarks[6];
    const indexTip = landmarks[8];
    const middlePip = landmarks[10];
    const middleTip = landmarks[12];
    const ringPip = landmarks[14];
    const ringTip = landmarks[16];
    const pinkyPip = landmarks[18];
    const pinkyTip = landmarks[20];

    // 2. Determine which fingers are extended (scale-invariant wrist-to-tip vs wrist-to-pip)
    const isExtended = (tip, pip, mcp, ratio = 1.18) => {
      const tipDist = GestureEngine.dist2D(wrist, tip);
      const pipDist = GestureEngine.dist2D(wrist, pip);
      const mcpDist = GestureEngine.dist2D(wrist, mcp);
      return tipDist > pipDist * 1.06 && tipDist > mcpDist * ratio;
    };

    const indexUp = isExtended(indexTip, indexPip, indexMcp, 1.22);
    const middleUp = isExtended(middleTip, middlePip, middleMcp, 1.22);
    const ringUp = isExtended(ringTip, ringPip, ringMcp, 1.18);
    const pinkyUp = isExtended(pinkyTip, pinkyPip, pinkyMcp, 1.15);

    // Thumb extended outward from palm center
    const palmCenter = {
      x: (wrist.x + indexMcp.x + pinkyMcp.x) / 3,
      y: (wrist.y + indexMcp.y + pinkyMcp.y) / 3
    };
    const thumbOut =
      GestureEngine.dist2D(thumbTip, pinkyMcp) > palmSize * 1.05 &&
      GestureEngine.dist2D(thumbTip, indexMcp) > palmSize * 0.52;

    // 3. Normalized pinch distances
    const indexPinchDist = GestureEngine.dist2D(thumbTip, indexTip) / palmSize;
    const middlePinchDist = GestureEngine.dist2D(thumbTip, middleTip) / palmSize;

    const pinchEnter = this.settings.pinchThreshold || 0.28;
    const pinchExit = pinchEnter * 1.32;

    // 4. Identify Posture / Mode
    const allCurled = !indexUp && !middleUp && !ringUp && !pinkyUp && indexPinchDist > pinchEnter;
    const isPeaceScroll =
      indexUp &&
      middleUp &&
      !ringUp &&
      !pinkyUp &&
      indexPinchDist > pinchExit &&
      GestureEngine.dist2D(indexTip, middleTip) / palmSize < 0.65;

    const isThreeFingers = indexUp && middleUp && ringUp && !pinkyUp && indexPinchDist > pinchExit;
    const isOpenPalm = indexUp && middleUp && ringUp && pinkyUp && thumbOut;
    const isRockSign = indexUp && !middleUp && !ringUp && pinkyUp && indexPinchDist > pinchExit;
    const isShakaSign = thumbOut && !indexUp && !middleUp && !ringUp && pinkyUp;

    // 5. Compute Stabilized Pointer Position
    // Use blended knuckle anchor (Index MCP [5] + Index Tip [8] weighted) so pinching doesn't pull the cursor down!
    const rawHandX = indexMcp.x * 0.65 + indexTip.x * 0.35;
    const rawHandY = indexMcp.y * 0.65 + indexTip.y * 0.35;

    const mirroredX = this.settings.mirrorCamera ? 1.0 - rawHandX : rawHandX;
    const rawY = rawHandY;

    // Map active region based on sensitivity (e.g., sensitivity 1.35 -> margin ~0.18)
    const sens = Math.max(0.6, Math.min(2.5, this.settings.sensitivity || 1.35));
    const span = Math.min(0.92, Math.max(0.32, 0.85 / sens));
    const minX = (1.0 - span) / 2;
    const minY = (1.0 - span) / 2;

    const mappedX = Math.max(0, Math.min(1, (mirroredX - minX) / span));
    const mappedY = Math.max(0, Math.min(1, (rawY - minY) / span));

    const filteredX = this.filterX.filter(mappedX, now);
    const filteredY = this.filterY.filter(mappedY, now);

    // Pre-pinch cursor stabilization: if user is closing thumb+index to click, dampen movement to prevent slip
    let prePinchFreeze = 1.0;
    if (!this.isDragging && indexPinchDist < pinchExit * 1.25) {
      const ratio = Math.max(0, (indexPinchDist - pinchEnter) / (pinchExit * 1.25 - pinchEnter));
      prePinchFreeze = ratio * ratio * 0.35;
    }

    let posture = 'POINT';

    // --- CLUTCH / FIST MODE (Pause cursor + Hold for Media Play/Pause) ---
    if (allCurled && !this.isPinching && !this.isDragging) {
      posture = 'CLUTCH';
      if (this.fistStartTime === 0) {
        this.fistStartTime = now;
        this.fistMediaTriggered = false;
      } else if (!this.fistMediaTriggered && now - this.fistStartTime > 1100) {
        this.fistMediaTriggered = true;
        events.push({ type: 'MEDIA_TOGGLE' });
      }
    } else {
      this.fistStartTime = 0;
      this.fistMediaTriggered = false;
    }

    // Update cursor coordinates unless in CLUTCH or SCROLL or 3-FINGER TAB mode
    if (posture !== 'CLUTCH' && !isPeaceScroll && !isThreeFingers && !isShakaSign) {
      this.cursorX = this.cursorX + (filteredX - this.cursorX) * prePinchFreeze;
      this.cursorY = this.cursorY + (filteredY - this.cursorY) * prePinchFreeze;
    }

    // --- ROCK SIGN (🤘 Index + Pinky) -> Toggle Quick Action Radial Menu ---
    if (isRockSign && !this.isPinching) {
      posture = 'RADIAL_MENU';
      if (this.rockStartTime === 0) {
        this.rockStartTime = now;
      } else if (!this.rockTriggered && now - this.rockStartTime > 380) {
        this.rockTriggered = true;
        events.push({
          type: 'TOGGLE_RADIAL_MENU',
          x: this.cursorX,
          y: this.cursorY
        });
      }
    } else {
      this.rockStartTime = 0;
      this.rockTriggered = false;
    }

    // --- SHAKA SIGN (🤙 Thumb + Pinky) -> Zoom In / Out ---
    if (isShakaSign && !this.isPinching) {
      posture = 'ZOOM';
      if (this.zoomAnchorY === null) {
        this.zoomAnchorY = filteredY;
      } else {
        const dy = this.zoomAnchorY - filteredY;
        if (Math.abs(dy) > 0.08 && now - this.lastZoomTime > 260) {
          this.lastZoomTime = now;
          this.zoomAnchorY = filteredY;
          events.push({
            type: dy > 0 ? 'ZOOM_IN' : 'ZOOM_OUT',
            delta: dy
          });
        }
      }
    } else {
      this.zoomAnchorY = null;
    }

    // --- THREE-FINGER / OPEN PALM SWIPE -> Switch Tabs ---
    if (isThreeFingers || isOpenPalm) {
      if (isThreeFingers) posture = 'TAB_SWITCH';

      // Track horizontal velocity for swipe detection
      this.swipeHistory.push({ x: filteredX, y: filteredY, t: now });
      this.swipeHistory = this.swipeHistory.filter((p) => now - p.t < 260);

      if (this.swipeHistory.length >= 3 && now - this.lastTabSwipeTime > 650) {
        const first = this.swipeHistory[0];
        const last = this.swipeHistory[this.swipeHistory.length - 1];
        const dx = last.x - first.x;
        const dy = Math.abs(last.y - first.y);
        const dt = Math.max(1, last.t - first.t);
        const vx = dx / dt; // normalized units per ms

        // Require predominantly horizontal motion
        const thresholdDx = isThreeFingers ? 0.14 : 0.22;
        const thresholdVx = isThreeFingers ? 0.00075 : 0.0011;

        if (Math.abs(dx) > thresholdDx && Math.abs(vx) > thresholdVx && dy < Math.abs(dx) * 0.65) {
          this.lastTabSwipeTime = now;
          this.swipeHistory = [];
          events.push({
            type: dx > 0 ? 'TAB_NEXT' : 'TAB_PREV',
            velocity: vx
          });
        }
      }
    } else {
      this.swipeHistory = [];
    }

    // --- PEACE SIGN (✌️ Index + Middle Extended) -> Smooth Scroll ---
    if (isPeaceScroll && !this.isPinching && !this.isDragging) {
      posture = 'SCROLL';
      if (!this.isScrolling) {
        this.isScrolling = true;
        this.scrollAnchorX = filteredX;
        this.scrollAnchorY = filteredY;
        this.lastScrollX = filteredX;
        this.lastScrollY = filteredY;
        events.push({
          type: 'SCROLL_START',
          anchorX: this.cursorX,
          anchorY: this.cursorY
        });
      } else {
        // Hybrid Delta + Joystick Scroll for ultra-responsive feel
        const frameDy = filteredY - this.lastScrollY;
        const frameDx = filteredX - this.lastScrollX;
        const offsetY = filteredY - this.scrollAnchorY;
        const offsetX = filteredX - this.scrollAnchorX;

        this.lastScrollX = filteredX;
        this.lastScrollY = filteredY;

        const dir = this.settings.invertScroll ? -1 : 1;
        const speed = (this.settings.scrollSpeed || 1.25) * 18;

        // Deadzone around anchor for joystick component
        const joyY = Math.abs(offsetY) > 0.035 ? (offsetY - Math.sign(offsetY) * 0.035) * 28 : 0;
        const joyX = Math.abs(offsetX) > 0.05 ? (offsetX - Math.sign(offsetX) * 0.05) * 20 : 0;

        const scrollDeltaY = (frameDy * 1200 + joyY) * dir * (this.settings.scrollSpeed || 1.25);
        const scrollDeltaX = (frameDx * 900 + joyX) * dir * (this.settings.scrollSpeed || 1.25);

        if (Math.abs(scrollDeltaY) > 0.6 || Math.abs(scrollDeltaX) > 0.6) {
          events.push({
            type: 'SCROLL_MOVE',
            deltaX: Math.abs(scrollDeltaY) > Math.abs(scrollDeltaX) * 1.8 ? 0 : scrollDeltaX,
            deltaY: scrollDeltaY,
            x: this.cursorX,
            y: this.cursorY,
            speed
          });
        }
      }
    } else if (this.isScrolling) {
      this.isScrolling = false;
      events.push({ type: 'SCROLL_END' });
    }

    // --- LEFT CLICK / DOUBLE CLICK / DRAG (Thumb [4] + Index [8] Pinch) ---
    if (posture !== 'SCROLL' && posture !== 'TAB_SWITCH' && posture !== 'ZOOM') {
      if (!this.isPinching && indexPinchDist < pinchEnter) {
        this.isPinching = true;
        this.pinchStartTime = now;
        this.lockedCursorX = this.cursorX;
        this.lockedCursorY = this.cursorY;
        posture = 'PINCH';

        events.push({
          type: 'PINCH_DOWN',
          x: this.lockedCursorX,
          y: this.lockedCursorY
        });
      } else if (this.isPinching && indexPinchDist < pinchExit) {
        const heldMs = now - this.pinchStartTime;
        if (!this.isDragging && heldMs > 340) {
          this.isDragging = true;
          events.push({
            type: 'DRAG_START',
            x: this.lockedCursorX,
            y: this.lockedCursorY
          });
        }

        if (this.isDragging) {
          posture = 'DRAG';
          // Allow smooth cursor movement during drag
          this.cursorX = filteredX;
          this.cursorY = filteredY;
          events.push({
            type: 'DRAG_MOVE',
            x: this.cursorX,
            y: this.cursorY
          });
        } else {
          posture = 'PINCH';
        }
      } else if (this.isPinching && indexPinchDist >= pinchExit) {
        const heldMs = now - this.pinchStartTime;
        this.isPinching = false;

        if (this.isDragging) {
          this.isDragging = false;
          events.push({
            type: 'DRAG_END',
            x: this.cursorX,
            y: this.cursorY
          });
        } else if (heldMs <= 420) {
          // Quick pinch -> Click or Double Click
          if (now - this.lastClickTime < 440) {
            this.lastClickTime = 0;
            events.push({
              type: 'DOUBLE_CLICK',
              x: this.lockedCursorX,
              y: this.lockedCursorY
            });
          } else {
            this.lastClickTime = now;
            events.push({
              type: 'CLICK',
              x: this.lockedCursorX,
              y: this.lockedCursorY
            });
          }
        }
        events.push({
          type: 'PINCH_UP',
          x: this.cursorX,
          y: this.cursorY
        });
      }
    }

    // --- RIGHT CLICK (Thumb [4] + Middle Finger [12] Pinch while Index is Up) ---
    if (!this.isPinching && !this.isDragging && indexUp) {
      if (!this.isMiddlePinching && middlePinchDist < pinchEnter * 0.95) {
        this.isMiddlePinching = true;
        if (now - this.lastRightClickTime > 600) {
          this.lastRightClickTime = now;
          posture = 'RIGHT_CLICK';
          events.push({
            type: 'RIGHT_CLICK',
            x: this.cursorX,
            y: this.cursorY
          });
        }
      } else if (this.isMiddlePinching && middlePinchDist > pinchExit) {
        this.isMiddlePinching = false;
      }
    }

    // --- DWELL CLICK (Optional hands-free hover click) ---
    let dwellProgress = 0;
    if (this.settings.dwellClick && posture === 'POINT' && !this.isPinching) {
      const moveDist = Math.hypot(this.cursorX - this.dwellAnchorX, this.cursorY - this.dwellAnchorY);
      if (moveDist > 0.022) {
        this.dwellAnchorX = this.cursorX;
        this.dwellAnchorY = this.cursorY;
        this.dwellStartTime = now;
        this.dwellTriggered = false;
      } else {
        const elapsed = now - this.dwellStartTime;
        const targetMs = this.settings.dwellTimeMs || 1000;
        dwellProgress = Math.min(1, elapsed / targetMs);
        if (elapsed >= targetMs && !this.dwellTriggered) {
          this.dwellTriggered = true;
          events.push({
            type: 'DWELL_CLICK',
            x: this.cursorX,
            y: this.cursorY
          });
        }
      }
    } else {
      this.dwellStartTime = now;
      this.dwellTriggered = false;
    }

    // Fist hold progress for media play/pause
    const fistProgress =
      posture === 'CLUTCH' && this.fistStartTime > 0 && !this.fistMediaTriggered
        ? Math.min(1, (now - this.fistStartTime) / 1100)
        : 0;

    return {
      detected: true,
      posture,
      cursor: {
        x: this.cursorX,
        y: this.cursorY
      },
      pinchRatio: indexPinchDist / pinchEnter,
      isPinching: this.isPinching,
      isDragging: this.isDragging,
      isScrolling: this.isScrolling,
      scrollAnchor: {
        x: this.scrollAnchorX,
        y: this.scrollAnchorY
      },
      dwellProgress,
      fistProgress,
      events
    };
  }
}
