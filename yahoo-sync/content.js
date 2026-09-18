(function() {
  "use strict";

  let syncBaseUrl = "http://localhost:3333";
  const sent = new Set();
  let pickCount = 0;

  console.log("[Draft Co-Pilot] Content script injected into Yahoo Draft Room.");

  // 1. Create and inject high-contrast status badge
  let badge = document.getElementById("copilot-yahoo-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "copilot-yahoo-badge";
    badge.className = "disconnected";
    badge.innerHTML = `
      <span class="badge-dot"></span>
      <span class="badge-title">🏒 Co-Pilot: Offline</span>
      <span class="badge-counter" id="copilot-badge-count">0 picks</span>
    `;
    badge.title = "Draft Co-Pilot: Connecting to server...";
    document.body.appendChild(badge);

    badge.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "checkNow" }, updateBadge);
    });
  }

  function updateBadge(status) {
    if (!badge || !status) return;
    const titleEl = badge.querySelector(".badge-title");
    const countEl = document.getElementById("copilot-badge-count");

    if (countEl) {
      countEl.textContent = `${pickCount} synced`;
    }

    if (status.connected) {
      badge.className = "connected";
      const latText = status.latency !== null ? ` (${status.latency}ms)` : "";
      if (titleEl) titleEl.textContent = `🏒 Co-Pilot: Live${latText}`;
      badge.title = `Connected to ${syncBaseUrl}. Picks streaming hands-free to local Co-Pilot.`;
    } else {
      badge.className = "disconnected";
      if (titleEl) titleEl.textContent = "🏒 Co-Pilot: Offline";
      badge.title = `Disconnected from ${syncBaseUrl}. Make sure "npm start" is running on port 3333. Click to retry.`;
    }
  }

  // 2. Fetch initial sync URL from storage and listen for changes
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["syncUrl", "status"], (data) => {
      if (data && data.syncUrl) {
        syncBaseUrl = data.syncUrl.replace(/\/$/, "");
      }
      if (data && data.status) {
        updateBadge(data.status);
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.syncUrl) {
        syncBaseUrl = changes.syncUrl.newValue.replace(/\/$/, "");
        console.log(`[Draft Co-Pilot] Sync URL updated to: ${syncBaseUrl}`);
      }
    });
  }

  // 3. Listen for health check broadcasts from background service worker
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "statusUpdate" && message.status) {
        updateBadge(message.status);
      }
    });

    // Request immediate status on idle load
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (!chrome.runtime.lastError && status) {
        updateBadge(status);
      }
    });
  }

  // 4. Push detected pick to the local Co-Pilot server
  function pushPick(name, isMine) {
    if (!name || sent.has(name)) return;
    sent.add(name);
    pickCount++;

    const countEl = document.getElementById("copilot-badge-count");
    if (countEl) countEl.textContent = `${pickCount} synced`;

    console.log(`[Draft Co-Pilot] Pick detected: ${name} (Mine: ${isMine}) -> ${syncBaseUrl}/api/pick`);

    fetch(`${syncBaseUrl}/api/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, isMine: isMine })
    })
    .then((res) => {
      if (res.ok) {
        console.log(`[Draft Co-Pilot] Successfully recorded pick: ${name}`);
      } else {
        console.warn(`[Draft Co-Pilot] Server returned error ${res.status} for pick: ${name}`);
      }
    })
    .catch((err) => {
      console.warn(`[Draft Co-Pilot] Failed to post pick: ${name}`, err);
    });
  }

  function cleanPlayerName(text) {
    if (!text) return "";
    let clean = text.replace(/\s+/g, " ").trim();
    // Remove trailing team/position like "COL - D" or "EDM - C,LW"
    clean = clean.split(/ - | \(/)[0].trim();
    return clean;
  }

  function checkDOMForPicks() {
    const selector = [
      ".draft-results-table tr",
      ".table-draft-results tbody tr",
      "#draft-tables tbody tr",
      ".Grid-table tr",
      "[data-tst='draft-result-row']",
      ".draft-history-row"
    ].join(", ");

    const rows = document.querySelectorAll(selector);
    rows.forEach((row) => {
      const nameEl = row.querySelector(".name, .player, [data-tst='player-name'], a.F-link, .player-name");
      if (nameEl) {
        const rawName = nameEl.textContent;
        const cleanName = cleanPlayerName(rawName);
        if (cleanName && cleanName.length > 2) {
          const isMine = row.classList.contains("my-team") ||
                         row.classList.contains("user-pick") ||
                         !!row.querySelector(".my-team, [data-tst='user-team']");
          pushPick(cleanName, isMine);
        }
      }
    });
  }

  // Periodic check as a fallback
  setInterval(checkDOMForPicks, 1500);

  // MutationObserver for instantaneous pick detection
  const observer = new MutationObserver(() => {
    checkDOMForPicks();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();
