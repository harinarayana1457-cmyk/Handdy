/**
 * Handdy — Popup Controller (popup.js)
 */

import { DEFAULT_SETTINGS } from './gesture_engine.js';

const enabledToggle = document.getElementById('enabledToggle');
const sensitivityInput = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const smoothingInput = document.getElementById('smoothing');
const smoothingVal = document.getElementById('smoothingVal');
const scrollSpeedInput = document.getElementById('scrollSpeed');
const scrollSpeedVal = document.getElementById('scrollSpeedVal');
const pinchThresholdInput = document.getElementById('pinchThreshold');
const pinchThresholdVal = document.getElementById('pinchThresholdVal');

const magneticSnapInput = document.getElementById('magneticSnap');
const dwellClickInput = document.getElementById('dwellClick');
const showCameraHudInput = document.getElementById('showCameraHud');
const showSkeletonInput = document.getElementById('showSkeleton');
const invertScrollInput = document.getElementById('invertScroll');

const openSidePanelBtn = document.getElementById('openSidePanelBtn');
const openSandboxBtn = document.getElementById('openSandboxBtn');
const grantCamBtn = document.getElementById('grantCamBtn');
const resetBtn = document.getElementById('resetBtn');

let currentSettings = { ...DEFAULT_SETTINGS };

function renderSettings(s) {
  enabledToggle.checked = Boolean(s.enabled);
  sensitivityInput.value = s.sensitivity;
  sensitivityVal.textContent = `${Number(s.sensitivity).toFixed(2)}x`;

  smoothingInput.value = s.smoothing;
  smoothingVal.textContent = `${Math.round(Number(s.smoothing) * 100)}%`;

  scrollSpeedInput.value = s.scrollSpeed;
  scrollSpeedVal.textContent = `${Number(s.scrollSpeed).toFixed(2)}x`;

  pinchThresholdInput.value = s.pinchThreshold;
  pinchThresholdVal.textContent = Number(s.pinchThreshold).toFixed(2);

  magneticSnapInput.checked = Boolean(s.magneticSnap);
  dwellClickInput.checked = Boolean(s.dwellClick);
  showCameraHudInput.checked = Boolean(s.showCameraHud);
  showSkeletonInput.checked = Boolean(s.showSkeleton);
  invertScrollInput.checked = Boolean(s.invertScroll);
}

async function saveSettings(patch) {
  currentSettings = { ...currentSettings, ...patch };
  renderSettings(currentSettings);
  await chrome.storage.local.set({ settings: currentSettings });
}

chrome.storage.local.get('settings').then((data) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  renderSettings(currentSettings);
});

enabledToggle.addEventListener('change', () => saveSettings({ enabled: enabledToggle.checked }));
sensitivityInput.addEventListener('input', () => saveSettings({ sensitivity: parseFloat(sensitivityInput.value) }));
smoothingInput.addEventListener('input', () => saveSettings({ smoothing: parseFloat(smoothingInput.value) }));
scrollSpeedInput.addEventListener('input', () => saveSettings({ scrollSpeed: parseFloat(scrollSpeedInput.value) }));
pinchThresholdInput.addEventListener('input', () => saveSettings({ pinchThreshold: parseFloat(pinchThresholdInput.value) }));

magneticSnapInput.addEventListener('change', () => saveSettings({ magneticSnap: magneticSnapInput.checked }));
dwellClickInput.addEventListener('change', () => saveSettings({ dwellClick: dwellClickInput.checked }));
showCameraHudInput.addEventListener('change', () => saveSettings({ showCameraHud: showCameraHudInput.checked }));
showSkeletonInput.addEventListener('change', () => saveSettings({ showSkeleton: showSkeletonInput.checked }));
invertScrollInput.addEventListener('change', () => saveSettings({ invertScroll: invertScrollInput.checked }));

openSidePanelBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (chrome.sidePanel && chrome.sidePanel.open && tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } else {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
  }
});

openSandboxBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  window.close();
});

grantCamBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  window.close();
});

resetBtn.addEventListener('click', () => {
  saveSettings({ ...DEFAULT_SETTINGS });
});
