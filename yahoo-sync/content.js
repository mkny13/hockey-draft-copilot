(function() {
  "use strict";

  const DEFAULT_SYNC_URL = "http://localhost:3333";
  let syncBaseUrl = DEFAULT_SYNC_URL;
  let syncWsUrl = "ws://localhost:3333";

  function validateSyncUrl(url) {
    if (typeof url !== "string") return DEFAULT_SYNC_URL;
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return url.trim().replace(/\/$/, "");
      }
    } catch (e) {}
    return DEFAULT_SYNC_URL;
  }
  const sent = new Set();
  let pickCount = 0;
  let lastSyncedPick = "None";
  let currentResetId = null;
  let currentSessionUrl = window.location.href;

  let wsClient = null;
  let wsReconnectTimer = null;

  const isEspn = window.location.hostname.includes("espn.com");
  const platformName = isEspn ? "ESPN" : "Yahoo";

  console.log(`[Draft Co-Pilot] Content script active on ${platformName} (Frame: ${window === window.top ? "Top" : "iFrame"}).`);

  // 1. WebSocket Live Synchronization with Local Server
  function connectWebSocket() {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      wsClient = new WebSocket(syncWsUrl);

      wsClient.onopen = function() {
        console.log(`[Draft Co-Pilot] Connected to live server WebSocket: ${syncWsUrl}`);
        updateBadge({ connected: true, latency: null });
      };

      wsClient.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          handleServerWsMessage(data);
        } catch (e) {}
      };

      wsClient.onclose = function() {
        updateBadge({ connected: false });
        scheduleWsReconnect();
      };

      wsClient.onerror = function() {
        scheduleWsReconnect();
      };
    } catch (e) {
      scheduleWsReconnect();
    }
  }

  function scheduleWsReconnect() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 3000);
  }

  function handleServerWsMessage(data) {
    if (!data || !data.type) return;

    if (data.evaluation) renderEvaluation(data.evaluation);

    if (data.type === "INIT_STATE" && data.state) {
      syncFromServerState(data.state);
    } else if (data.type === "RESET") {
      resetLocalSyncState("Server board reset received.");
    } else if (data.type === "PICK_UNDONE") {
      if (data.payload && data.payload.name) {
        sent.delete(data.payload.name.trim().toLowerCase());
        pickCount = Math.max(0, pickCount - 1);
        renderCounters();
      }
    } else if (data.type === "PICK_MADE") {
      if (data.payload && data.payload.name) {
        sent.add(data.payload.name.trim().toLowerCase());
        if (data.state && Array.isArray(data.state.pickHistory)) {
          pickCount = data.state.pickHistory.length;
          lastSyncedPick = `${pickCount}. ${data.payload.name}`;
          renderCounters();
        }
      }
    }
  }

  function syncFromServerState(state) {
    if (!state) return;
    if (state.resetId) currentResetId = state.resetId;

    if (!state.pickHistory || state.pickHistory.length === 0) {
      resetLocalSyncState();
      return;
    }

    sent.clear();
    state.pickHistory.forEach((p) => {
      if (p.name) sent.add(p.name.trim().toLowerCase());
    });
    pickCount = state.pickHistory.length;
    const lastPick = state.pickHistory[pickCount - 1];
    lastSyncedPick = lastPick ? `${pickCount}. ${lastPick.name}` : "None";
    renderCounters();
  }

  function resetLocalSyncState(reason) {
    sent.clear();
    pickCount = 0;
    lastSyncedPick = "None";
    renderCounters();
    const msgEl = document.getElementById("hud-status-msg");
    if (msgEl) {
      msgEl.textContent = reason ? `✓ ${reason}` : "✓ Board reset: Ready for picks.";
      msgEl.style.color = "#3fb950";
    }
    console.log(`[Draft Co-Pilot] Local sync state cleared. (Reason: ${reason || 'Reset'})`);
  }

  function renderCounters() {
    const countEl = document.getElementById("copilot-badge-count");
    if (countEl) countEl.textContent = `${pickCount} synced`;
    const hudCount = document.getElementById("hud-count");
    if (hudCount) hudCount.textContent = `${pickCount} synced`;
    const hudLast = document.getElementById("hud-last");
    if (hudLast) hudLast.textContent = lastSyncedPick;
  }

  function renderEvaluation(ev) {
    const headline = document.getElementById("hud-headline");
    if (!headline || !ev) return;
    const colors = { critical: "#ff7b72", warning: "#d29922", turn: "#3fb950", waiting: "#58a6ff" };
    headline.textContent = ev.headline || "";
    headline.style.color = colors[ev.alertType] || "#c9d1d9";
    document.getElementById("hud-subtext").textContent = ev.subtext || "";

    const list = document.getElementById("hud-shortlist");
    list.textContent = "";
    (ev.shortlist || []).forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "hud-short-row";
      const name = document.createElement("span");
      name.className = "hud-short-name";
      name.textContent = `${i + 1}. ${p.name} (${p.pos})`;
      const surv = document.createElement("span");
      surv.className = "hud-short-surv";
      surv.textContent = `${Math.round(p.survivalProb * 100)}%`;
      surv.title = `Survival to pick #${ev.targetTurn} | ${p.action} | Adj VORP ${p.adjVorp.toFixed(1)}`;
      row.append(name, surv);
      list.appendChild(row);
    });

    document.getElementById("hud-tradeoff").textContent = ev.tradeoff || "No trade-off flagged.";
  }

  // 2. High-contrast In-Room Status Badge & HUD
  function injectBadge() {
    if (document.getElementById("copilot-yahoo-badge")) return;

    const container = document.body || document.documentElement;
    if (!container) return;

    const badge = document.createElement("div");
    badge.id = "copilot-yahoo-badge";
    badge.className = "disconnected";
    badge.innerHTML = `
      <span class="badge-dot"></span>
      <span class="badge-title">🏒 Co-Pilot: Live</span>
      <span class="badge-counter" id="copilot-badge-count">0 synced</span>
    `;
    badge.title = `Draft Co-Pilot: Click to open Sync HUD`;

    const hud = document.createElement("div");
    hud.id = "copilot-hud-card";
    // ESPN: dock exactly over the right-hand Picks sidebar instead of floating over the pick strip
    if (isEspn) hud.classList.add("espn-layout");
    hud.style.display = "none";
    hud.innerHTML = `
      <div class="hud-header">
        <span style="font-weight:bold; color:#fff; font-size:12px;">🏒 Draft Co-Pilot Live HUD</span>
        <button id="copilot-hud-close" style="background:none; border:none; color:#8b949e; cursor:pointer; font-size:14px;">&times;</button>
      </div>
      <div class="hud-body">
        <div class="hud-row">
          <span class="hud-label">Platform:</span>
          <span class="hud-val" id="hud-platform">${platformName} (${window === window.top ? "Top Window" : "iFrame"})</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Server:</span>
          <span class="hud-val" id="hud-server"></span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Picks Synced:</span>
          <span class="hud-val" id="hud-count" style="color:#3fb950; font-weight:bold;">0</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Last Synced:</span>
          <span class="hud-val" id="hud-last">-</span>
        </div>
        <div style="margin-top:10px; display:flex; gap:6px;">
          <button id="copilot-btn-scan" class="hud-btn primary" title="Scan board and history right now">⚡ Scan Board</button>
          <button id="copilot-btn-history" class="hud-btn" style="background:#1f6feb; color:#fff;" title="Deep scan full pick history">📋 Deep Scan</button>
          <button id="copilot-btn-reset" class="hud-btn" style="background:#da3633; color:#fff;" title="Reset draft board on server and extension">🔄 Reset</button>
        </div>
        <div style="margin-top:10px; border-top:1px solid #30363d; padding-top:8px;">
          <div style="font-size:10px; color:#8b949e; margin-bottom:4px;">Quick Add Pick to Co-Pilot:</div>
          <div style="display:flex; gap:4px;">
            <input type="text" id="copilot-quick-input" placeholder="Type player name (e.g. McDavid)..." style="flex:1; background:#161b22; border:1px solid #30363d; color:#fff; font-size:11px; padding:4px 6px; border-radius:4px;">
            <button id="copilot-quick-send" class="hud-btn primary" style="padding:4px 8px;">Add</button>
          </div>
        </div>
        <div id="hud-status-msg" style="font-size:10px; color:#8b949e; margin-top:6px; min-height:14px;"></div>
        <div class="hud-section">
          <div id="hud-headline" class="hud-headline">Waiting for Co-Pilot...</div>
          <div id="hud-subtext" class="hud-subtext"></div>
        </div>
        <div class="hud-section">
          <div class="hud-section-title">🎯 Short List</div>
          <div id="hud-shortlist"></div>
        </div>
        <div class="hud-section">
          <div class="hud-section-title">⚖️ Game Theory Trade-Off</div>
          <div id="hud-tradeoff" class="hud-subtext"></div>
        </div>
      </div>
    `;

    container.appendChild(badge);
    container.appendChild(hud);

    const srv = hud.querySelector("#hud-server");
    if (srv) srv.textContent = syncBaseUrl;

    badge.addEventListener("click", () => {
      hud.style.display = hud.style.display === "none" ? "block" : "none";
    });

    const closeBtn = document.getElementById("copilot-hud-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => { hud.style.display = "none"; });
    }

    const scanBtn = document.getElementById("copilot-btn-scan");
    if (scanBtn) {
      scanBtn.addEventListener("click", () => {
        const found = scanAndSyncAllPicks(true);
        const msgEl = document.getElementById("hud-status-msg");
        if (msgEl) {
          msgEl.textContent = `Scanned: ${found.length} new pick(s) pushed. Total: ${pickCount}.`;
          msgEl.style.color = "#3fb950";
        }
      });
    }

    const historyBtn = document.getElementById("copilot-btn-history");
    if (historyBtn) {
      historyBtn.addEventListener("click", () => {
        deepScanPickHistory();
      });
    }

    const resetBtn = document.getElementById("copilot-btn-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (!confirm("Are you sure you want to reset the draft board to Pick #1?")) return;
        fetch(`${syncBaseUrl}/api/reset`, { method: "POST" })
          .then((r) => r.json())
          .then((res) => {
            resetLocalSyncState("Draft board reset to Pick #1.");
          })
          .catch((err) => {
            resetLocalSyncState("Reset locally (server unreachable).");
          });
      });
    }

    const quickInput = document.getElementById("copilot-quick-input");
    const quickSend = document.getElementById("copilot-quick-send");
    function handleQuickSend() {
      if (!quickInput || !quickInput.value.trim()) return;
      const raw = quickInput.value.trim();
      const resolved = (window.resolveCopilotPlayer && window.resolveCopilotPlayer(raw)) || raw;
      pushPick(resolved);
      quickInput.value = "";
      const msgEl = document.getElementById("hud-status-msg");
      if (msgEl) {
        msgEl.textContent = `Queued pick: ${resolved}`;
        msgEl.style.color = "#3fb950";
      }
    }
    if (quickSend) quickSend.addEventListener("click", handleQuickSend);
    if (quickInput) {
      quickInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleQuickSend();
      });
    }
  }

  function updateBadge(status) {
    const badge = document.getElementById("copilot-yahoo-badge");
    if (!badge || !status) return;

    const titleEl = badge.querySelector(".badge-title");
    renderCounters();

    if (status.connected) {
      badge.className = "connected";
      const latText = status.latency !== null ? ` (${status.latency}ms)` : "";
      if (titleEl) titleEl.textContent = `🏒 Co-Pilot: Live${latText}`;
      badge.title = `Connected to ${syncBaseUrl}. ${platformName} picks streaming hands-free to local Co-Pilot. Click for HUD.`;
    } else {
      badge.className = "disconnected";
      if (titleEl) titleEl.textContent = "🏒 Co-Pilot: Offline";
      badge.title = `Disconnected from ${syncBaseUrl}. Make sure Co-Pilot server is running on port 3333. Click to retry.`;
    }
  }

  // 3. Storage & Background Connection Handlers
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["syncUrl", "status"], (data) => {
      if (data && data.syncUrl !== undefined) {
        syncBaseUrl = validateSyncUrl(data.syncUrl);
        syncWsUrl = syncBaseUrl.replace(/^http/, "ws");
        const srv = document.getElementById("hud-server");
        if (srv) srv.textContent = syncBaseUrl;
      }
      if (data && data.status) updateBadge(data.status);
      connectWebSocket();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.syncUrl) {
        syncBaseUrl = validateSyncUrl(changes.syncUrl.newValue);
        syncWsUrl = syncBaseUrl.replace(/^http/, "ws");
        const srv = document.getElementById("hud-server");
        if (srv) srv.textContent = syncBaseUrl;
        connectWebSocket();
      }
    });
  } else {
    connectWebSocket();
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "statusUpdate" && message.status) {
        updateBadge(message.status);
      }
    });
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (!chrome.runtime.lastError && status) updateBadge(status);
    });
  }

  // 4. Core Pick Pusher
  function pushPick(name, meta) {
    if (!name) return;
    const clean = name.trim();
    if (sent.has(clean.toLowerCase())) return;
    sent.add(clean.toLowerCase());

    pickCount++;
    lastSyncedPick = `${pickCount}. ${clean}`;
    renderCounters();

    console.log(`[Draft Co-Pilot] >>> DETECTED PICK #${pickCount}: ${clean} -> ${syncBaseUrl}/api/pick`);

    fetch(`${syncBaseUrl}/api/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: clean, ...meta })
    })
    .then((res) => {
      if (res.ok) {
        console.log(`[Draft Co-Pilot] ✓ Successfully synced pick #${pickCount}: ${clean}`);
      } else {
        console.warn(`[Draft Co-Pilot] Server returned HTTP ${res.status} for pick: ${clean}`);
      }
    })
    .catch((err) => {
      console.warn(`[Draft Co-Pilot] Network error pushing pick: ${clean}`, err);
      // Server unreachable: forget the pick so the next scan retries it
      sent.delete(clean.toLowerCase());
      pickCount = Math.max(0, pickCount - 1);
      renderCounters();
    });
  }

  // 5. Strict Guard: Discard elements inside the Available Players table
  function isAvailablePlayersElement(elem) {
    if (!elem) return false;

    // A. Element is inside the player pool container
    const poolContainer = elem.closest([
      "[class*='playerPool']",
      "[class*='PlayerPool']",
      "[class*='player-pool']",
      "[class*='player-table']",
      "[class*='PlayerTable']",
      "[class*='players-table']",
      "[class*='PlayersTable']",
      "[class*='table-player']",
      "[class*='Table--players']",
      "[class*='table--players']",
      "[class*='available-players']",
      "[class*='AvailablePlayers']",
      "[data-testid*='player-table']",
      "#playertable",
      ".playertable"
    ].join(", "));
    if (poolContainer) return true;

    // B. Element row has a "DRAFT" button (strictly undrafted players)
    const row = elem.closest("tr, [role='row'], li, div[class*='row']");
    if (row) {
      const btns = row.querySelectorAll("button, a, [role='button']");
      for (let i = 0; i < btns.length; i++) {
        const txt = (btns[i].textContent || "").trim().toLowerCase();
        if (txt === "draft" || txt === "claim" || txt === "queue" || txt === "+" || btns[i].getAttribute("title") === "Draft") {
          return true;
        }
      }
    }

    return false;
  }

  // 6. Target A: ESPN Floating Pick Notification Toasts (Bottom-Right Corner)
  // Format: "Nathan MacKinnon / COL, F \n R1, P1 - Is Bobby Orr Available?"
  function scanNotificationToasts() {
    const newlyFound = [];
    const roundPick = /R(\d+),\s*P(\d+)/i;
    const playerTeam = /([A-Z][a-zA-Z\.\'\-\s]+?)\s*\/\s*([A-Z]{2,3})(?:,\s*([A-Z]+))?/i;

    // Start from the text nodes carrying "R#, P#" (cheap: one regex per node) and climb
    // to the smallest small ancestor that also holds "Name / TEAM". The length cap
    // keeps page-wide wrappers (which also contain the Available Players list) out.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!roundPick.test(textNode.nodeValue)) continue;

      let card = textNode.parentElement;
      let found = false;
      for (let depth = 0; card && depth < 6; depth++, card = card.parentElement) {
        const t = card.textContent || "";
        if (t.length >= 300) break;
        if (playerTeam.test(t)) { found = true; break; }
      }
      if (!found || seen.has(card)) continue;
      seen.add(card);

      if (isAvailablePlayersElement(card)) continue;
      const txt = card.textContent || "";
      const rMatch = txt.match(roundPick);
      const pMatch = txt.match(playerTeam);

      // The picked player is listed before the round/pick marker
      if (!pMatch || !rMatch || pMatch.index > rMatch.index) continue;

      const resolved = window.resolveCopilotPlayer ? window.resolveCopilotPlayer(pMatch[1].trim()) : pMatch[1].trim();
      if (resolved && !sent.has(resolved.toLowerCase())) {
        pushPick(resolved, {
          round: parseInt(rMatch[1], 10),
          pickInRound: parseInt(rMatch[2], 10)
        });
        newlyFound.push(resolved);
      }
    }

    return newlyFound;
  }

  // 7. Target B: ESPN & Yahoo Live Draft Board & History Tables
  function scanBoardAndHistory() {
    const newlyFound = [];

    function tryPush(text, elem) {
      if (!text || text.length < 3) return;
      if (elem && isAvailablePlayersElement(elem)) return;

      const resolved = window.resolveCopilotPlayer ? window.resolveCopilotPlayer(text) : null;
      if (resolved && !sent.has(resolved.toLowerCase())) {
        pushPick(resolved);
        newlyFound.push(resolved);
      }
    }

    // Target 1: Pick History List & Activity
    const historyRows = document.querySelectorAll([
      "[class*='draftHistory'] tr",
      "[class*='DraftHistory'] tr",
      "[class*='DraftHistory'] div[class*='row']",
      "[class*='pickHistory'] li",
      "[class*='PickHistory'] li",
      "[class*='pickHistory'] tr",
      "[class*='PickHistory'] tr",
      ".draft-activity-item",
      ".ticker-item",
      ".chat-message",
      "div[class*='feedItem']",
      "div[class*='ticker']"
    ].join(", "));

    historyRows.forEach((item) => {
      if (isAvailablePlayersElement(item)) return;
      const txt = item.textContent || "";

      const m1 = txt.match(/(?:drafted|selected)\s+([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*,|\s*\(|\s+with|\s+as|\s+by|$)/i);
      if (m1 && m1[1]) tryPush(m1[1], item);

      const m2 = txt.match(/([A-Z][a-zA-Z\.\'\-\s]+?)\s+(?:was\s+drafted|drafted|selected)\s+by/i);
      if (m2 && m2[1]) tryPush(m2[1], item);

      const m3 = txt.match(/(?:pick\s*#?\d+[:\s]+)([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*\(|\s*,|\s+by|$)/i);
      if (m3 && m3[1]) tryPush(m3[1], item);

      if (/(?:drafted|selected|pick\s*#?\d+|round\s*\d+)/i.test(txt)) {
        const link = item.querySelector("a[href*='player'], a[href*='athlete'], [data-player-id], a.F-link");
        if (link) {
          tryPush(link.getAttribute("title") || link.textContent, item);
        }
      }
    });

    // Target 2: ESPN Draft Board Grid Cells
    const boardCells = document.querySelectorAll([
      "[class*='DraftBoard'] [class*='cell']",
      "[class*='draftBoard'] [class*='cell']",
      "[class*='draft-board'] [class*='cell']",
      "[class*='DraftBoard'] [class*='tile']",
      "[class*='draftBoard'] [class*='tile']",
      "[class*='DraftCell']",
      "[class*='draftCell']",
      "[class*='pickTile']",
      "[class*='DraftPick']",
      ".DraftBoard__pick"
    ].join(", "));

    boardCells.forEach((cell) => {
      if (isAvailablePlayersElement(cell)) return;
      const linkEl = cell.querySelector("a[href*='player'], a[href*='athlete'], [data-player-id]");
      if (linkEl) {
        tryPush(linkEl.getAttribute("title") || linkEl.textContent, cell);
      } else {
        tryPush(cell.textContent, cell);
      }
    });

    // Target 3: Top Banner
    const topBanners = document.querySelectorAll([
      "[class*='lastPick']",
      "[class*='recentPick']",
      "[class*='onTheClock']",
      "[class*='draftBanner']",
      "[class*='pick-banner']",
      "[class*='DraftBanner']"
    ].join(", "));

    topBanners.forEach((banner) => {
      if (isAvailablePlayersElement(banner)) return;
      const txt = banner.textContent || "";
      const m = txt.match(/(?:selected|drafted|last pick[:\s]*|recent pick[:\s]*|pick\s*#?\d+[:\s]*)\s*([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*,|\s*\(|$)/i);
      if (m && m[1]) tryPush(m[1], banner);
    });

    // Target 4: Yahoo Classic Results Table
    const yahooRows = document.querySelectorAll(".draft-results-table tr, .table-draft-results tbody tr, #draft-tables tbody tr");
    yahooRows.forEach((row) => {
      if (isAvailablePlayersElement(row)) return;
      const nameEl = row.querySelector(".name, .player, [data-tst='player-name'], a.F-link");
      if (nameEl) tryPush(nameEl.textContent, row);
    });

    return newlyFound;
  }

  // 8. Deep Scanner: Momentarily switches to Pick History or Board tab if on Players tab
  function deepScanPickHistory() {
    const msgEl = document.getElementById("hud-status-msg");
    if (msgEl) {
      msgEl.textContent = "Scanning full pick history...";
      msgEl.style.color = "#58a6ff";
    }

    // First scan visible toasts and elements
    const initialFound = [].concat(scanNotificationToasts(), scanBoardAndHistory());

    // Check if we are on ESPN and can toggle to "Pick History" or "Board"
    const tabs = Array.from(document.querySelectorAll("button, [role='tab'], a"));
    const histTab = tabs.find(t => (t.textContent || "").trim().toLowerCase() === "pick history");
    const boardTab = tabs.find(t => (t.textContent || "").trim().toLowerCase() === "board");
    const playersTab = tabs.find(t => (t.textContent || "").trim().toLowerCase() === "players");

    const targetTab = histTab || boardTab;
    if (targetTab && playersTab) {
      targetTab.click();
      setTimeout(() => {
        const foundFromTab = [].concat(scanNotificationToasts(), scanBoardAndHistory());
        playersTab.click();
        const totalNew = initialFound.length + foundFromTab.length;
        if (msgEl) {
          msgEl.textContent = `Deep scan complete: ${totalNew} new pick(s) synced. Total: ${pickCount}.`;
          msgEl.style.color = "#3fb950";
        }
      }, 200);
    } else {
      if (msgEl) {
        msgEl.textContent = `Scan complete: ${initialFound.length} new pick(s). Total: ${pickCount}.`;
        msgEl.style.color = "#3fb950";
      }
    }
  }

  // 9. Master Multi-Strategy Scanner
  function scanAndSyncAllPicks(isManual) {
    const toastPicks = scanNotificationToasts();
    const boardPicks = scanBoardAndHistory();
    const allFound = [].concat(toastPicks, boardPicks);

    if (isManual) {
      console.log(`[Draft Co-Pilot] Manual scan found ${allFound.length} new picks:`, allFound);
    }
    return allFound;
  }

  // 10. Session / URL Change Tracker
  function checkSessionUrlChange() {
    if (window.location.href !== currentSessionUrl) {
      console.log(`[Draft Co-Pilot] Session URL changed to: ${window.location.href}. Resetting local sync.`);
      currentSessionUrl = window.location.href;
      resetLocalSyncState("New draft room detected.");
    }
  }

  // 11. Periodic Polling & Mutation Observer
  setInterval(() => {
    checkSessionUrlChange();
    injectBadge();
    scanAndSyncAllPicks(false);
  }, 1000);

  // The draft timer mutates the page every second: coalesce scans instead of running one per mutation
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndSyncAllPicks(false);
    }, 300);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    injectBadge();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
      injectBadge();
    });
  }
})();
