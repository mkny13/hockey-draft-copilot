(function () {
  "use strict";

  // HTML Escaper for untrusted text
  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  if (typeof window !== "undefined") {
    window.escapeHtml = escapeHtml;
  }

  // Global State
  var state = {
    draftData: null,
    masterPlayers: [],
    evalResult: null,
    // Server-synced state:
    currentPick: 1,
    slot: 5,
    teams: 8,
    stdDev: 7.0,
    rosterLimits: { C: 4, LW: 4, RW: 4, D: 4, G: 2 },
    drafted: {},
    mine: {},
    pickHistory: [],
    pickHistoryIntegrity: { ok: true, checkedUpTo: 1, missing: [], repeated: [], duplicateNames: [] },
    // UI filters:
    posFilter: "ALL",
    searchQuery: "",
    hideDrafted: false,
    autoComparator: true
  };

  var ws = null;
  var tableTbody = document.getElementById("board-tbody");
  var shortlistContainer = document.getElementById("shortlist-container");
  var safeSleepersContainer = document.getElementById("safe-sleepers-container");
  var historyFeed = document.getElementById("history-feed");

  // Header Elements
  var dispCurrentPick = document.getElementById("disp-current-pick");
  var dispNextTurn = document.getElementById("disp-next-turn");
  var statusBadge = document.getElementById("status-badge");
  var selectSlot = document.getElementById("select-slot");
  var selectTeams = document.getElementById("select-teams");
  var filterSearch = document.getElementById("filter-search");
  var toggleHideDrafted = document.getElementById("toggle-hide-drafted");
  var playerCountDisplay = document.getElementById("player-count-display");

  // Comparator dropdowns
  var cmpSelectA = document.getElementById("compare-player-a");
  var cmpSelectB = document.getElementById("compare-player-b");
  var cmpVerdict = document.getElementById("comparator-verdict");
  var btnAutoMatchup = document.getElementById("btn-auto-matchup");

  // Monte Carlo simulation modal
  var mcModal = document.getElementById("montecarlo-modal");
  var mcTargetSelect = document.getElementById("mc-target-select");
  var mcSimulationsInput = document.getElementById("mc-simulations");
  var mcSimLabel = document.getElementById("mc-sim-label");
  var mcTargetSummary = document.getElementById("mc-target-summary");
  var mcResults = document.getElementById("montecarlo-results");
  var btnRunMonteCarlo = document.getElementById("btn-run-montecarlo");

  // Alerts (audio chimes + desktop notifications)
  var btnEnableAlerts = document.getElementById("btn-enable-alerts");
  var alertState = {
    enabled: false,
    audioCtx: null,
    lastOnClock: null,       // null = not yet observed, else true/false
    lastCriticalKey: null    // key of the last critical-cliff alert that fired
  };

  async function init() {
    var portEl = document.getElementById("sync-port");
    if (portEl && window.location.port) portEl.textContent = window.location.port;
    setupBookmarklet();
    setupEventListeners();
    setupWebSocket();
    updateAlertsButton();

    try {
      var res = await fetch("/draft_data.json");
      state.draftData = await res.json();
      state.masterPlayers = state.draftData.players || [];

      // Fetch latest server state
      var stateRes = await fetch("/api/state");
      var sData = await stateRes.json();
      applyServerState(sData);

      recomputeAndRender();
    } catch (err) {
      console.error("Error during initialization:", err);
    }
  }

  function setupWebSocket() {
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = protocol + "//" + location.host;
    ws = new WebSocket(wsUrl);

    var indicator = document.getElementById("sync-indicator");
    var statusText = document.getElementById("sync-status-text");

    ws.onopen = function () {
      indicator.style.background = "var(--green)";
      statusText.textContent = "Live Sync: Connected";
    };

    ws.onclose = function () {
      indicator.style.background = "var(--red)";
      statusText.textContent = "Live Sync: Disconnected";
      setTimeout(setupWebSocket, 3000);
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        // Every broadcast type (PICK_MADE, PICK_UNDONE, PICK_REPAIRED, RESET,
        // SETTINGS_UPDATED, INIT_STATE) carries the full state; apply it uniformly.
        if (msg.state) {
          applyServerState(msg.state);
        }
        // Fall back to the evaluation snapshot's integrity field if state omitted it
        if ((!msg.state || !msg.state.pickHistoryIntegrity) && msg.evaluation && msg.evaluation.pickHistoryIntegrity) {
          state.pickHistoryIntegrity = msg.evaluation.pickHistoryIntegrity;
        }
        if (msg.state || msg.evaluation) {
          recomputeAndRender();
        }
      } catch (e) {
        console.error("WS message parse error:", e);
      }
    };
  }

  // ===================== Alerts: Audio Chimes + Notifications =====================

  function getNotificationPermission() {
    if (typeof Notification === "undefined") return "unavailable";
    try {
      return Notification.permission; // "granted" | "denied" | "default"
    } catch (e) {
      return "unavailable";
    }
  }

  function updateAlertsButton() {
    if (!btnEnableAlerts) return;
    var perm = getNotificationPermission();
    if (!alertState.enabled) {
      btnEnableAlerts.textContent = "🔔 Enable Alerts";
      btnEnableAlerts.title = perm === "denied"
        ? "Notifications are blocked in browser settings, but audio chimes will still play. Click to enable alerts."
        : "Enable audio chimes and desktop notifications when you are ON THE CLOCK or a CRITICAL CLIFF is detected";
      btnEnableAlerts.style.color = "";
      return;
    }
    if (perm === "granted") {
      btnEnableAlerts.textContent = "🔔 Alerts: On";
      btnEnableAlerts.title = "Alerts active: chime + notification on your turn and on new critical cliffs";
      btnEnableAlerts.style.color = "var(--green)";
    } else if (perm === "denied") {
      btnEnableAlerts.textContent = "🔕 Alerts: Blocked";
      btnEnableAlerts.title = "Desktop notifications are blocked in browser settings — audio chimes are still active.";
      btnEnableAlerts.style.color = "var(--yellow)";
    } else if (perm === "unavailable") {
      btnEnableAlerts.textContent = "🔔 Alerts: Chimes Only";
      btnEnableAlerts.title = "This browser does not support the Notification API — audio chimes are active.";
      btnEnableAlerts.style.color = "var(--yellow)";
    } else {
      btnEnableAlerts.textContent = "🔔 Alerts: On";
      btnEnableAlerts.title = "Alerts active (chimes); notification permission still pending.";
      btnEnableAlerts.style.color = "var(--green)";
    }
  }

  function requestNotificationPermission(onDone) {
    if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
      onDone(getNotificationPermission());
      return;
    }
    var handled = false;
    var finish = function (p) {
      if (handled) return;
      handled = true;
      onDone(p === undefined ? getNotificationPermission() : p);
    };
    try {
      var maybePromise = Notification.requestPermission(finish);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish, function () { finish("denied"); });
      }
    } catch (e) {
      finish("denied");
    }
  }

  function enableAlerts() {
    // Must be invoked from a user gesture (header button click).
    ensureAudioContext();
    if (alertState.audioCtx && alertState.audioCtx.state === "suspended") {
      try { alertState.audioCtx.resume(); } catch (e) { /* ignore */ }
    }

    var finish = function () {
      alertState.enabled = true;
      updateAlertsButton();
      // If the draft is already on the clock when alerts are switched on,
      // let checkAlerts() fire exactly once for the current state.
      checkAlerts();
    };

    if (getNotificationPermission() === "default") {
      requestNotificationPermission(function () {
        updateAlertsButton();
        finish();
      });
    } else {
      updateAlertsButton();
      finish();
    }
  }

  function ensureAudioContext() {
    if (alertState.audioCtx) return alertState.audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      alertState.audioCtx = new Ctx();
    } catch (e) {
      console.error("Web Audio API unavailable:", e);
      alertState.audioCtx = null;
    }
    return alertState.audioCtx;
  }

  function playChime(kind) {
    if (!alertState.enabled) return;
    var ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }

    var t0 = ctx.currentTime;
    // Distinct melodic signatures:
    //  - "turn": pleasant ascending two-note ping (you're up)
    //  - "critical": urgent triple pulse (cliff detected)
    var notes = kind === "critical"
      ? [
          { freq: 880, start: 0.00, dur: 0.14, type: "square", vol: 0.14 },
          { freq: 660, start: 0.16, dur: 0.14, type: "square", vol: 0.14 },
          { freq: 880, start: 0.32, dur: 0.32, type: "square", vol: 0.14 }
        ]
      : [
          { freq: 659.25, start: 0.00, dur: 0.20, type: "sine", vol: 0.22 },  // E5
          { freq: 987.77, start: 0.22, dur: 0.40, type: "sine", vol: 0.22 }   // B5
        ];

    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, t0 + n.start);
      gain.gain.linearRampToValueAtTime(n.vol, t0 + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.05);
    }
  }

  function sendAlertNotification(title, body, tag) {
    if (!alertState.enabled) return;
    if (getNotificationPermission() !== "granted") return;
    try {
      var n = new Notification(title, {
        body: body,
        tag: tag,          // coalesces repeated notifications for the same event
        requireInteraction: false,
        silent: false
      });
      if (n && typeof n.close === "function") {
        setTimeout(function () {
          try { n.close(); } catch (e) { /* already closed */ }
        }, 10000);
      }
    } catch (e) {
      console.error("Notification error:", e);
    }
  }

  function checkAlerts() {
    if (!alertState.enabled) return;
    var res = state.evalResult;
    if (!res) return;

    // A full roster means no more decisions: never chime or notify again
    if (res.rosterComplete) {
      alertState.lastOnClock = false;
      alertState.lastCriticalKey = null;
      return;
    }

    // --- On the clock: fire on first observation and on each waiting -> on-clock transition
    var wasOnClock = alertState.lastOnClock;
    if (res.onTheClock) {
      if (wasOnClock !== true) {
        var best = (res.liveProtocol && res.liveProtocol.bestPick) ? res.liveProtocol.bestPick : null;
        var target = best ? best.name + " (" + best.posLabel + ")" : "your top remaining target";
        playChime("turn");
        sendAlertNotification(
          "🏒 ON THE CLOCK",
          "Pick #" + res.targetTurn + " is yours. Top target: " + target,
          "copilot-on-clock"
        );
      }
      alertState.lastOnClock = true;
    } else if (wasOnClock !== false) {
      alertState.lastOnClock = false;
    }

    // --- Critical cliff: fire when a NEW red alert appears; dedupe unchanged alert sets
    var redAlerts = res.redAlerts || [];
    if (redAlerts.length > 0) {
      var key = redAlerts.map(function (p) { return p.name; }).join("|") + "@" + res.targetTurn;
      if (alertState.lastCriticalKey !== key) {
        var a = redAlerts[0];
        var survPct = (a.survivalProb * 100).toFixed(0);
        var cliffText = (a.dropoff !== undefined && a.dropoff !== null) ? "+" + a.dropoff.toFixed(1) : "a";
        playChime("critical");
        sendAlertNotification(
          "🚨 CRITICAL CLIFF DETECTED",
          a.name + " (" + a.posLabel + ") MUST REACH now: " + cliffText +
            " VORP cliff, only " + survPct + "% survival to pick #" + res.targetTurn + ".",
          "copilot-critical"
        );
        alertState.lastCriticalKey = key;
      }
    } else {
      // Alert cleared — a future re-appearance counts as a new event.
      alertState.lastCriticalKey = null;
    }
  }

  // ===================== Server State =====================

  function applyServerState(s) {
    if (!s) return;
    state.currentPick = s.currentPick || 1;
    state.slot = s.slot || 5;
    state.teams = s.teams || 8;
    state.stdDev = s.stdDev || 7.0;
    state.drafted = s.drafted || {};
    state.mine = s.mine || {};
    state.pickHistory = s.pickHistory || [];
    if (s.rosterLimits) state.rosterLimits = s.rosterLimits;
    if (s.pickHistoryIntegrity) state.pickHistoryIntegrity = s.pickHistoryIntegrity;

    selectSlot.value = state.slot;
    selectTeams.value = state.teams;
    dispCurrentPick.textContent = state.currentPick;
  }

  function getRosterCounts() {
    return GameTheory.getRosterCounts(state.pickHistory, state.rosterLimits);
  }

  function recomputeAndRender() {
    if (!state.masterPlayers || !state.masterPlayers.length) return;

    var rosterCounts = getRosterCounts();

    // Evaluate board with enhanced Game Theory engine
    state.evalResult = GameTheory.evaluateBoard(state.masterPlayers, {
      currentPick: state.currentPick,
      slot: state.slot,
      teams: state.teams,
      stdDev: state.stdDev,
      drafted: state.drafted,
      mine: state.mine,
      rosterCounts: rosterCounts,
      rosterLimits: state.rosterLimits
    });

    renderHeader();
    renderBanner();
    renderIntegrityBanner();
    renderShortlist();
    renderComparatorOptions();
    renderSafeSleepers();
    renderBoardTable();
    renderSidebar(rosterCounts);

    // Fire audio chimes / desktop notifications for on-clock & critical-cliff events
    checkAlerts();
  }

  function renderHeader() {
    dispCurrentPick.textContent = state.currentPick;
    var res = state.evalResult;
    var onTheClock = res.onTheClock;

    if (res.draftComplete) {
      statusBadge.textContent = "✅ DRAFT COMPLETE";
      statusBadge.className = "status-badge waiting";
      dispNextTurn.textContent = "All picks are in";
    } else if (res.rosterComplete) {
      statusBadge.textContent = "✅ ROSTER COMPLETE";
      statusBadge.className = "status-badge waiting";
      dispNextTurn.textContent = "No more picks needed";
    } else if (onTheClock) {
      statusBadge.textContent = "🚨 ON THE CLOCK";
      statusBadge.className = "status-badge on-clock";
      dispNextTurn.textContent = "Round turn: Pick #" + res.targetTurn;
    } else {
      statusBadge.textContent = "WAITING (" + res.picksUntilTurn + " picks)";
      statusBadge.className = "status-badge waiting";
      dispNextTurn.textContent = "Your turn: Pick #" + res.targetTurn;
    }
  }

  function renderBanner() {
    var p = state.evalResult.liveProtocol;
    var banner = document.getElementById("live-banner");
    var headline = document.getElementById("banner-headline");
    var subtext = document.getElementById("banner-subtext");
    var quickAction = document.getElementById("banner-quick-action");

    banner.className = "live-direction-banner banner-" + p.alertType;
    headline.textContent = p.headline;
    subtext.textContent = p.subtext;

    quickAction.innerHTML = "";
    if (p.onTheClock && p.bestPick) {
      var btn = document.createElement("button");
      btn.className = "btn-card-draft";
      btn.style.fontSize = "13px";
      btn.style.padding = "6px 14px";
      btn.textContent = "Draft " + p.bestPick.name + " (My Team)";
      btn.onclick = function () {
        draftPlayer(p.bestPick, true);
      };
      quickAction.appendChild(btn);
    }
  }

  function renderIntegrityBanner() {
    var integrity = state.pickHistoryIntegrity;
    var banner = document.getElementById("integrity-banner");
    if (!banner) return;

    if (!integrity || integrity.ok) {
      banner.style.display = "none";
      return;
    }

    banner.style.display = "block";
    var textEl = document.getElementById("integrity-warning-text");
    var parts = [];

    if (integrity.missing && integrity.missing.length) {
      parts.push("Missing pick" + (integrity.missing.length > 1 ? "s" : "") + ": " +
        integrity.missing.map(function (n) { return "#" + n; }).join(", "));
    }
    if (integrity.repeated && integrity.repeated.length) {
      parts.push("Duplicate pick number" + (integrity.repeated.length > 1 ? "s" : "") + ": " +
        integrity.repeated.map(function (r) { return "#" + r.pickNumber + " (" + r.count + "x)"; }).join(", "));
    }
    if (integrity.duplicateNames && integrity.duplicateNames.length) {
      parts.push("Duplicate player" + (integrity.duplicateNames.length > 1 ? "s" : "") + ": " +
        integrity.duplicateNames.map(function (d) {
          return d.name + " (picks " + d.pickNumbers.map(function (n) { return "#" + n; }).join(", ") + ")";
        }).join("; "));
    }

    // textContent, not innerHTML: names in the report are untrusted draft-room text
    textEl.textContent = parts.join(" — ");

    populateRepairPlayerList();
  }

  function populateRepairPlayerList() {
    var datalist = document.getElementById("repair-player-list");
    if (!datalist) return;
    var rows = (state.evalResult && state.evalResult.availableRows) || [];
    datalist.innerHTML = "";
    for (var i = 0; i < rows.length; i++) {
      var opt = document.createElement("option");
      opt.value = rows[i].name;
      datalist.appendChild(opt);
    }
  }

  function submitRepairPick(pickNumber, name) {
    var errorDiv = document.getElementById("repair-pick-error");
    errorDiv.style.display = "none";
    errorDiv.textContent = "";

    return fetch("/api/repair-pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickNumber: pickNumber, name: name })
    })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          // Server error text rendered verbatim via textContent (never innerHTML)
          errorDiv.textContent = (result.data && result.data.error) || "Repair failed.";
          errorDiv.style.display = "block";
          return;
        }
        document.getElementById("repair-pick-number").value = "";
        document.getElementById("repair-pick-name").value = "";
        if (result.data.state) {
          applyServerState(result.data.state);
          recomputeAndRender();
        }
      })
      .catch(function (err) {
        errorDiv.textContent = "Network error: " + err.message;
        errorDiv.style.display = "block";
      });
  }

  function removePick(pickNumber) {
    fetch("/api/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickNumber: pickNumber })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.state) {
          applyServerState(data.state);
          recomputeAndRender();
        }
      })
      .catch(function (err) { console.error("Error removing pick:", err); });
  }

  function renderShortlist() {
    var list = state.evalResult.shortlist;
    var targetTurn = state.evalResult.targetTurn;
    shortlistContainer.innerHTML = "";
    document.getElementById("shortlist-count").textContent = list.length + " prioritized targets";

    if (!list.length) {
      var emptyMsg = state.evalResult.rosterComplete
        ? "Your roster is complete — no more picks needed."
        : "All top targets drafted.";
      shortlistContainer.innerHTML = "<div style='color:var(--text-muted); font-size:12px; padding:8px;'>" + emptyMsg + "</div>";
      return;
    }

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var card = document.createElement("div");
      card.className = "shortlist-card";

      var badgeClass = "badge-target";
      if (p.action === "MUST REACH (Cliff)") badgeClass = "badge-must-reach";
      else if (p.action === "NOW OR NEVER") badgeClass = "badge-now-or-never";
      else if (p.action === "WAIT (ADP Safe)") badgeClass = "badge-wait";

      var survPct = (p.survivalProb * 100).toFixed(0) + "%";
      var cliffText = p.dropoff > 0 ? "+" + p.dropoff.toFixed(1) : "-";

      // Human-readable reach risk pill
      var riskBadge = "";
      if (p.survivalProb < 0.25) {
        riskBadge = `<span style="color:#ff7b72; background:rgba(248,81,73,0.15); border:1px solid rgba(248,81,73,0.4); font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;" title="Only ${survPct} chance this player survives to your next turn (#${targetTurn})">🔥 GONE BY PICK #${targetTurn} (${survPct})</span>`;
      } else if (p.survivalProb < 0.50) {
        riskBadge = `<span style="color:#ffa657; background:rgba(240,136,62,0.15); border:1px solid rgba(240,136,62,0.4); font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;" title="High snipe risk (${survPct} survival to Pick #${targetTurn})">⚠️ HIGH SNIPE RISK (${survPct})</span>`;
      } else if (p.survivalProb < 0.75) {
        riskBadge = `<span style="color:#79c0ff; background:rgba(88,166,255,0.12); border:1px solid rgba(88,166,255,0.3); font-size:10px; font-weight:600; padding:2px 6px; border-radius:4px;" title="Moderate survival: ${survPct} to Pick #${targetTurn}">🎲 IN PLAY (${survPct})</span>`;
      } else {
        riskBadge = `<span style="color:#7ee787; background:rgba(63,185,80,0.15); border:1px solid rgba(63,185,80,0.4); font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;" title="Safe sleeper: ${survPct} chance to reach Pick #${targetTurn}">🛡️ SAFE SLEEPER (${survPct})</span>`;
      }

      var gt = p.gtTradeoff;
      var evText = (gt && gt.ev2) ? gt.ev2.toFixed(1) : "-";
      var gtEdgePill = "";
      if (gt && gt.netGain >= 2.0) {
        gtEdgePill = `<span class="badge badge-gt-winner" title="Game theory 2-round expected value edge over taking ${escapeHtml(gt.vsPlayer)}">⚡ +${gt.netGain.toFixed(1)} EV</span>`;
      } else if (gt && gt.netGain <= -10.0 && p.survivalProb > 0.50) {
        gtEdgePill = `<span class="badge badge-wait" title="Can safely fall to Turn #${targetTurn}">🛡️ SAFE TO WAIT</span>`;
      }

      var adviceRow = "";
      if (gt && (gt.advice || gt.reason)) {
        adviceRow = `
          <div class="card-gt-row">
            <span class="gt-icon">💡</span>
            <span style="flex:1;">${escapeHtml(gt.advice || gt.reason)}</span>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="card-rank">#${i + 1}</div>
        <div class="card-info" style="flex: 1;">
          <div class="card-name-row" style="flex-wrap: wrap; gap: 6px; align-items:center;">
            <span class="card-name" style="font-size:14px; font-weight:700;">${escapeHtml(p.name)}</span>
            <span class="card-pos">${escapeHtml(p.posLabel)}</span>
            <span class="card-team">${escapeHtml(p.team)}</span>
            <span class="badge ${badgeClass}">${escapeHtml(p.action)}</span>
            ${gtEdgePill}
            ${riskBadge}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
            <span>Tier Cliff: <b style="color:${p.dropoff >= 15 ? 'var(--red)' : 'var(--text-main)'};">${cliffText} pts</b></span>
            <span>ESPN ADP: <b style="color:var(--text-main);">${p.adp ? p.adp.toFixed(1) : 'N/A'}</b></span>
            ${p.adpDelta >= 15 ? `<span style="color:var(--green);">Arbitrage: +${p.adpDelta.toFixed(1)}</span>` : ''}
          </div>
          ${adviceRow}
        </div>
        <div class="card-metrics" style="gap: 12px;">
          <div class="card-metric" style="text-align:right;">
            <span style="font-weight:800; font-size:15px; color:var(--accent);">${p.adjVorp.toFixed(1)}</span>
            <span class="metric-label">VORP</span>
          </div>
          <div class="card-metric" style="text-align:right;">
            <span style="font-weight:800; font-size:14px; color:${gt && gt.netGain >= 2.0 ? 'var(--green)' : 'var(--text-main)'};">${evText}</span>
            <span class="metric-label">2-Rnd EV</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-card-draft" data-id="${escapeHtml(p.id)}" title="Draft to My Team" style="padding:5px 10px; font-size:12px;">+ Mine</button>
          <button class="btn-card-taken" data-id="${escapeHtml(p.id)}" title="Taken by Opponent" style="padding:5px 8px; font-size:12px;">Taken</button>
        </div>
      `;

      (function (player) {
        card.querySelector(".btn-card-draft").onclick = function (e) {
          e.stopPropagation();
          draftPlayer(player, true);
        };
        card.querySelector(".btn-card-taken").onclick = function (e) {
          e.stopPropagation();
          draftPlayer(player, false);
        };
      })(p);

      shortlistContainer.appendChild(card);
    }
  }

  function renderComparatorOptions() {
    var available = state.evalResult.availableRows.slice(0, 40);
    var curValA = cmpSelectA.value;
    var curValB = cmpSelectB.value;

    cmpSelectA.innerHTML = '<option value="">Select Sleeper (A)...</option>';
    cmpSelectB.innerHTML = '<option value="">Select Imminent (B)...</option>';

    for (var i = 0; i < available.length; i++) {
      var p = available[i];
      var optA = document.createElement("option");
      optA.value = p.name;
      optA.textContent = p.name + " (" + p.posLabel + ", ESPN ADP " + (p.adp || "N/A") + ")";
      cmpSelectA.appendChild(optA);

      var optB = document.createElement("option");
      optB.value = p.name;
      optB.textContent = p.name + " (" + p.posLabel + ", ESPN ADP " + (p.adp || "N/A") + ")";
      cmpSelectB.appendChild(optB);
    }

    var topMatchup = state.evalResult.topMatchup;
    var isDraftedA = curValA && (state.drafted[curValA] || state.mine[curValA]);
    var isDraftedB = curValB && (state.drafted[curValB] || state.mine[curValB]);

    if (state.autoComparator || !curValA || !curValB || isDraftedA || isDraftedB) {
      if (topMatchup && topMatchup.playerA && topMatchup.playerB) {
        curValA = topMatchup.playerA.name;
        curValB = topMatchup.playerB.name;
      }
    }

    if (curValA) cmpSelectA.value = curValA;
    if (curValB) cmpSelectB.value = curValB;
    updateAutoComparatorBtn();
    calculateTradeoff();
  }

  function updateAutoComparatorBtn() {
    if (!btnAutoMatchup) return;
    if (state.autoComparator) {
      btnAutoMatchup.style.background = "rgba(63, 185, 80, 0.2)";
      btnAutoMatchup.style.borderColor = "var(--green)";
      btnAutoMatchup.style.color = "#7ee787";
      btnAutoMatchup.textContent = "⚡ Auto ON";
      btnAutoMatchup.title = "Auto-tracking top board dilemma. Click to unlock.";
    } else {
      btnAutoMatchup.style.background = "rgba(88, 166, 255, 0.15)";
      btnAutoMatchup.style.borderColor = "rgba(88, 166, 255, 0.4)";
      btnAutoMatchup.style.color = "var(--accent)";
      btnAutoMatchup.textContent = "⚡ Auto";
      btnAutoMatchup.title = "Click to reset to automated top board dilemma";
    }
  }

  function calculateTradeoff() {
    var nameA = cmpSelectA.value;
    var nameB = cmpSelectB.value;
    if (!nameA || !nameB || nameA === nameB) {
      cmpVerdict.innerHTML = "Select two distinct players to evaluate the Generalized EVONA trade-off.";
      return;
    }

    var rowA = state.evalResult.availableRows.find(p => p.name === nameA);
    var rowB = state.evalResult.availableRows.find(p => p.name === nameB);
    if (!rowA || !rowB) return;

    var targetTurn = state.evalResult.targetTurn;
    var cmp = GameTheory.comparePlayersGameTheory(rowA, rowB, null, null, targetTurn, state.stdDev, state.evalResult.availableRows);
    if (!cmp) return;

    var color = cmp.waitOnA ? "var(--green)" : "var(--orange)";
    cmpVerdict.innerHTML = `
      <div style="font-weight:700; color:${color}; margin-bottom:4px;">${escapeHtml(cmp.verdict)}</div>
      <div style="color:var(--text-dim); font-size:10px; font-family:var(--font-mono);">
        Option 1 (Take ${escapeHtml(rowB.name)}, gamble on ${escapeHtml(rowA.name)}): EV = ${cmp.evOption1.toFixed(1)}<br>
        Option 2 (Take ${escapeHtml(rowA.name)} now, gamble on ${escapeHtml(rowB.name)}): EV = ${cmp.evOption2.toFixed(1)} (ΔEV: ${cmp.deltaEV > 0 ? '+' : ''}${cmp.deltaEV.toFixed(1)})
      </div>
    `;
  }

  function renderSafeSleepers() {
    var sleepers = state.evalResult.waitSafePlayers;
    safeSleepersContainer.innerHTML = "";

    if (!sleepers.length) {
      safeSleepersContainer.innerHTML = "<span style='color:var(--text-dim); font-size:11px;'>No safe late sleepers on current board.</span>";
      return;
    }

    for (var i = 0; i < sleepers.length; i++) {
      var p = sleepers[i];
      var pill = document.createElement("div");
      pill.className = "sleeper-pill";
      var survPct = (p.survivalProb * 100).toFixed(0) + "%";
      pill.innerHTML = `
        <span>${escapeHtml(p.name)} (${escapeHtml(p.posLabel)})</span>
        <span style="font-family:var(--font-mono); font-weight:bold;">${survPct}</span>
      `;
      pill.title = "ESPN ADP: " + (p.adp ? p.adp.toFixed(1) : "N/A") + " | VORP: " + p.adjVorp.toFixed(1) + " | Will safely survive to turn!";
      safeSleepersContainer.appendChild(pill);
    }
  }

  var ACTION_BUTTONS_HTML = `
            <button class="btn-icon btn-tbl-mine" title="Draft to My Team" style="display:inline-flex; width:26px; color:#7ee787;">+</button>
            <button class="btn-icon btn-tbl-draft" title="Drafted by Opponent" style="display:inline-flex; width:26px; color:var(--text-muted);">✓</button>
          `;
  var ACTION_MYTEAM_HTML = `<span style="font-size:10px; color:var(--text-dim);">MY TEAM</span>`;
  var ACTION_TAKEN_HTML = `<span style="font-size:10px; color:var(--text-dim);">TAKEN</span>`;

  var ACTION_BADGE_CLASSES = {
    "MUST REACH (Cliff)": "badge-must-reach",
    "NOW OR NEVER": "badge-now-or-never",
    "WAIT (ADP Safe)": "badge-wait"
  };

  function renderBoardTable() {
    var rows = (state.evalResult && state.evalResult.allRows) || [];
    tableTbody.innerHTML = "";

    var filter = state.posFilter;
    var q = state.searchQuery.toLowerCase().trim();
    var hideDrafted = state.hideDrafted;

    var displayedCount = 0;
    var fragment = document.createDocumentFragment();

    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];

      if (hideDrafted && p.isDrafted) continue;

      if (filter !== "ALL") {
        if (!p.pos || p.pos.indexOf(filter) === -1) continue;
      }

      if (q) {
        var nameMatch = p.name.toLowerCase().includes(q);
        var teamMatch = p.team.toLowerCase().includes(q);
        if (!nameMatch && !teamMatch) continue;
      }

      displayedCount++;

      var tr = document.createElement("tr");
      tr.setAttribute("data-name", p.name);
      if (p.isMine) tr.className = "is-myteam";
      else if (p.isDrafted) tr.className = "is-drafted";

      var badgeClass = p.isMine
        ? "badge-myteam"
        : (p.isDrafted
          ? "badge-drafted"
          : (ACTION_BADGE_CLASSES[p.action] || "badge-target"));

      var survText = p.isDrafted ? "-" : (p.survivalProb * 100).toFixed(0) + "%";
      var cliffText = p.dropoff > 0 ? "+" + p.dropoff.toFixed(1) : "-";
      var deltaText = p.adpDelta > 0 ? "+" + p.adpDelta.toFixed(1) : (p.adpDelta < 0 ? p.adpDelta.toFixed(1) : "-");

      var fpVal = p.fp ? p.fp.toFixed(1) : "-";

      tr.innerHTML = `
        <td style="color:var(--text-dim);">${p.rank || (i + 1)}</td>
        <td style="font-weight:600;">
          ${escapeHtml(p.name)} <span style="font-size:11px; color:var(--text-muted); font-weight:normal;">${escapeHtml(p.team)}</span>
        </td>
        <td><span class="card-pos">${escapeHtml(p.posLabel)}</span></td>
        <td><span class="badge ${badgeClass}">${escapeHtml(p.action)}</span></td>
        <td class="num" style="color:${p.survivalProb < 0.2 ? 'var(--orange)' : 'var(--green)'};">${survText}</td>
        <td class="num" style="font-weight:700; color:var(--accent);">${p.adjVorp.toFixed(1)}</td>
        <td class="num">${p.rawVorp.toFixed(1)}</td>
        <td class="num" style="color:${p.dropoff >= 15 ? 'var(--red)' : 'var(--text-main)'}; font-weight:${p.dropoff >= 15 ? 'bold' : 'normal'};">${cliffText}</td>
        <td class="num">${p.adp ? p.adp.toFixed(1) : '-'}</td>
        <td class="num" style="color:${p.adpDelta >= 20 ? 'var(--green)' : 'var(--text-muted)'};">${deltaText}</td>
        <td class="num" style="color:var(--text-dim);">${fpVal}</td>
        <td style="text-align:center;">
          ${!p.isDrafted ? ACTION_BUTTONS_HTML : (p.isMine ? ACTION_MYTEAM_HTML : ACTION_TAKEN_HTML)}
        </td>
      `;

      (function (player) {
        var btnMine = tr.querySelector(".btn-tbl-mine");
        if (btnMine) {
          btnMine.onclick = function (e) {
            e.stopPropagation();
            draftPlayer(player, true);
          };
        }
        var btnDraft = tr.querySelector(".btn-tbl-draft");
        if (btnDraft) {
          btnDraft.onclick = function (e) {
            e.stopPropagation();
            draftPlayer(player, false);
          };
        }

        tr.onclick = function (e) {
          if (e.target.closest("button")) return;
          if (e.detail > 1) return;
          draftPlayer(player, false);
        };
        tr.ondblclick = function (e) {
          if (e.target.closest("button")) return;
          draftPlayer(player, true);
        };
      })(p);

      fragment.appendChild(tr);
    }

    tableTbody.appendChild(fragment);
    playerCountDisplay.textContent = displayedCount + " shown (" + rows.length + " total)";
  }

  if (typeof window !== "undefined") {
    window.renderBoardTable = renderBoardTable;
  }

  function renderSidebar(rosterCounts) {
    var limits = state.rosterLimits;
    var posList = ["c", "f", "d", "g"];
    var totalDrafted = 0;
    var totalVorp = 0;

    var flexTotal = limits.FLEX || 0;
    var flexUsed = GameTheory.getFlexUsed(rosterCounts, limits);

    for (var i = 0; i < posList.length; i++) {
      var p = posList[i];
      var upper = p.toUpperCase();
      var count = rosterCounts[upper] || 0;
      var limit = limits[upper] || 4;
      var card = document.getElementById("card-pos-" + p);
      var countSpan = document.getElementById("count-" + p);
      var warnDiv = document.getElementById("warn-" + p);

      countSpan.textContent = count + " / " + limit;

      if (count >= limit && flexUsed >= flexTotal) {
        card.classList.add("capped");
        warnDiv.textContent = "⚠️ Capped: extras are bench depth (~30% value)";
      } else if (count > limit) {
        card.classList.remove("capped");
        warnDiv.textContent = "Flex/bench slots used: " + flexUsed + " / " + flexTotal;
      } else {
        card.classList.remove("capped");
        warnDiv.textContent = "";
      }
    }

    // Total VORP captured by my team
    var rowMap = state.evalResult && state.evalResult._rowMap;
    if (!rowMap && state.evalResult && state.evalResult.allRows) {
      rowMap = new Map();
      var allRows = state.evalResult.allRows;
      for (var r = 0; r < allRows.length; r++) {
        if (!rowMap.has(allRows[r].name)) {
          rowMap.set(allRows[r].name, allRows[r]);
        }
      }
      state.evalResult._rowMap = rowMap;
    }

    for (var j = 0; j < state.pickHistory.length; j++) {
      var pick = state.pickHistory[j];
      if (pick.isMine) {
        totalDrafted++;
        var match = rowMap ? rowMap.get(pick.name) : null;
        if (match) {
          totalVorp += match.rawVorp;
        }
      }
    }

    var leagueSlots = (state.draftData && state.draftData.config && state.draftData.config.league && state.draftData.config.league.slots) || {};
    var totalSlots = Object.keys(leagueSlots).reduce(function (sum, k) { return sum + (leagueSlots[k] || 0); }, 0);
    document.getElementById("roster-total-count").textContent = totalDrafted + " / " + (totalSlots || 18);
    document.getElementById("stat-total-vorp").textContent = totalVorp.toFixed(1);

    // Pick history feed
    historyFeed.innerHTML = "";
    document.getElementById("history-total-picks").textContent = state.pickHistory.length + " picks";

    var reversed = [...state.pickHistory].reverse();
    for (var k = 0; k < reversed.length; k++) {
      var item = reversed[k];
      var div = document.createElement("div");
      div.className = "history-item " + (item.isMine ? "is-mine" : "");
      div.innerHTML = `
        <div>
          <span class="hist-pick">#${item.pickNumber}</span>
          <span style="font-weight:600;">${escapeHtml(item.name)}</span>
          <span style="font-size:10px; color:var(--text-dim); margin-left:4px;">${item.isMine ? '(ME)' : ''}</span>
          ${item.repaired ? '<span class="hist-repaired-badge">REPAIRED</span>' : ''}
        </div>
        <button class="btn-icon hist-remove-btn" title="Remove Pick #${item.pickNumber} from history">×</button>
      `;
      (function (pickNumber) {
        div.querySelector(".hist-remove-btn").onclick = function (e) {
          e.stopPropagation();
          removePick(pickNumber);
        };
      })(item.pickNumber);
      historyFeed.appendChild(div);
    }
  }

  function draftPlayer(player, isMine) {
    if (!player || !player.name) return;
    fetch("/api/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: player.name,
        team: player.team,
        pos: player.pos,
        isMine: isMine,
        manual: true // an explicit click in the app overrides the snake schedule
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.state) {
        applyServerState(data.state);
        recomputeAndRender();
      }
    })
    .catch(err => console.error("Error drafting player:", err));
  }

  function undoLastPick() {
    fetch("/api/undo", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        if (data.state) {
          applyServerState(data.state);
          recomputeAndRender();
        }
      })
      .catch(err => console.error("Error undoing pick:", err));
  }

  function resetDraft() {
    if (!confirm("Are you sure you want to reset the entire draft? All picks will be cleared.")) {
      return;
    }
    fetch("/api/reset", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        if (data.state) {
          applyServerState(data.state);
          recomputeAndRender();
        }
      })
      .catch(err => console.error("Error resetting draft:", err));
  }

  function renderReport(report) {
    var content = document.getElementById("report-content");
    var s = report.summary;
    var bal = report.positionalBalance;

    function fmtSigned(v, digits) {
      var d = digits === undefined ? 1 : digits;
      return (v >= 0 ? "+" : "") + v.toFixed(d);
    }
    function surplusColor(v) {
      return v > 0 ? "var(--green)" : (v < 0 ? "var(--red)" : "var(--text-muted)");
    }
    function statusColor(status) {
      if (status.indexOf("EMPTY") === 0) return "var(--red)";
      if (status === "LIGHT") return "var(--orange)";
      if (status === "FILLED") return "var(--green)";
      return "var(--yellow)"; // OVER
    }

    var html = "";

    // 1. Headline grade + VORP captured vs expected
    var gradeBadge = s.grade
      ? "<span style='font-size:34px; font-weight:800; color:" + surplusColor(s.totalSurplus) + ";'>" + escapeHtml(s.grade) + "</span>" +
        "<div style='font-size:10px; color:var(--text-muted); margin-top:2px;'>" + escapeHtml(s.gradeLabel) + "</div>"
      : "<span style='font-size:20px; color:var(--text-muted);'>—</span>" +
        "<div style='font-size:10px; color:var(--text-muted); margin-top:6px;'>No picks drafted to your team yet</div>";

    html += "<div style='display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:18px;'>" +
      "<div style='background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:12px; text-align:center;'>" +
        gradeBadge + "</div>" +
      "<div style='background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:12px; text-align:center;'>" +
        "<div style='font-size:10px; color:var(--text-dim); text-transform:uppercase;'>VORP Captured</div>" +
        "<div style='font-size:22px; font-weight:700; color:var(--accent);'>" + s.totalCapturedVorp.toFixed(1) + "</div>" +
        "<div style='font-size:10px; color:var(--text-dim);'>" + s.picksCount + " pick(s)</div></div>" +
      "<div style='background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:12px; text-align:center;'>" +
        "<div style='font-size:10px; color:var(--text-dim); text-transform:uppercase;'>Expected (slot ADP)</div>" +
        "<div style='font-size:22px; font-weight:700; color:var(--text-main);'>" + s.totalExpectedVorp.toFixed(1) + "</div>" +
        "<div style='font-size:10px; color:var(--text-dim);'>per draft slot</div></div>" +
      "<div style='background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:12px; text-align:center;'>" +
        "<div style='font-size:10px; color:var(--text-dim); text-transform:uppercase;'>Surplus Value</div>" +
        "<div style='font-size:22px; font-weight:700; color:" + surplusColor(s.totalSurplus) + ";'>" + fmtSigned(s.totalSurplus) + "</div>" +
        "<div style='font-size:10px; color:var(--text-dim);'>" + (s.captureRatio !== null ? (s.captureRatio * 100).toFixed(0) + "% of expected" : "no data") + "</div></div>" +
      "</div>";


    // 2. My picks: captured vs expected per slot
    html += "<div style='font-weight:700; font-size:12px; color:var(--accent); margin-bottom:6px;'>🎯 My Picks: Captured vs Expected VORP</div>";
    if (report.myPicks.length) {
      html += "<table style='width:100%; border-collapse:collapse; font-size:11px; margin-bottom:18px;'>" +
        "<thead><tr style='color:var(--text-dim); text-transform:uppercase; font-size:9px; text-align:left;'>" +
        "<th style='padding:4px 6px;'>#</th><th style='padding:4px 6px;'>Player</th><th style='padding:4px 6px;'>Pos</th>" +
        "<th style='padding:4px 6px; text-align:right;'>ADP</th><th style='padding:4px 6px; text-align:right;'>VORP</th>" +
        "<th style='padding:4px 6px; text-align:right;'>Expected</th><th style='padding:4px 6px; text-align:right;'>Surplus</th>" +
        "</tr></thead><tbody>";
      for (var i = 0; i < report.myPicks.length; i++) {
        var mp = report.myPicks[i];
        html += "<tr style='border-top:1px solid var(--panel-border);'>" +
          "<td style='padding:5px 6px; color:var(--text-dim);'>" + mp.pickNumber + "</td>" +
          "<td style='padding:5px 6px; font-weight:600;'>" + escapeHtml(mp.name) + "</td>" +
          "<td style='padding:5px 6px;'><span class='card-pos'>" + escapeHtml(mp.posLabel) + "</span></td>" +
          "<td style='padding:5px 6px; text-align:right; color:var(--text-muted);'>" + (mp.adp !== null ? mp.adp.toFixed(1) : "-") + "</td>" +
          "<td style='padding:5px 6px; text-align:right;'>" + mp.vorp.toFixed(1) + "</td>" +
          "<td style='padding:5px 6px; text-align:right; color:var(--text-muted);'>" + mp.expectedVorp.toFixed(1) + "</td>" +
          "<td style='padding:5px 6px; text-align:right; font-weight:700; color:" + surplusColor(mp.surplus) + ";'>" + fmtSigned(mp.surplus) + "</td>" +
          "</tr>";
      }
      html += "</tbody></table>";
    } else {
      html += "<div style='font-size:11px; color:var(--text-muted); padding:10px; margin-bottom:18px; background:var(--bg-dark); border-radius:6px;'>No picks drafted to your team yet. Use \"+ Mine\" or double-click players during the draft, then reopen this report.</div>";
    }


    // 3. Best value steals by ADP Delta
    html += "<div style='font-weight:700; font-size:12px; color:var(--green); margin-bottom:6px;'>💎 Best Value Steals (Highest ADP Delta)</div>";
    if (report.steals.length) {
      html += "<div style='display:flex; flex-direction:column; gap:6px; margin-bottom:18px;'>";
      var top = report.steals.slice(0, 5);
      for (var k = 0; k < top.length; k++) {
        var st = top[k];
        html += "<div style='display:flex; justify-content:space-between; align-items:center; background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:8px 10px;'>" +
          "<div style='font-size:11px;'>" +
            "<span style='font-weight:700;'>" + escapeHtml(st.name) + "</span>" +
            "<span style='font-size:10px; color:var(--text-dim); margin-left:6px;'>" + escapeHtml(st.posLabel) + " · Pick #" + st.pickNumber + (st.isMine ? " · <b style='color:var(--green);'>MY TEAM</b>" : "") + "</span>" +
          "</div>" +
          "<div style='font-size:11px; color:var(--text-muted);'>ADP " + (st.adp !== null ? st.adp.toFixed(1) : "-") + " → <b style='color:var(--green); font-size:13px;'>" + fmtSigned(st.adpDelta) + " delta</b></div>" +
          "</div>";
      }
      html += "</div>";
    } else {
      html += "<div style='font-size:11px; color:var(--text-muted); padding:10px; margin-bottom:18px; background:var(--bg-dark); border-radius:6px;'>No value steals yet — every pick so far was at or ahead of consensus ADP.</div>";
    }

    // 4. Positional balance
    html += "<div style='font-weight:700; font-size:12px; color:var(--yellow); margin-bottom:6px;'>⚖️ Positional Balance (My Roster)</div>";
    html += "<div style='display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:10px;'>";
    for (var b = 0; b < bal.slots.length; b++) {
      var slot = bal.slots[b];
      html += "<div style='background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:10px; text-align:center;'>" +
        "<div style='font-weight:700; font-size:13px;'>" + escapeHtml(slot.pos) + "</div>" +
        "<div style='font-size:18px; font-weight:700; color:" + statusColor(slot.status) + ";'>" + slot.count + " / " + slot.limit + "</div>" +
        "<div style='font-size:9px; color:" + statusColor(slot.status) + "; margin-top:2px;'>" + escapeHtml(slot.status) + "</div>" +
        "</div>";
    }
    html += "</div>";
    html += "<div style='font-size:11px; color:var(--text-muted); margin-bottom:6px;'>" + escapeHtml(bal.verdict) + "</div>";

    content.innerHTML = html;
  }

  function fetchAndRenderReport() {
    var content = document.getElementById("report-content");
    if (!content) return;
    fetch("/api/report")
      .then(r => r.json())
      .then(data => {
        if (!data.success || !data.report) throw new Error("Invalid report payload");
        renderReport(data.report);
      })
      .catch(err => {
        console.error("Error loading post-draft report:", err);
        content.innerHTML = "<div style='font-size:12px; color:var(--red); padding:16px; text-align:center;'>Could not load the post-draft report. Make sure the server is running and try again.</div>";
      });
  }


  /* ============ Monte Carlo Round-by-Round Survival (Issue #4) ============ */

  var MC_ROUND_TARGETS = [3, 4, 5];

  function renderMonteCarloTargets() {
    if (!mcTargetSelect) return;
    var rows = (state.evalResult && state.evalResult.availableRows) || [];
    var selected = mcTargetSelect.value;

    var sorted = rows.slice().sort(function (a, b) { return b.adjVorp - a.adjVorp; }).slice(0, 60);
    sorted.sort(function (a, b) { return (a.adp || 999) - (b.adp || 999); });

    mcTargetSelect.innerHTML = "";
    if (!sorted.length) {
      var optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = "No available players on board";
      mcTargetSelect.appendChild(optEmpty);
      return;
    }

    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name + " (" + p.posLabel + ", ADP " + (p.adp ? p.adp.toFixed(1) : "N/A") + ", VORP " + p.adjVorp.toFixed(1) + ")";
      mcTargetSelect.appendChild(opt);
    }

    if (selected && sorted.some(function (x) { return x.name === selected; })) {
      mcTargetSelect.value = selected;
    }
  }

  function mcVerdict(prob) {
    if (prob === null || prob === undefined) return { label: "Round already passed", color: "var(--text-dim)" };
    if (prob >= 0.75) return { label: "🛡️ Safe to wait", color: "var(--green)" };
    if (prob >= 0.45) return { label: "🎯 Coin flip — monitor the board", color: "var(--yellow)" };
    if (prob >= 0.20) return { label: "⚠️ At risk — likely gone", color: "var(--orange)" };
    return { label: "🚨 Will be drafted — must reach now", color: "var(--red)" };
  }

  function runMonteCarloSimulation() {
    if (!mcResults || !mcTargetSelect) return;
    var targetName = mcTargetSelect.value;
    if (!targetName) {
      mcResults.innerHTML = "<div style='font-size:12px; color:var(--orange); padding:14px; text-align:center;'>Select a sleeper target first.</div>";
      return;
    }

    var simulations = Math.min(5000, Math.max(50, parseInt(mcSimulationsInput.value, 10) || 500));
    mcSimulationsInput.value = simulations;
    if (mcSimLabel) mcSimLabel.textContent = simulations;
    mcResults.innerHTML = "<div style='font-size:12px; color:var(--accent); padding:14px; text-align:center;'>🎲 Simulating " + simulations + " drafts with normal ADP noise...</div>";
    if (btnRunMonteCarlo) btnRunMonteCarlo.disabled = true;

    // Defer so the "simulating" state paints before the synchronous engine runs
    setTimeout(function () {
      try {
        var res = GameTheory.roundSurvivalProbabilities(targetName, MC_ROUND_TARGETS, simulations, {
          players: state.masterPlayers,
          teams: state.teams,
          slot: state.slot,
          currentPick: state.currentPick,
          drafted: state.drafted,
          mine: state.mine,
          noiseStd: state.stdDev
        });
        renderMonteCarloResults(res, simulations);
      } catch (err) {
        console.error("Monte Carlo simulation error:", err);
        mcResults.innerHTML = "<div style='font-size:12px; color:var(--red); padding:14px; text-align:center;'>Simulation failed: " + escapeHtml(err.message) + "</div>";
      } finally {
        if (btnRunMonteCarlo) btnRunMonteCarlo.disabled = false;
      }
    }, 30);
  }

  function renderMonteCarloResults(res, simulations) {
    if (!mcResults) return;
    if (!res) {
      mcResults.innerHTML = "<div style='font-size:12px; color:var(--red); padding:14px; text-align:center;'>Target not found on the current board.</div>";
      return;
    }

    if (res.drafted) {
      mcResults.innerHTML = "<div style='font-size:12px; color:var(--red); padding:14px; text-align:center;'>" +
        escapeHtml(res.name) + " is already drafted — survival probability is 0% in every round.</div>";
      return;
    }

    var html = "";
    html += "<div style='display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:6px;'>" +
      "<div style='font-weight:700; font-size:13px;'>" + escapeHtml(res.name) +
      " <span style='font-size:11px; color:var(--text-muted); font-weight:normal;'>ADP " +
      (res.adp !== null && res.adp !== undefined ? res.adp.toFixed(1) : "N/A") +
      " | σ = " + res.noiseStd.toFixed(1) + "</span></div>" +
      "<div style='font-size:10px; color:var(--text-dim); font-family:var(--font-mono);'>" + simulations +
      " sims | Pick #" + res.currentPick + " | " + res.teams + " teams</div>" +
      "</div>";

    for (var i = 0; i < MC_ROUND_TARGETS.length; i++) {
      var round = MC_ROUND_TARGETS[i];
      var prob = res.rounds[round];
      var myPick = res.myPicks[round];
      var pct = (prob === null || prob === undefined) ? null : Math.round(prob * 100);
      var verdict = mcVerdict(prob);
      var barWidth = (prob === null || prob === undefined) ? 0 : Math.max(2, Math.round(prob * 100));

      html += "<div style='margin-bottom:10px; background:var(--bg-dark); border:1px solid var(--panel-border); border-radius:6px; padding:10px;'>";
      html += "<div style='display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;'>";
      html += "<div style='font-size:12px; font-weight:700;'>Round " + round +
        " <span style='font-size:10px; color:var(--text-muted); font-weight:normal;'>(" +
        (myPick !== undefined ? "your pick #" + myPick : "pick already passed") + ")</span></div>";
      html += "<div style='font-family:var(--font-mono); font-size:14px; font-weight:700; color:" + verdict.color + ";'>" +
        (pct === null ? "—" : pct + "%") + "</div>";
      html += "</div>";
      html += "<div style='height:8px; background:rgba(255,255,255,0.06); border-radius:4px; overflow:hidden; margin-bottom:6px;'>";
      html += "<div style='height:100%; width:" + barWidth + "%; background:" + verdict.color + "; border-radius:4px;'></div>";
      html += "</div>";
      html += "<div style='font-size:11px; color:" + verdict.color + ";'>" + escapeHtml(verdict.label) + "</div>";
      html += "</div>";
    }

    html += "<div style='font-size:10px; color:var(--text-dim); margin-top:4px; line-height:1.5;'>" +
      "Model: opponents draft the best available player by their own noisy ADP draw (N(ADP, " + res.noiseStd.toFixed(1) + "²)). " +
      "Your picks are modeled as proxy picks (you wait on the target), so these are conservative wait-and-see odds.</div>";

    mcResults.innerHTML = html;
  }

  function openMonteCarloModal() {
    if (!mcModal) return;
    renderMonteCarloTargets();
    if (mcSimulationsInput && mcSimLabel) {
      mcSimLabel.textContent = parseInt(mcSimulationsInput.value, 10) || 500;
    }
    mcModal.style.display = "flex";
  }

  function updateSettings(delta) {
    var payload = {};
    if (delta.slot !== undefined) payload.slot = delta.slot;
    if (delta.teams !== undefined) payload.teams = delta.teams;
    if (delta.currentPick !== undefined) payload.currentPick = delta.currentPick;

    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(data => {
      if (data.state) {
        applyServerState(data.state);
        recomputeAndRender();
      }
    })
    .catch(err => console.error("Error updating settings:", err));
  }

  function setupEventListeners() {
    document.getElementById("btn-inc-pick").onclick = function () {
      updateSettings({ currentPick: state.currentPick + 1 });
    };
    document.getElementById("btn-dec-pick").onclick = function () {
      if (state.currentPick > 1) {
        updateSettings({ currentPick: state.currentPick - 1 });
      }
    };

    selectSlot.onchange = function () {
      updateSettings({ slot: parseInt(selectSlot.value, 10) });
    };
    selectTeams.onchange = function () {
      updateSettings({ teams: parseInt(selectTeams.value, 10) });
    };

    document.getElementById("btn-undo-pick").onclick = undoLastPick;
    document.getElementById("btn-reset-draft").onclick = resetDraft;

    var repairForm = document.getElementById("repair-pick-form");
    if (repairForm) {
      repairForm.onsubmit = function (e) {
        e.preventDefault();
        var pickNumber = parseInt(document.getElementById("repair-pick-number").value, 10);
        var name = document.getElementById("repair-pick-name").value.trim();
        submitRepairPick(pickNumber, name);
      };
    }

    if (btnEnableAlerts) {
      btnEnableAlerts.onclick = enableAlerts;
    }

    var searchDebounceTimer = null;
    filterSearch.oninput = function () {
      state.searchQuery = filterSearch.value;
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        if (typeof window !== "undefined") {
          window.__copilotSearchDebounceTimer = null;
          window.__copilotSearchTimer = null;
        }
      }
      searchDebounceTimer = setTimeout(function () {
        searchDebounceTimer = null;
        if (typeof window !== "undefined") {
          window.__copilotSearchDebounceTimer = null;
          window.__copilotSearchTimer = null;
        }
        (typeof window !== "undefined" && window.renderBoardTable ? window.renderBoardTable : renderBoardTable)();
      }, 120);
      if (typeof window !== "undefined") {
        window.__copilotSearchDebounceTimer = searchDebounceTimer;
        window.__copilotSearchTimer = searchDebounceTimer;
      }
    };

    toggleHideDrafted.onchange = function () {
      state.hideDrafted = toggleHideDrafted.checked;
      renderBoardTable();
    };

    var chips = document.querySelectorAll(".filter-chip");
    chips.forEach(function (chip) {
      chip.onclick = function () {
        chips.forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        state.posFilter = chip.getAttribute("data-pos");
        renderBoardTable();
      };
    });

    cmpSelectA.onchange = function () {
      state.autoComparator = false;
      updateAutoComparatorBtn();
      calculateTradeoff();
    };
    cmpSelectB.onchange = function () {
      state.autoComparator = false;
      updateAutoComparatorBtn();
      calculateTradeoff();
    };

    if (btnAutoMatchup) {
      btnAutoMatchup.onclick = function () {
        state.autoComparator = !state.autoComparator;
        renderComparatorOptions();
      };
    }

    // Guide modal controls
    var guideModal = document.getElementById("guide-modal");
    var btnOpenGuide = document.getElementById("btn-open-guide");
    if (btnOpenGuide && guideModal) {
      btnOpenGuide.onclick = function () {
        guideModal.style.display = "flex";
      };
      document.getElementById("btn-close-guide-modal").onclick = function () {
        guideModal.style.display = "none";
      };
      document.getElementById("btn-guide-modal-close").onclick = function () {
        guideModal.style.display = "none";
      };
    }

    // Report modal controls
    var reportModal = document.getElementById("report-modal");
    var btnOpenReport = document.getElementById("btn-open-report");
    if (btnOpenReport && reportModal) {
      btnOpenReport.onclick = function () {
        reportModal.style.display = "flex";
        fetchAndRenderReport();
      };
      document.getElementById("btn-close-report-modal").onclick = function () {
        reportModal.style.display = "none";
      };
      document.getElementById("btn-report-modal-close").onclick = function () {
        reportModal.style.display = "none";
      };
    }

    // Monte Carlo simulation modal controls
    var btnOpenMonteCarlo = document.getElementById("btn-open-montecarlo");
    if (btnOpenMonteCarlo && mcModal) {
      btnOpenMonteCarlo.onclick = openMonteCarloModal;
      document.getElementById("btn-close-montecarlo-modal").onclick = function () {
        mcModal.style.display = "none";
      };
      document.getElementById("btn-montecarlo-modal-close").onclick = function () {
        mcModal.style.display = "none";
      };
      if (btnRunMonteCarlo) btnRunMonteCarlo.onclick = runMonteCarloSimulation;
      if (mcSimulationsInput) {
        mcSimulationsInput.oninput = function () {
          if (mcSimLabel) mcSimLabel.textContent = parseInt(mcSimulationsInput.value, 10) || 500;
        };
      }
    }

    var modal = document.getElementById("sync-modal");
    document.getElementById("btn-open-sync").onclick = function () {
      modal.style.display = "flex";
    };
    document.getElementById("btn-close-sync-modal").onclick = function () {
      modal.style.display = "none";
    };
    document.getElementById("btn-modal-done").onclick = function () {
      modal.style.display = "none";
    };

    window.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
        if (e.key === "Escape") {
          e.target.blur();
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        filterSearch.focus();
      } else if (e.key === "u" || (e.metaKey && e.key === "z")) {
        e.preventDefault();
        undoLastPick();
      }
    });
  }

  function setupBookmarklet() {
    var link = document.getElementById("bookmarklet-link");
    if (!link) return;
    return fetch("/js/bookmarklet.js")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (source) {
        link.href = "javascript:" + encodeURIComponent(source);
      })
      .catch(function () {
        link.removeAttribute("href");
        link.textContent = "Bookmarklet unavailable";
        link.style.pointerEvents = "none";
        link.style.opacity = "0.5";
      });
  }

  init();
})();
