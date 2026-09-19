"use strict";

const DEFAULT_SYNC_URL = "http://localhost:3333";

/**
 * Health check service worker for Yahoo Fantasy Hockey Draft Co-Pilot
 * Periodically pings the local Co-Pilot server, records connection status,
 * latency, and broadcasts state to the extension popup and draft room content tabs.
 */
async function getSyncUrl() {
  try {
    const data = await chrome.storage.local.get("syncUrl");
    return (data && data.syncUrl) ? data.syncUrl.replace(/\/$/, "") : DEFAULT_SYNC_URL;
  } catch (err) {
    return DEFAULT_SYNC_URL;
  }
}

async function checkHealth() {
  const syncUrl = await getSyncUrl();
  const startTime = Date.now();
  let status = {
    connected: false,
    latency: null,
    lastChecked: startTime,
    syncUrl: syncUrl,
    currentPick: null,
    error: null
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${syncUrl}/api/state`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const latency = Date.now() - startTime;
      const data = await res.json();
      status.connected = true;
      status.latency = latency;
      status.currentPick = data.currentPick || 1;
    } else {
      status.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    status.error = err.name === "AbortError" ? "Timeout (3s)" : (err.message || "Connection refused");
  }

  // Persist latest health status in local storage
  try {
    await chrome.storage.local.set({ status });
  } catch (e) {
    console.warn("[Background] Failed to persist status in storage:", e);
  }

  // Broadcast to popup if open
  chrome.runtime.sendMessage({ type: "statusUpdate", status }).catch(() => {
    // Expected error when popup is closed; safely ignore
  });

  // Broadcast to all active ESPN and Yahoo Draft tabs
  try {
    if (chrome.tabs && chrome.tabs.query) {
      const tabs = await chrome.tabs.query({
        url: [
          "https://*.espn.com/*",
          "https://espn.com/*",
          "https://hockey.fantasysports.yahoo.com/*",
          "https://draft.fantasysports.yahoo.com/*"
        ]
      });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "statusUpdate", status }).catch(() => {
            // Tab may not have content script ready; safely ignore
          });
        }
      }
    }
  } catch (err) {
    // tabs query fails gracefully if permissions are restricted
  }

  return status;
}

// Initial health check on worker start & installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Background] Yahoo Draft Sync Extension installed.");
  checkHealth();
});

chrome.runtime.onStartup.addListener(() => {
  checkHealth();
});

// Periodic health-check every 5 seconds
setInterval(checkHealth, 5000);
checkHealth();

// Message interface for popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "getStatus") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get("status");
        // The worker sleeps when idle, pausing the interval: re-check when the stored status is stale
        if (stored && stored.status && Date.now() - (stored.status.lastChecked || 0) < 10000) {
          sendResponse(stored.status);
        } else {
          const fresh = await checkHealth();
          sendResponse(fresh);
        }
      } catch (e) {
        sendResponse({ connected: false, syncUrl: DEFAULT_SYNC_URL, error: e.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === "checkNow") {
    (async () => {
      const fresh = await checkHealth();
      sendResponse(fresh);
    })();
    return true;
  }

  if (message.type === "updateSyncUrl") {
    (async () => {
      const rawUrl = (message.syncUrl || "").trim().replace(/\/$/, "");
      const newUrl = rawUrl || DEFAULT_SYNC_URL;
      await chrome.storage.local.set({ syncUrl: newUrl });
      const fresh = await checkHealth();
      sendResponse(fresh);
    })();
    return true;
  }

  return false;
});
