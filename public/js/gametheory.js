/**
 * Game Theory Decision Engine for Fantasy Hockey Drafts
 * 
 * Implements:
 * 1. Abramowitz & Stegun normal CDF for survival probability P(Survives)
 * 2. Snake draft schedule turn calculation
 * 3. Dynamic positional diminishing returns (Adj_VORP)
 * 4. Step-by-Step Decision Protocol on the Clock (MUST REACH > NOW OR NEVER > TARGET)
 * 5. Head-to-head Game Theory Trade-off Comparator (VONA / EVONA)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameTheory = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Standard normal cumulative distribution function (CDF)
   * Uses Abramowitz and Stegun approximation formula 7.1.26 (error < 1.5e-7)
   */
  function normalCDF(x, mean, std) {
    if (!std || std <= 0) std = 7.0;
    if (x === null || x === undefined || isNaN(x)) return 0.5;
    var z = (x - mean) / std;
    var absZ = Math.abs(z);
    var t = 1.0 / (1.0 + 0.2316419 * absZ);
    var zPdf = (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * absZ * absZ);
    var tail = zPdf * (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
    var cdf = z >= 0 ? (1.0 - tail) : tail;
    return Math.max(0, Math.min(1, cdf));
  }

  /**
   * Survival Probability: probability that a player with given ADP
   * remains undrafted by opponents before targetPick.
   * P(Survive) = 1 - NORM.DIST(targetPick, ADP, std, TRUE)
   */
  function pSurvive(targetPick, adp, std) {
    if (!adp || isNaN(adp)) return 0.5;
    std = std || 7.0;
    var cdf = normalCDF(targetPick, adp, std);
    return Math.max(0, Math.min(1, 1.0 - cdf));
  }

  /**
   * Snake Draft Turn Schedule Calculator
   * Returns the exact upcoming overall pick number for slot S in an N-team draft.
   */
  function getNextSnakePick(currentPick, slot, teams) {
    slot = parseInt(slot, 10) || 1;
    teams = parseInt(teams, 10) || 8;
    currentPick = parseInt(currentPick, 10) || 1;

    var rnd = Math.floor((currentPick - 1) / teams) + 1;
    var isOddRnd = (rnd % 2) === 1;
    var pickInCurRnd = (rnd - 1) * teams + (isOddRnd ? slot : teams - slot + 1);

    if (currentPick < pickInCurRnd) {
      return pickInCurRnd;
    }
    var nextRnd = rnd + 1;
    var isOddNext = (nextRnd % 2) === 1;
    return rnd * teams + (isOddNext ? slot : teams - slot + 1);
  }

  /**
   * Returns { round, pickInRound, ownerSlot } for any overall pick
   */
  function getPickDetails(overallPick, teams) {
    teams = parseInt(teams, 10) || 8;
    var round = Math.floor((overallPick - 1) / teams) + 1;
    var pickInRound = ((overallPick - 1) % teams) + 1;
    var isOdd = (round % 2) === 1;
    var ownerSlot = isOdd ? pickInRound : (teams - pickInRound + 1);
    return {
      round: round,
      pickInRound: pickInRound,
      ownerSlot: ownerSlot
    };
  }

  /**
   * Check if the current pick belongs to the user
   */
  function isMyTurn(currentPick, slot, teams) {
    var details = getPickDetails(currentPick, teams);
    return details.ownerSlot === parseInt(slot, 10);
  }

  /**
   * Positional Cliff Alert classification
   */
  function getCliffAlert(dropoff) {
    if (dropoff === null || dropoff === undefined || isNaN(dropoff)) return "Flat";
    if (dropoff >= 20) return "CRITICAL CLIFF";
    if (dropoff >= 10) return "Tier Drop";
    return "Flat";
  }

  /**
   * Positional Diminishing Returns Multiplier
   * Dampens VORP by 35% (multiplier 0.65) once starting capacity is met.
   */
  function getDiminishingMultiplier(positions, myRosterCounts, limits) {
    limits = limits || { C: 4, LW: 4, RW: 4, D: 4, G: 2 };
    if (!positions || !positions.length) return 1.0;

    // If all eligible positions for this player are at/exceed capacity, damp utility
    var allCapped = true;
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var count = (myRosterCounts && myRosterCounts[p]) || 0;
      var limit = limits[p] || 4;
      if (count < limit) {
        allCapped = false;
        break;
      }
    }
    return allCapped ? 0.65 : 1.0;
  }

  /**
   * Dynamic Game-Theory Action Flag classification
   */
  function classifyAction(isDrafted, isMine, survivalOdds, dropoff) {
    if (isMine) return "MY TEAM";
    if (isDrafted) return "DRAFTED";
    if (survivalOdds > 0.75) return "WAIT (ADP Safe)";
    if (survivalOdds < 0.35 && (dropoff >= 15 || dropoff >= 20)) return "MUST REACH (Cliff)";
    if (survivalOdds < 0.20) return "NOW OR NEVER";
    return "TARGET";
  }

  /**
   * Step-by-Step Decision Protocol on the Clock
   * Analyzes all undrafted players and produces:
   * 1. Red Alert Callout (MUST REACH cliff players)
   * 2. Filtered NOW OR NEVER / TARGET recommendations
   * 3. Clear callout of WAIT (ADP Safe) players to ignore
   * 4. Ranked Short List sorted by Adj_VORP tiebroken by Next cliff
   */
  function evaluateBoard(rows, options) {
    var currentPick = options.currentPick || 1;
    var slot = options.slot || 5;
    var teams = options.teams || 8;
    var stdDev = options.stdDev || 7.0;
    var draftedSet = options.drafted || {};
    var mineSet = options.mine || {};
    var rosterCounts = options.rosterCounts || { C: 0, LW: 0, RW: 0, D: 0, G: 0 };
    var rosterLimits = options.rosterLimits || { C: 4, LW: 4, RW: 4, D: 4, G: 2 };

    var onTheClock = isMyTurn(currentPick, slot, teams);
    
    // If we are currently ON THE CLOCK, survival is evaluated against our NEXT pick in the draft.
    // If we are WAITING, survival is evaluated against our UPCOMING turn.
    var targetTurn = onTheClock 
      ? getNextSnakePick(currentPick + 1, slot, teams)
      : getNextSnakePick(currentPick, slot, teams);

    var picksUntilTurn = onTheClock ? 0 : Math.max(0, targetTurn - currentPick);

    var evaluatedRows = [];
    var availableRows = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = r.name;
      var isMine = !!mineSet[name];
      var isDrafted = isMine || !!draftedSet[name];

      var adpVal = (r.adp && typeof r.adp === "object") ? (r.adp.yahoo || r.adp.average || r.adp.fantrax) : r.adp;
      var adpNum = parseFloat(adpVal) || 999;
      
      var surv = isDrafted ? 0 : pSurvive(targetTurn, adpNum, stdDev);
      var drop = (r.dropoff !== undefined && r.dropoff !== null) ? r.dropoff : 0;
      var mult = getDiminishingMultiplier(r.pos, rosterCounts, rosterLimits);
      var rawVorp = (r.vorp !== undefined && r.vorp !== null) ? r.vorp : 0;
      var adjVorp = rawVorp * mult;
      var cliff = getCliffAlert(drop);
      var action = classifyAction(isDrafted, isMine, surv, drop);
      var adpDelta = (adpNum < 900 && r.rank) ? (adpNum - r.rank) : 0;

      var evalRow = {
        id: r.id,
        name: r.name,
        team: r.team,
        pos: r.pos,
        posLabel: r.posLabel || (r.pos ? r.pos.join("/") : ""),
        age: r.age,
        adp: adpNum < 900 ? adpNum : null,
        adpDelta: adpDelta,
        rawVorp: rawVorp,
        adjVorp: adjVorp,
        dropoff: drop,
        cliffAlert: cliff,
        survivalProb: surv,
        action: action,
        isDrafted: isDrafted,
        isMine: isMine,
        tier: r.tier || 1,
        rank: r.rank,
        isDiminished: mult < 1.0
      };

      evaluatedRows.push(evalRow);
      if (!isDrafted) {
        availableRows.push(evalRow);
      }
    }

    // Step 1: Identify Red Alert Players (MUST REACH (Cliff))
    var redAlerts = availableRows.filter(function (p) {
      return p.action === "MUST REACH (Cliff)" && !p.isDiminished;
    });

    // Step 2: Now or Never & Targets vs Wait (ADP Safe)
    var waitSafePlayers = availableRows.filter(function (p) {
      return p.action === "WAIT (ADP Safe)" && p.adjVorp >= 15;
    }).sort(function (a, b) {
      return b.adjVorp - a.adjVorp;
    });

    var nowOrNeverPlayers = availableRows.filter(function (p) {
      return p.action === "NOW OR NEVER";
    });

    var targetPlayers = availableRows.filter(function (p) {
      return p.action === "TARGET";
    });

    // Step 3: Rank Shortlist according to Decision Protocol
    // Priority:
    // 1. MUST REACH (Cliff)
    // 2. NOW OR NEVER (urgent picks about to disappear)
    // 3. High Adj_VORP TARGETS
    // Tiebreaker: If Adj_VORP within 2.0, break by higher Next dropoff cliff!
    var shortlistCandidates = availableRows.filter(function (p) {
      return p.action !== "WAIT (ADP Safe)";
    });

    shortlistCandidates.sort(function (a, b) {
      // Must reach gets top priority
      if (a.action === "MUST REACH (Cliff)" && b.action !== "MUST REACH (Cliff)") return -1;
      if (b.action === "MUST REACH (Cliff)" && a.action !== "MUST REACH (Cliff)") return 1;

      // Between Now or Never and Target: prioritize Now or Never if Vorp is comparable
      if (a.action === "NOW OR NEVER" && b.action === "TARGET" && (a.adjVorp >= b.adjVorp - 4.0)) return -1;
      if (b.action === "NOW OR NEVER" && a.action === "TARGET" && (b.adjVorp >= a.adjVorp - 4.0)) return 1;

      // Close VORP tiebreaking by Next dropoff cliff
      var vorpDiff = Math.abs(a.adjVorp - b.adjVorp);
      if (vorpDiff <= 2.0) {
        return b.dropoff - a.dropoff;
      }
      return b.adjVorp - a.adjVorp;
    });

    // Top 8 shortlist
    var shortlist = shortlistCandidates.slice(0, 8);

    // Live Directions & Banner Message Construction
    var liveProtocol = {
      step: 1,
      alertType: "info", // "critical", "warning", "turn", "waiting"
      headline: "",
      subtext: "",
      bestPick: shortlist[0] || null,
      onTheClock: onTheClock,
      currentPick: currentPick,
      targetTurn: targetTurn,
      picksUntilTurn: picksUntilTurn
    };

    if (onTheClock) {
      if (redAlerts.length > 0) {
        liveProtocol.alertType = "critical";
        liveProtocol.step = 1;
        liveProtocol.headline = "🚨 CRITICAL CLIFF DETECTED: MUST REACH NOW";
        liveProtocol.subtext = "Pass at your peril! " + redAlerts[0].name + " (" + redAlerts[0].posLabel + ") sits atop a +" +
          redAlerts[0].dropoff.toFixed(1) + " VORP cliff with only " + (redAlerts[0].survivalProb * 100).toFixed(0) +
          "% odds to reach your next pick (#" + targetTurn + "). Draft them immediately.";
      } else if (shortlist.length > 0 && shortlist[0].action === "NOW OR NEVER") {
        liveProtocol.alertType = "warning";
        liveProtocol.step = 2;
        liveProtocol.headline = "⚡ ON THE CLOCK: IMMINENT TARGET DISAPPEARING";
        liveProtocol.subtext = shortlist[0].name + " (" + shortlist[0].posLabel + ") has <20% survival to pick #" +
          targetTurn + " and high Adj VORP (" + shortlist[0].adjVorp.toFixed(1) + "). Lock in before opponents strike.";
      } else if (shortlist.length > 0) {
        liveProtocol.alertType = "turn";
        liveProtocol.step = 3;
        liveProtocol.headline = "🎯 ON THE CLOCK: TAKE BEST ADJUSTED VALUE";
        liveProtocol.subtext = "Top recommendation: " + shortlist[0].name + " (" + shortlist[0].posLabel + ", Adj VORP " +
          shortlist[0].adjVorp.toFixed(1) + ", Cliff +" + shortlist[0].dropoff.toFixed(1) + "). Safe sleepers like " +
          (waitSafePlayers[0] ? waitSafePlayers[0].name : "late ADPs") + " will fall back to you.";
      }
    } else {
      liveProtocol.alertType = "waiting";
      liveProtocol.headline = "⏱️ Drafting in " + picksUntilTurn + " picks (Turn #" + targetTurn + ")";
      if (redAlerts.length > 0) {
        liveProtocol.subtext = "Tracking Red Alert: " + redAlerts[0].name + " (" + (redAlerts[0].survivalProb * 100).toFixed(0) +
          "% survival). Prepare to draft if opponents pass.";
      } else if (shortlist.length > 0) {
        liveProtocol.subtext = "Current top target queue: " + shortlist[0].name + " (" + shortlist[0].posLabel + ") and " +
          (shortlist[1] ? shortlist[1].name : "next best");
      }
    }

    return {
      allRows: evaluatedRows,
      availableRows: availableRows,
      shortlist: shortlist,
      redAlerts: redAlerts,
      waitSafePlayers: waitSafePlayers.slice(0, 5),
      liveProtocol: liveProtocol,
      onTheClock: onTheClock,
      targetTurn: targetTurn,
      currentPick: currentPick,
      picksUntilTurn: picksUntilTurn
    };
  }

  /**
   * Head-to-Head Game Theory Trade-off Comparator
   * Let Player A be high-VORP sleeper with later ADP.
   * Let Player B be consensus pick with lower VORP but imminent ADP.
   * Decision Rule: Wait on A iff P(A) > (Loss_B) / (Loss_A)
   */
  function comparePlayersGameTheory(playerA, playerB, nextAltA, nextAltB, targetTurn, stdDev) {
    if (!playerA || !playerB) return null;
    stdDev = stdDev || 7.0;

    var vorpA = playerA.adjVorp || playerA.rawVorp || 0;
    var vorpB = playerB.adjVorp || playerB.rawVorp || 0;
    
    var altVorpA = nextAltA ? (nextAltA.adjVorp || nextAltA.rawVorp || 0) : (vorpA - (playerA.dropoff || 10));
    var altVorpB = nextAltB ? (nextAltB.adjVorp || nextAltB.rawVorp || 0) : (vorpB - (playerB.dropoff || 10));

    var lossA = Math.max(0.1, vorpA - altVorpA);
    var lossB = Math.max(0.1, vorpB - altVorpB);

    var adpA = playerA.adp || 100;
    var pA = pSurvive(targetTurn, adpA, stdDev);

    var threshold = lossB / lossA;

    // Option 1: Take B now, gamble on A
    // EV = VORP(B) + P(A)*VORP(A) + (1-P(A))*VORP(A')
    var evOption1 = vorpB + (pA * vorpA) + ((1.0 - pA) * altVorpA);

    // Option 2: Take A now, lock in value, settle for B' next round
    // EV = VORP(A) + VORP(B')
    var evOption2 = vorpA + altVorpB;

    var deltaEV = evOption1 - evOption2;
    var waitOnA = pA > threshold;

    var verdict = waitOnA
      ? "EXPLOIT MARKET: Take " + playerB.name + " now. Wait on " + playerA.name + " (Survival: " + (pA * 100).toFixed(0) + "% > threshold " + (threshold * 100).toFixed(0) + "%)."
      : "LOCK IN VALUE: Draft " + playerA.name + " now. Do not gamble on ADP (Survival " + (pA * 100).toFixed(0) + "% <= threshold " + (threshold * 100).toFixed(0) + "%).";

    return {
      playerA: playerA,
      playerB: playerB,
      lossA: lossA,
      lossB: lossB,
      pSurviveA: pA,
      threshold: threshold,
      evOption1: evOption1,
      evOption2: evOption2,
      deltaEV: deltaEV,
      waitOnA: waitOnA,
      verdict: verdict
    };
  }

  return {
    normalCDF: normalCDF,
    pSurvive: pSurvive,
    getNextSnakePick: getNextSnakePick,
    getPickDetails: getPickDetails,
    isMyTurn: isMyTurn,
    getCliffAlert: getCliffAlert,
    getDiminishingMultiplier: getDiminishingMultiplier,
    classifyAction: classifyAction,
    evaluateBoard: evaluateBoard,
    comparePlayersGameTheory: comparePlayersGameTheory
  };
});
