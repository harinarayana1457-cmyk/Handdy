/**
 * HandFlow — Background Service Worker (background.js)
 * Coordinates single-camera ownership across SidePanel, Permission Tab, and Offscreen Document
 * so Windows webcams never conflict and the Live Pointer runs uninterrupted on ANY Chrome tab.
 */

const DEFAULT_SETTINGS = {
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

let cachedSettings = { ...DEFAULT_SETTINGS };
let offscreenPort = null;
let offscreenTracking = false;
let sidePanelPort = null;
let permissionPort = null;
let activeTabId = null;
let activeWindowId = null;

function isCentralTrackerActive() {
  return Boolean(sidePanelPort || permissionPort || offscreenTracking);
}

async function bootExtension() {
  const stored = await chrome.storage.local.get(['settings', 'cameraPermissionGranted']);
  cachedSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  updateBadge(cachedSettings.enabled);

  await updateActiveTabReference();
  await injectIntoAllExistingTabs();

  if (cachedSettings.enabled) {
    await ensureOffscreenDocument();
  }
}

bootExtension();

chrome.runtime.onStartup.addListener(() => {
  bootExtension();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(['settings', 'cameraPermissionGranted']);
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await bootExtension();

  if (details.reason === 'install' || !stored.cameraPermissionGranted) {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  }
});

async function updateActiveTabReference() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
      activeWindowId = tab.windowId;
    }
  } catch (_) {}
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabId = activeInfo.tabId;
  activeWindowId = activeInfo.windowId;
  await ensureContentScriptInTab(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  activeWindowId = windowId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id) {
      activeTabId = tab.id;
      await ensureContentScriptInTab(tab.id);
    }
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'loading' || changeInfo.status === 'complete') && tab?.active) {
    activeTabId = tabId;
    await ensureContentScriptInTab(tabId);
  }
});

function isInjectableUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('file://')
  );
}

async function ensureContentScriptInTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isInjectableUrl(tab.url)) return;

    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING_HANDFLOW' }).catch(() => null);
    if (response?.alive) return;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (_) {}
}

async function injectIntoAllExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && isInjectableUrl(tab.url)) {
        ensureContentScriptInTab(tab.id);
      }
    }
  } catch (_) {}
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return;
  try {
    const existingContexts = await chrome.runtime.getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts && existingContexts.length > 0) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Run continuous hand gesture pointer tracking across all browser tabs'
    });
  } catch (_) {}
}

function coordinateTrackers() {
  if (!cachedSettings.enabled) {
    offscreenPort?.postMessage({ type: 'PAUSE_OFFSCREEN' });
    return;
  }
  // If Side Panel or Permission Tab is actively holding the camera, pause Offscreen so Windows webcam isn't locked twice
  if (sidePanelPort || permissionPort) {
    offscreenPort?.postMessage({ type: 'PAUSE_OFFSCREEN' });
  } else {
    offscreenPort?.postMessage({ type: 'RESUME_OFFSCREEN' });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    updateBadge(cachedSettings.enabled);

    offscreenPort?.postMessage({ type: 'UPDATE_SETTINGS', settings: cachedSettings });
    sidePanelPort?.postMessage({ type: 'UPDATE_SETTINGS', settings: cachedSettings });
    permissionPort?.postMessage({ type: 'UPDATE_SETTINGS', settings: cachedSettings });

    if (cachedSettings.enabled) {
      ensureOffscreenDocument();
    }
    coordinateTrackers();

    broadcastToTabs({
      type: 'SETTINGS_UPDATED',
      settings: cachedSettings,
      centralTrackerActive: isCentralTrackerActive()
    });
  }
});

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'LIVE' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({
    color: enabled ? '#10b981' : '#64748b'
  });
}

async function broadcastToTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && isInjectableUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch (_) {}
}

async function forwardFrameToActiveTab(msg) {
  if (!cachedSettings.enabled) return;
  if (!activeTabId) {
    await updateActiveTabReference();
  }
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(async () => {
      await updateActiveTabReference();
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
      }
    });
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-hand-tracking') {
    const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get('settings');
    const updated = { ...settings, enabled: !settings.enabled };
    await chrome.storage.local.set({ settings: updated });
  }
});

