/**
 * Handdy — Background Service Worker (background.js)
 * Guarantees seamless cross-tab functionality by:
 * 1. Auto-injecting content.js into ALL open tabs on startup/install and tab switch
 * 2. Orchestrating instant webcam handoff (RELEASE_CAMERA_NOW -> ACTIVATE_TAB_CAMERA)
 *    between the previous tab and newly activated tab so Windows webcams never lock up
 * 3. Preserving cursor (x, y) coordinates across tab switches
 * 4. Supporting persistent Side Panel mode across all tabs
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
let sidePanelPort = null;
let activeTabId = null;
let previousTabId = null;
let activeWindowId = null;
let lastCursor = { x: 0.5, y: 0.5 };

async function bootExtension() {
  const stored = await chrome.storage.local.get(['settings', 'cameraPermissionGranted']);
  cachedSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  updateBadge(cachedSettings.enabled);

  await updateActiveTabReference();
  await injectIntoAllExistingTabs();
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

// Instant camera handoff when switching tabs!
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (activeTabId && activeTabId !== activeInfo.tabId) {
    previousTabId = activeTabId;
    // Immediately tell the previous tab to release the webcam
    chrome.tabs.sendMessage(previousTabId, { type: 'RELEASE_CAMERA_NOW' }).catch(() => {});
  }

  activeTabId = activeInfo.tabId;
  activeWindowId = activeInfo.windowId;

  await ensureContentScriptInTab(activeInfo.tabId);

  // Tell the newly activated tab to start tracking and inherit the cursor position
  chrome.tabs
    .sendMessage(activeInfo.tabId, {
      type: 'ACTIVATE_TAB_CAMERA',
      lastCursor,
      sidePanelActive: Boolean(sidePanelPort)
    })
    .catch(() => {});
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  activeWindowId = windowId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.id !== activeTabId) {
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'RELEASE_CAMERA_NOW' }).catch(() => {});
      }
      activeTabId = tab.id;
      await ensureContentScriptInTab(tab.id);
      chrome.tabs
        .sendMessage(tab.id, {
          type: 'ACTIVATE_TAB_CAMERA',
          lastCursor,
          sidePanelActive: Boolean(sidePanelPort)
        })
        .catch(() => {});
    }
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'loading' || changeInfo.status === 'complete') && tab?.active) {
    activeTabId = tabId;
    await ensureContentScriptInTab(tabId);
    if (changeInfo.status === 'complete') {
      chrome.tabs
        .sendMessage(tabId, {
          type: 'ACTIVATE_TAB_CAMERA',
          lastCursor,
          sidePanelActive: Boolean(sidePanelPort)
        })
        .catch(() => {});
    }
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

    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING_Handdy' }).catch(() => null);
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    updateBadge(cachedSettings.enabled);

    broadcastToTabs({
      type: 'SETTINGS_UPDATED',
      settings: cachedSettings,
      sidePanelActive: Boolean(sidePanelPort)
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
  if (msg.payload?.cursor) {
    lastCursor = msg.payload.cursor;
  }
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

// Persistent Side Panel connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'Handdy-sidepanel') {
    sidePanelPort = port;
    broadcastToTabs({ type: 'SIDEPANEL_STATUS', active: true });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'HAND_FRAME' || msg.type === 'HAND_LOST') {
        forwardFrameToActiveTab(msg);
      } else if (msg.type === 'BROWSER_ACTION') {
        handleBrowserAction(msg.action, msg.payload);
      }
    });

    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
      broadcastToTabs({ type: 'SIDEPANEL_STATUS', active: false });
      if (activeTabId) {
        chrome.tabs
          .sendMessage(activeTabId, {
            type: 'ACTIVATE_TAB_CAMERA',
            lastCursor,
            sidePanelActive: false
          })
          .catch(() => {});
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.lastCursor && typeof message.lastCursor.x === 'number') {
    lastCursor = message.lastCursor;
  }

  switch (message.type) {
    case 'GET_STATUS': {
      chrome.storage.local.get(['settings', 'cameraPermissionGranted']).then((data) => {
        sendResponse({
          settings: data.settings || DEFAULT_SETTINGS,
          cameraPermissionGranted: Boolean(data.cameraPermissionGranted),
          sidePanelActive: Boolean(sidePanelPort),
          lastCursor
        });
      });
      return true;
    }

    case 'SYNC_CURSOR_POS': {
      if (message.cursor) {
        lastCursor = message.cursor;
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'CAMERA_PERMISSION_GRANTED': {
      chrome.storage.local.set({ cameraPermissionGranted: true }).then(() => {
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

      // Find next tab, skipping non-scriptable chrome:// tabs if there are web tabs available
      const currentIdx = tabs.findIndex((t) => t.id === activeTab.id);
      const step = action === 'TAB_NEXT' ? 1 : -1;

      // Release camera on current tab BEFORE switching
      if (activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'RELEASE_CAMERA_NOW' }).catch(() => {});
      }

      let nextIdx = (currentIdx + step + tabs.length) % tabs.length;
      const targetTab = tabs[nextIdx];

      activeTabId = targetTab.id;
      await chrome.tabs.update(targetTab.id, { active: true });
      await ensureContentScriptInTab(targetTab.id);

      setTimeout(() => {
        chrome.tabs
          .sendMessage(targetTab.id, {
            type: 'ACTIVATE_TAB_CAMERA',
            lastCursor,
            sidePanelActive: Boolean(sidePanelPort),
            toast: {
              direction: action === 'TAB_NEXT' ? 'Next Tab →' : '← Previous Tab',
              title: targetTab.title,
              index: nextIdx + 1,
              total: tabs.length
            }
          })
          .catch(() => {});
      }, 40);

      return { switchedTo: targetTab.title, index: nextIdx + 1, total: tabs.length };
    }

    case 'NEW_TAB': {
      if (activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'RELEASE_CAMERA_NOW' }).catch(() => {});
      }
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
