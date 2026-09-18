(function () {
  "use strict";

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
    // UI filters:
    posFilter: "ALL",
    searchQuery: "",
    hideDrafted: false
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

  async function init() {
    setupBookmarklet();
    setupEventListeners();
    setupWebSocket();

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
        if (msg.state) {
          applyServerState(msg.state);
          recomputeAndRender();
        }
      } catch (e) {
        console.error("WS message parse error:", e);
      }
    };
  }

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

    selectSlot.value = state.slot;
    selectTeams.value = state.teams;
    dispCurrentPick.textContent = state.currentPick;
  }

  function getRosterCounts() {
    var counts = { C: 0, F: 0, D: 0, G: 0, total: 0 };
    var limits = state.rosterLimits || { C: 3, F: 5, D: 4, G: 2 };
    for (var i = 0; i < state.pickHistory.length; i++) {
      var item = state.pickHistory[i];
      if (item.isMine) {
        counts.total++;
        var positions = item.pos || [];
        // If pure C:
        if (positions.length === 1 && positions[0] === 'C') {
          if (counts.C < (limits.C || 3)) counts.C++;
          else counts.F++; // flex to Forward if C starting slots full
        } else if (positions.indexOf('C') !== -1 && positions.indexOf('F') !== -1) {
          // Dual C/F: fill C if open, else F
          if (counts.C < (limits.C || 3)) counts.C++;
          else counts.F++;
        } else {
          for (var p = 0; p < positions.length; p++) {
            var posKey = positions[p];
            if (counts[posKey] !== undefined) {
              counts[posKey]++;
            }
          }
        }
      }
    }
    return counts;
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
    renderShortlist();
    renderComparatorOptions();
    renderSafeSleepers();
    renderBoardTable();
    renderSidebar(rosterCounts);
  }

  function renderHeader() {
    dispCurrentPick.textContent = state.currentPick;
    var res = state.evalResult;
    var onTheClock = res.onTheClock;

    if (onTheClock) {
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

  function renderShortlist() {
    var list = state.evalResult.shortlist;
    shortlistContainer.innerHTML = "";
    document.getElementById("shortlist-count").textContent = list.length + " ranked options";

    if (!list.length) {
      shortlistContainer.innerHTML = "<div style='color:var(--text-muted); font-size:12px; padding:8px;'>All top targets drafted.</div>";
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

      card.innerHTML = `
        <div class="card-rank">#${i + 1}</div>
        <div class="card-info">
          <div class="card-name-row">
            <span class="card-name">${p.name}</span>
            <span class="card-pos">${p.posLabel}</span>
            <span class="card-team">${p.team}</span>
            <span class="badge ${badgeClass}">${p.action}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-dim);">
            ADP: <b>${p.adp || 'N/A'}</b> · Dynamic Cliff: <b style="color:${p.dropoff >= 15 ? 'var(--red)' : 'var(--text-main)'}">${cliffText}</b>
          </div>
        </div>
        <div class="card-metrics">
          <div class="card-metric">
            <span style="font-weight:700; color:var(--accent);">${p.adjVorp.toFixed(1)}</span>
            <span class="metric-label">Adj VORP</span>
          </div>
          <div class="card-metric">
            <span style="font-weight:700; color:${p.survivalProb < 0.2 ? 'var(--orange)' : 'var(--green)'};">${survPct}</span>
            <span class="metric-label">P(Surv)</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-card-draft" data-id="${p.id}" title="Draft to My Team">+ Mine</button>
          <button class="btn-card-taken" data-id="${p.id}" title="Taken by Opponent">Taken</button>
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
      optA.textContent = p.name + " (" + p.posLabel + ", ADP " + (p.adp || "N/A") + ")";
      cmpSelectA.appendChild(optA);

      var optB = document.createElement("option");
      optB.value = p.name;
      optB.textContent = p.name + " (" + p.posLabel + ", ADP " + (p.adp || "N/A") + ")";
      cmpSelectB.appendChild(optB);
    }

    if (curValA) cmpSelectA.value = curValA;
    if (curValB) cmpSelectB.value = curValB;
    calculateTradeoff();
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
    var cmp = GameTheory.comparePlayersGameTheory(rowA, rowB, null, null, targetTurn, state.stdDev);
    if (!cmp) return;

    var color = cmp.waitOnA ? "var(--green)" : "var(--orange)";
    cmpVerdict.innerHTML = `
      <div style="font-weight:700; color:${color}; margin-bottom:4px;">${cmp.verdict}</div>
      <div style="color:var(--text-dim); font-size:10px; font-family:var(--font-mono);">
        Option 1 (Take ${rowB.name}, gamble on ${rowA.name}): EV = ${cmp.evOption1.toFixed(1)}<br>
        Option 2 (Take ${rowA.name} now, gamble on ${rowB.name}): EV = ${cmp.evOption2.toFixed(1)} (ΔEV: ${cmp.deltaEV > 0 ? '+' : ''}${cmp.deltaEV.toFixed(1)})
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
        <span>${p.name} (${p.posLabel})</span>
        <span style="font-family:var(--font-mono); font-weight:bold;">${survPct}</span>
      `;
      pill.title = "ADP: " + (p.adp || "N/A") + " | VORP: " + p.adjVorp.toFixed(1) + " | Will safely survive to turn!";
      safeSleepersContainer.appendChild(pill);
    }
  }

  function renderBoardTable() {
    var rows = state.evalResult.allRows;
    tableTbody.innerHTML = "";

    var filter = state.posFilter;
    var q = state.searchQuery.toLowerCase().trim();
    var hideDrafted = state.hideDrafted;

    var displayedCount = 0;

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

      var badgeClass = "badge-target";
      if (p.isMine) badgeClass = "badge-myteam";
      else if (p.isDrafted) badgeClass = "badge-drafted";
      else if (p.action === "MUST REACH (Cliff)") badgeClass = "badge-must-reach";
      else if (p.action === "NOW OR NEVER") badgeClass = "badge-now-or-never";
      else if (p.action === "WAIT (ADP Safe)") badgeClass = "badge-wait";

      var survText = p.isDrafted ? "-" : (p.survivalProb * 100).toFixed(0) + "%";
      var cliffText = p.dropoff > 0 ? "+" + p.dropoff.toFixed(1) : "-";
      var deltaText = p.adpDelta > 0 ? "+" + p.adpDelta.toFixed(1) : (p.adpDelta < 0 ? p.adpDelta.toFixed(1) : "-");

      var fpVal = p.fp ? p.fp.toFixed(1) : "-";

      tr.innerHTML = `
        <td style="color:var(--text-dim);">${p.rank || (i + 1)}</td>
        <td style="font-weight:600;">
          ${p.name} <span style="font-size:11px; color:var(--text-muted); font-weight:normal;">${p.team}</span>
        </td>
        <td><span class="card-pos">${p.posLabel}</span></td>
        <td><span class="badge ${badgeClass}">${p.action}</span></td>
        <td class="num" style="color:${p.survivalProb < 0.2 ? 'var(--orange)' : 'var(--green)'};">${survText}</td>
        <td class="num" style="font-weight:700; color:var(--accent);">${p.adjVorp.toFixed(1)}</td>
        <td class="num">${p.rawVorp.toFixed(1)}</td>
        <td class="num" style="color:${p.dropoff >= 15 ? 'var(--red)' : 'var(--text-main)'}; font-weight:${p.dropoff >= 15 ? 'bold' : 'normal'};">${cliffText}</td>
        <td class="num">${p.adp ? p.adp.toFixed(1) : '-'}</td>
        <td class="num" style="color:${p.adpDelta >= 20 ? 'var(--green)' : 'var(--text-muted)'};">${deltaText}</td>
        <td class="num" style="color:var(--text-dim);">${fpVal}</td>
        <td style="text-align:center;">
          ${!p.isDrafted ? `
            <button class="btn-icon btn-tbl-mine" title="Draft to My Team" style="display:inline-flex; width:26px; color:#7ee787;">+</button>
            <button class="btn-icon btn-tbl-draft" title="Drafted by Opponent" style="display:inline-flex; width:26px; color:var(--text-muted);">✓</button>
          ` : `<span style="font-size:10px; color:var(--text-dim);">${p.isMine ? 'MY TEAM' : 'TAKEN'}</span>`}
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

      tableTbody.appendChild(tr);
    }

    playerCountDisplay.textContent = displayedCount + " shown (" + rows.length + " total)";
  }

  function renderSidebar(rosterCounts) {
    var limits = state.rosterLimits;
    var posList = ["c", "f", "d", "g"];
    var totalDrafted = 0;
    var totalVorp = 0;

    for (var i = 0; i < posList.length; i++) {
      var p = posList[i];
      var upper = p.toUpperCase();
      var count = rosterCounts[upper] || 0;
      var limit = limits[upper] || 4;
      var card = document.getElementById("card-pos-" + p);
      var countSpan = document.getElementById("count-" + p);
      var warnDiv = document.getElementById("warn-" + p);

      countSpan.textContent = count + " / " + limit;

      if (count >= limit) {
        card.classList.add("capped");
        warnDiv.textContent = "⚠️ Capped (-15% to -35% VORP)";
      } else {
        card.classList.remove("capped");
        warnDiv.textContent = "";
      }
    }

    // Total VORP captured by my team
    for (var j = 0; j < state.pickHistory.length; j++) {
      var pick = state.pickHistory[j];
      if (pick.isMine) {
        totalDrafted++;
        var match = state.evalResult.allRows.find(x => x.name === pick.name);
        if (match) {
          totalVorp += match.rawVorp;
        }
      }
    }

    document.getElementById("roster-total-count").textContent = totalDrafted + " / 18";
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
          <span style="font-weight:600;">${item.name}</span>
          <span style="font-size:10px; color:var(--text-dim); margin-left:4px;">${item.isMine ? '(ME)' : ''}</span>
        </div>
      `;
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
        isMine: isMine
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

    filterSearch.oninput = function () {
      state.searchQuery = filterSearch.value;
      renderBoardTable();
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

    cmpSelectA.onchange = calculateTradeoff;
    cmpSelectB.onchange = calculateTradeoff;

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
    var bmCode = `javascript:(function(){const u='http://localhost:3333/api/pick';const s=new Set();function n(p,m){if(!p||s.has(p))return;s.add(p);fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:p,isMine:m})}).catch(e=>console.error(e));}function c(){document.querySelectorAll('.draft-results-table tr,#draft-tables tbody tr,.Grid-table tr').forEach(r=>{const el=r.querySelector('.name,.player,[data-tst="player-name"],a.F-link');if(el)n(el.textContent.trim(),r.classList.contains('my-team')||r.classList.contains('user-pick'));});}c();setInterval(c,1500);alert('🏒 Yahoo Draft Live Sync Activated!');})();`;
    var link = document.getElementById("bookmarklet-link");
    if (link) link.href = bmCode;
  }

  init();
})();