// Coordinate persistent ports from Offscreen, SidePanel, and Permission Tab
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'handflow-offscreen') {
    offscreenPort = port;
    port.postMessage({ type: 'UPDATE_SETTINGS', settings: cachedSettings });
    coordinateTrackers();

    port.onMessage.addListener((msg) => {
      if (msg.type === 'OFFSCREEN_STATUS') {
        offscreenTracking = msg.status === 'TRACKING';
        broadcastToTabs({
          type: 'CENTRAL_TRACKER_STATUS',
          active: isCentralTrackerActive(),
          status: msg.status
        });
      } else if (msg.type === 'HAND_FRAME' || msg.type === 'HAND_LOST') {
        if (!sidePanelPort && !permissionPort) {
          offscreenTracking = true;
          forwardFrameToActiveTab(msg);
        }
      } else if (msg.type === 'BROWSER_ACTION') {
        if (!sidePanelPort && !permissionPort) {
          handleBrowserAction(msg.action, msg.payload);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      offscreenPort = null;
      offscreenTracking = false;
      broadcastToTabs({
        type: 'CENTRAL_TRACKER_STATUS',
        active: isCentralTrackerActive()
      });
    });
  } else if (port.name === 'handflow-sidepanel') {
    sidePanelPort = port;
    coordinateTrackers();
    broadcastToTabs({ type: 'CENTRAL_TRACKER_STATUS', active: true });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'HAND_FRAME' || msg.type === 'HAND_LOST') {
        forwardFrameToActiveTab(msg);
      } else if (msg.type === 'BROWSER_ACTION') {
        handleBrowserAction(msg.action, msg.payload);
      }
    });

    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
      coordinateTrackers();
      broadcastToTabs({
        type: 'CENTRAL_TRACKER_STATUS',
        active: isCentralTrackerActive()
      });
    });
  } else if (port.name === 'handflow-permission-tracker') {
    permissionPort = port;
    coordinateTrackers();
    broadcastToTabs({ type: 'CENTRAL_TRACKER_STATUS', active: true });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'HAND_FRAME' || msg.type === 'HAND_LOST') {
        if (!sidePanelPort) {
          forwardFrameToActiveTab(msg);
        }
      } else if (msg.type === 'BROWSER_ACTION') {
        if (!sidePanelPort) {
          handleBrowserAction(msg.action, msg.payload);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      permissionPort = null;
      coordinateTrackers();
      broadcastToTabs({
        type: 'CENTRAL_TRACKER_STATUS',
        active: isCentralTrackerActive()
      });
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'GET_STATUS': {
      chrome.storage.local.get(['settings', 'cameraPermissionGranted']).then((data) => {
        sendResponse({
          settings: data.settings || DEFAULT_SETTINGS,
          cameraPermissionGranted: Boolean(data.cameraPermissionGranted),
          centralTrackerActive: isCentralTrackerActive()
        });
      });
      return true;
    }

    case 'CAMERA_PERMISSION_GRANTED': {
      chrome.storage.local.set({ cameraPermissionGranted: true }).then(async () => {
        await ensureOffscreenDocument();
        coordinateTrackers();
        broadcastToTabs({ type: 'CAMERA_PERMISSION_READY' });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'OPEN_PERMISSION_PAGE': {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
      sendResponse({ ok: true });
      return false;
    }

    case 'OPEN_SIDE_PANEL': {
      const windowId = message.windowId || sender?.tab?.windowId || activeWindowId;
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.tabs
          .query({ active: true, lastFocusedWindow: true })
          .then(([tab]) => {
            const targetWinId = windowId || tab?.windowId;
            if (targetWinId) {
              return chrome.sidePanel.open({ windowId: targetWinId });
            }
          })
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }
      sendResponse({ ok: false, error: 'sidePanel API unavailable' });
      return false;
    }

    case 'BROWSER_ACTION': {
      handleBrowserAction(message.action, message.payload, sender?.tab)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    default:
      return false;
  }
});

async function handleBrowserAction(action, payload = {}, senderTab = null) {
  const [activeTab] = senderTab
    ? [senderTab]
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!activeTab) return {};

  switch (action) {
    case 'TAB_NEXT':
    case 'TAB_PREV': {
      const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
      if (tabs.length <= 1) return { tabCount: tabs.length };
      const currentIdx = tabs.findIndex((t) => t.id === activeTab.id);
      const step = action === 'TAB_NEXT' ? 1 : -1;
      const nextIdx = (currentIdx + step + tabs.length) % tabs.length;
      const targetTab = tabs[nextIdx];

      activeTabId = targetTab.id;
      await chrome.tabs.update(targetTab.id, { active: true });
      await ensureContentScriptInTab(targetTab.id);

      setTimeout(() => {
        chrome.tabs
          .sendMessage(targetTab.id, {
            type: 'TAB_SWITCHED_TOAST',
            direction: action === 'TAB_NEXT' ? 'Next Tab →' : '← Previous Tab',
            title: targetTab.title,
            index: nextIdx + 1,
            total: tabs.length
          })
          .catch(() => {});
      }, 50);

      return { switchedTo: targetTab.title, index: nextIdx + 1, total: tabs.length };
    }

    case 'NEW_TAB': {
      const newTab = await chrome.tabs.create({
        windowId: activeTab.windowId,
        url: 'https://www.google.com'
      });
      activeTabId = newTab.id;
      return {};
    }

    case 'CLOSE_TAB': {
      if (activeTab.id) {
        await chrome.tabs.remove(activeTab.id);
      }
      return {};
    }

    case 'REOPEN_TAB': {
      if (chrome.sessions) {
        await chrome.sessions.restore();
      }
      return {};
    }

    case 'RELOAD_TAB': {
      if (activeTab.id) {
        await chrome.tabs.reload(activeTab.id);
      }
      return {};
    }

    case 'MUTE_TAB': {
      if (activeTab.id) {
        const isMuted = Boolean(activeTab.mutedInfo?.muted);
        await chrome.tabs.update(activeTab.id, { muted: !isMuted });
        return { muted: !isMuted };
      }
      return {};
    }

    case 'ZOOM_IN':
    case 'ZOOM_OUT':
    case 'ZOOM_RESET': {
      if (!activeTab.id) return {};
      const currentZoom = await chrome.tabs.getZoom(activeTab.id);
      let nextZoom = 1.0;
      if (action === 'ZOOM_IN') nextZoom = Math.min(3.0, +(currentZoom + 0.15).toFixed(2));
      if (action === 'ZOOM_OUT') nextZoom = Math.max(0.3, +(currentZoom - 0.15).toFixed(2));
      await chrome.tabs.setZoom(activeTab.id, nextZoom);
      return { zoom: Math.round(nextZoom * 100) };
    }

    default:
      return {};
  }
}
