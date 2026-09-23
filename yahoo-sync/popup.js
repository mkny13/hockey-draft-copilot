"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const statusPill = document.getElementById("status-pill");
  const statusText = document.getElementById("status-text");
  const statLatency = document.getElementById("stat-latency");
  const statLastChecked = document.getElementById("stat-last-checked");
  const inputSyncUrl = document.getElementById("input-sync-url");
  const btnSave = document.getElementById("btn-save");
  const btnPing = document.getElementById("btn-ping");
  const feedbackMsg = document.getElementById("feedback-msg");

  function showFeedback(text, isSuccess) {
    feedbackMsg.textContent = text;
    feedbackMsg.className = `feedback ${isSuccess ? "success" : "error"}`;
    setTimeout(() => {
      if (feedbackMsg.textContent === text) {
        feedbackMsg.textContent = "";
      }
    }, 4000);
  }

  function updateUI(status) {
    if (!status) return;

    if (status.connected) {
      statusPill.className = "status-pill connected";
      statusText.textContent = "Connected";
      const pickInfo = status.currentPick ? ` • Pick #${status.currentPick}` : "";
      statLatency.textContent = `${status.latency !== null ? status.latency + "ms" : "OK"}${pickInfo}`;
    } else {
      statusPill.className = "status-pill disconnected";
      statusText.textContent = "Disconnected";
      statLatency.textContent = status.error || "Offline";
    }

    if (status.lastChecked) {
      const d = new Date(status.lastChecked);
      statLastChecked.textContent = d.toLocaleTimeString();
    }
  }

  // Load persisted settings and latest cached status
  try {
    const data = await chrome.storage.local.get(["syncUrl", "status"]);
    inputSyncUrl.value = data.syncUrl || "http://localhost:3333";
    if (data.status) {
      updateUI(data.status);
    }
  } catch (err) {
    inputSyncUrl.value = "http://localhost:3333";
  }

  // Request fresh live health check from background worker
  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (chrome.runtime.lastError) {
      // Service worker may be waking up
      return;
    }
    updateUI(status);
  });

  // Listen for real-time status broadcasts while popup is open
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "statusUpdate" && message.status) {
      updateUI(message.status);
    }
  });

  // Save updated server URL
  btnSave.addEventListener("click", () => {
    const raw = inputSyncUrl.value.trim().replace(/\/$/, "");
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      showFeedback("URL must be a valid http:// or https:// address", false);
      return;
    }

    btnSave.disabled = true;
    btnSave.textContent = "...";

    chrome.runtime.sendMessage({ type: "updateSyncUrl", syncUrl: raw }, (status) => {
      btnSave.disabled = false;
      btnSave.textContent = "Save";

      if (chrome.runtime.lastError) {
        showFeedback("Failed to update: worker busy", false);
        return;
      }

      updateUI(status);
      const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (!isLoopback) {
        showFeedback("Saved, but the extension only has permission to reach localhost — this host will not sync.", false);
      } else if (status && status.connected) {
        showFeedback("Saved! Connected successfully.", true);
      } else {
        showFeedback("Saved, but server unreachable.", false);
      }
    });
  });

  // Ping immediately
  btnPing.addEventListener("click", () => {
    btnPing.disabled = true;
    btnPing.textContent = "...";
    showFeedback("Pinging server...", true);

    chrome.runtime.sendMessage({ type: "checkNow" }, (status) => {
      btnPing.disabled = false;
      btnPing.textContent = "Ping";

      if (chrome.runtime.lastError) {
        showFeedback("Ping failed: service worker inactive", false);
        return;
      }

      updateUI(status);
      if (status && status.connected) {
        showFeedback(`Ping OK (${status.latency}ms)`, true);
      } else {
        showFeedback(`Ping failed: ${status.error || "offline"}`, false);
      }
    });
  });
});
