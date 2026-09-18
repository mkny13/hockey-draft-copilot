/**
 * Game Theory Decision Engine for Fantasy Hockey Drafts (Enhanced VONA/EVONA)
 * 
 * Key mathematical enhancements:
 * 1. High-precision normal CDF (Abramowitz & Stegun 7.1.26) for survival odds P(Survives).
 * 2. Dynamic Positional Cliffs: computes live drop-off to the next available undrafted player.
 * 3. Multi-position eligibility optionality: avoids penalizing dual-eligible players if one position is open.
 * 4. Graded diminishing returns curve (Starters 100%, Primary Bench 85%, Deep Bench 65%).
 * 5. Generalized EVONA Trade-off Comparator: fully accounts for mutual survival odds and intra-position matchups without divide-by-zero errors.
 * 6. Continuous Urgency Scoring to break ties cleanly.
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
   * Abramowitz & Stegun formula 7.1.26 (error < 1.5e-7)
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
   * Survival Probability to target turn:
   * P(Survive) = 1 - NORM.DIST(targetTurn, ADP, std, TRUE)
   */
  function pSurvive(targetPick, adp, std) {
    if (!adp || isNaN(adp)) return 0.5;
    std = std || 7.0;
    var cdf = normalCDF(targetPick, adp, std);
    return Math.max(0, Math.min(1, 1.0 - cdf));
  }

  /**
   * Snake Draft Turn Schedule Calculator
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

  function isMyTurn(currentPick, slot, teams) {
    var details = getPickDetails(currentPick, teams);
    return details.ownerSlot === parseInt(slot, 10);
  }

  function getCliffAlert(dropoff) {
    if (dropoff === null || dropoff === undefined || isNaN(dropoff)) return "Flat";
    if (dropoff >= 20) return "CRITICAL CLIFF";
    if (dropoff >= 10) return "Tier Drop";
    return "Flat";
  }

  /**
   * Graded Positional Diminishing Returns Curve
   * - Under starter limit: 1.0 (100% utility)
   * - At starter limit (1st bench): 0.85
   * - 1 over limit (2nd bench): 0.65
   * - 2+ over limit (excess): 0.35
   * Multi-position players use the most favorable open slot.
   */
  function getDiminishingMultiplier(positions, myRosterCounts, limits) {
    limits = limits || { C: 3, F: 5, D: 4, G: 2 };
    if (!positions || !positions.length) return 1.0;

    var bestMultiplier = 0.0;
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var count = (myRosterCounts && myRosterCounts[p]) || 0;
      var limit = limits[p] || 4;

      var mult = 1.0;
      if (count < limit) {
        mult = 1.0;
      } else if (count === limit) {
        mult = 0.85;
      } else if (count === limit + 1) {
        mult = 0.65;
      } else {
        mult = 0.35;
      }

      if (mult > bestMultiplier) {
        bestMultiplier = mult;
      }
    }
    return bestMultiplier > 0 ? bestMultiplier : 1.0;
  }

  function classifyAction(isDrafted, isMine, survivalOdds, dropoff) {
    if (isMine) return "MY TEAM";
    if (isDrafted) return "DRAFTED";
    if (survivalOdds > 0.75) return "WAIT (ADP Safe)";
    if (survivalOdds < 0.35 && dropoff >= 15) return "MUST REACH (Cliff)";
    if (survivalOdds < 0.20) return "NOW OR NEVER";
    return "TARGET";
  }

  /**
   * Calculate Dynamic Positional Cliffs among currently available undrafted players
   */
  function computeDynamicCliffs(availablePlayers) {
    var posMap = {};
    for (var i = 0; i < availablePlayers.length; i++) {
      var p = availablePlayers[i];
      var vorp = p.rawVorp || p.vorp || 0;
      var positions = p.pos || [];
      for (var j = 0; j < positions.length; j++) {
        var pos = positions[j];
        if (!posMap[pos]) posMap[pos] = [];
        posMap[pos].push({ id: p.id, name: p.name, vorp: vorp });
      }
    }

    for (var k in posMap) {
      posMap[k].sort(function (a, b) { return b.vorp - a.vorp; });
    }

    var dynamicCliffMap = {};
    for (var m = 0; m < availablePlayers.length; m++) {
      var pl = availablePlayers[m];
      var plVorp = pl.rawVorp || pl.vorp || 0;
      var plPos = pl.pos || [];

      var maxCliff = 0;
      for (var n = 0; n < plPos.length; n++) {
        var list = posMap[plPos[n]] || [];
        var myIdx = -1;
        for (var l = 0; l < list.length; l++) {
          if (list[l].name === pl.name) {
            myIdx = l;
            break;
          }
        }

        if (myIdx !== -1) {
          var nextPl = list[myIdx + 1];
          var directDrop = nextPl ? (plVorp - nextPl.vorp) : plVorp;
          var tierDrop = directDrop;
          if (nextPl && directDrop < 15 && (myIdx + 2 < list.length)) {
            var tierNext = list[myIdx + 2];
            var nextDrop = nextPl.vorp - tierNext.vorp;
            if (nextDrop >= 15) {
              tierDrop = plVorp - tierNext.vorp;
            }
          }
          var effectiveCliff = Math.max(directDrop, tierDrop);
          if (effectiveCliff > maxCliff) maxCliff = effectiveCliff;
        }
      }
      dynamicCliffMap[pl.name] = maxCliff > 0 ? maxCliff : (pl.dropoff || 0);
    }
    return dynamicCliffMap;
  }

  /**
   * Step-by-Step Decision Protocol on the Clock
   */
  function evaluateBoard(rows, options) {
    var currentPick = options.currentPick || 1;
    var slot = options.slot || 5;
    var teams = options.teams || 8;
    var stdDev = options.stdDev || 7.0;
    var draftedSet = options.drafted || {};
    var mineSet = options.mine || {};
    var rosterCounts = options.rosterCounts || { C: 0, LW: 0, RW: 0, D: 0, G: 0 };
    var rosterLimits = options.rosterLimits || { C: 3, F: 5, D: 4, G: 2 };

    var onTheClock = isMyTurn(currentPick, slot, teams);
    var targetTurn = onTheClock
      ? getNextSnakePick(currentPick + 1, slot, teams)
      : getNextSnakePick(currentPick, slot, teams);

    var picksUntilTurn = onTheClock ? 0 : Math.max(0, targetTurn - currentPick);

    // Initial pass: identify available players for dynamic cliff calculation
    var rawAvailable = [];
    for (var rIdx = 0; rIdx < rows.length; rIdx++) {
      var rowItem = rows[rIdx];
      var pName = rowItem.name || rowItem.n;
      if (!mineSet[pName] && !draftedSet[pName]) {
        rawAvailable.push({
          id: rowItem.id !== undefined ? rowItem.id : rIdx,
          name: pName,
          pos: rowItem.pos || rowItem.p || [],
          rawVorp: rowItem.vorp !== undefined ? rowItem.vorp : (rowItem.rawVorp || 0),
          dropoff: rowItem.dropoff || 0
        });
      }
    }

    var dynamicCliffs = computeDynamicCliffs(rawAvailable);

    var evaluatedRows = [];
    var availableRows = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = r.name || r.n;
      var isMine = !!mineSet[name];
      var isDrafted = isMine || !!draftedSet[name];

      var adpVal = (r.adp && typeof r.adp === "object")
        ? (r.adp.yahoo || r.adp.average || r.adp.fantrax)
        : r.adp;
      var adpNum = parseFloat(adpVal) || 999;

      var surv = isDrafted ? 0 : pSurvive(targetTurn, adpNum, stdDev);
      var posArray = r.pos || r.p || [];
      var mult = getDiminishingMultiplier(posArray, rosterCounts, rosterLimits);
      var rawVorp = r.vorp !== undefined ? r.vorp : (r.rawVorp || 0);
      var adjVorp = rawVorp * mult;

      // Use dynamic cliff if available, else static dropoff
      var drop = (!isDrafted && dynamicCliffs[name] !== undefined)
        ? dynamicCliffs[name]
        : (r.dropoff !== undefined ? r.dropoff : 0);

      var cliff = getCliffAlert(drop);
      var action = classifyAction(isDrafted, isMine, surv, drop);
      var adpDelta = (adpNum < 900 && r.rank) ? (adpNum - r.rank) : 0;

      // Continuous urgency score: Intrinsic Value * (1 + Urgency) + Cliff * Urgency
      var urgency = 1.0 - surv;
      var urgencyScore = adjVorp * (1.0 + 0.6 * urgency) + (drop * urgency * 0.4);

      var evalRow = {
        id: r.id !== undefined ? r.id : i,
        name: name,
        team: r.team || r.t || "",
        pos: posArray,
        posLabel: r.posLabel || posArray.join("/"),
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
        rank: r.rank || (i + 1),
        isDiminished: mult < 1.0,
        urgencyScore: urgencyScore,
        fp: r.fp || 0,
        fpg: r.fpg || 0
      };

      evaluatedRows.push(evalRow);
      if (!isDrafted) {
        availableRows.push(evalRow);
      }
    }

    // Step 1: Red Alerts (MUST REACH Cliff)
    var redAlerts = availableRows.filter(function (p) {
      return p.action === "MUST REACH (Cliff)" && !p.isDiminished;
    });

    // Step 2: Safe Sleepers
    var waitSafePlayers = availableRows.filter(function (p) {
      return p.action === "WAIT (ADP Safe)" && p.adjVorp >= 15;
    }).sort(function (a, b) {
      return b.adjVorp - a.adjVorp;
    });

    // Step 3: Rank Shortlist according to Decision Protocol
    var shortlistCandidates = availableRows.filter(function (p) {
      return p.action !== "WAIT (ADP Safe)";
    });

    shortlistCandidates.sort(function (a, b) {
      // 1. If VORP difference is significant (>= 4.0 pts), higher VORP strictly dominates:
      var vorpDiff = b.adjVorp - a.adjVorp;
      if (Math.abs(vorpDiff) >= 4.0) {
        return vorpDiff;
      }

      // 2. If VORP is close (within 4 pts):
      // A MUST REACH player takes priority
      if (a.action === "MUST REACH (Cliff)" && b.action !== "MUST REACH (Cliff)") return -1;
      if (b.action === "MUST REACH (Cliff)" && a.action !== "MUST REACH (Cliff)") return 1;

      // 3. Higher urgency (lower survival odds) takes priority
      var survDiff = a.survivalProb - b.survivalProb;
      if (Math.abs(survDiff) > 0.15) {
        return survDiff;
      }

      // 4. Steeper cliff breaks final tie
      var cliffDiff = b.dropoff - a.dropoff;
      if (Math.abs(cliffDiff) >= 2.0) {
        return cliffDiff;
      }

      return vorpDiff;
    });

    var shortlist = shortlistCandidates.slice(0, 8);

    // Live directions
    var liveProtocol = {
      step: 1,
      alertType: "info",
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
        liveProtocol.subtext = redAlerts[0].name + " (" + redAlerts[0].posLabel + ") sits atop a +" +
          redAlerts[0].dropoff.toFixed(1) + " VORP cliff with only " + (redAlerts[0].survivalProb * 100).toFixed(0) +
          "% odds to reach your next pick (#" + targetTurn + "). Passing forfeits irreplaceable value.";
      } else if (shortlist.length > 0 && shortlist[0].action === "NOW OR NEVER") {
        liveProtocol.alertType = "warning";
        liveProtocol.step = 2;
        liveProtocol.headline = "⚡ ON THE CLOCK: IMMINENT TARGET DISAPPEARING";
        liveProtocol.subtext = shortlist[0].name + " (" + shortlist[0].posLabel + ") has <20% survival to pick #" +
          targetTurn + " and high Adj VORP (" + shortlist[0].adjVorp.toFixed(1) + "). Lock in before opponents strike.";
      } else if (shortlist.length > 0) {
        liveProtocol.alertType = "turn";
        liveProtocol.step = 3;
        liveProtocol.headline = "🎯 ON THE CLOCK: TAKE BEST VALUE";
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
        liveProtocol.subtext = "Top target queue: " + shortlist[0].name + " (" + shortlist[0].posLabel + ") and " +
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
   * Generalized EVONA Head-to-Head Trade-Off Evaluator
   * Fully accounts for cross-positional alternatives and dual survival odds:
   * EV(Pick B) = VORP(B) + P(A)*VORP(A) + (1-P(A))*VORP(A')
   * EV(Pick A) = VORP(A) + P(B)*VORP(B) + (1-P(B))*VORP(B')
   */
  function comparePlayersGameTheory(playerA, playerB, nextAltA, nextAltB, targetTurn, stdDev) {
    if (!playerA || !playerB) return null;
    stdDev = stdDev || 7.0;

    var vorpA = playerA.adjVorp || playerA.rawVorp || playerA.vorp || 0;
    var vorpB = playerB.adjVorp || playerB.rawVorp || playerB.vorp || 0;

    var altVorpA = nextAltA
      ? (nextAltA.adjVorp || nextAltA.rawVorp || 0)
      : Math.max(0, vorpA - (playerA.dropoff || 10));

    var altVorpB = nextAltB
      ? (nextAltB.adjVorp || nextAltB.rawVorp || 0)
      : Math.max(0, vorpB - (playerB.dropoff || 10));

    var lossA = Math.max(0.1, vorpA - altVorpA);
    var lossB = Math.max(0.1, vorpB - altVorpB);

    var adpA = playerA.adp || 100;
    var adpB = playerB.adp || 100;

    var pA = pSurvive(targetTurn, adpA, stdDev);
    var pB = pSurvive(targetTurn, adpB, stdDev);

    // Option 1: Pick B now, gamble on A reaching your next turn
    var evOption1 = vorpB + (pA * vorpA) + ((1.0 - pA) * altVorpA);

    // Option 2: Pick A now, gamble on B reaching your next turn (usually pB ~ 0 if imminent)
    var evOption2 = vorpA + (pB * vorpB) + ((1.0 - pB) * altVorpB);

    var deltaEV = evOption1 - evOption2;
    var waitOnA = deltaEV >= 0;

    var threshold = lossA > 0 ? (lossB / lossA) : 1.0;

    var verdict = waitOnA
      ? "EXPLOIT MARKET: Take " + playerB.name + " now. Wait on " + playerA.name + " (ΔEV: +" + deltaEV.toFixed(1) + " pts, " + (pA * 100).toFixed(0) + "% survival)."
      : "LOCK IN VALUE: Draft " + playerA.name + " now. Do not gamble on ADP (ΔEV: +" + Math.abs(deltaEV).toFixed(1) + " pts for Option 2).";

    return {
      playerA: playerA,
      playerB: playerB,
      lossA: lossA,
      lossB: lossB,
      pSurviveA: pA,
      pSurviveB: pB,
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
    computeDynamicCliffs: computeDynamicCliffs,
    evaluateBoard: evaluateBoard,
    comparePlayersGameTheory: comparePlayersGameTheory
  };
});
